import type { ServerEvent, SessionSummary } from '@claudia/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { store, type ClaudiaState } from '../src/store';

/**
 * What the store does with each event the server sends.
 *
 * This file exists because it did not. Seven cases — `session_upsert`,
 * `session_removed`, `settings`, `usage`, `trigger_status`, `notice` and
 * `folders_picked` — were deleted from the store's switch while a mirror
 * reducer was being split out of the same function to get under the size
 * ceiling. Nothing failed. The board silently stopped showing new sessions,
 * removing dead ones, and updating usage, and 140 web tests all passed,
 * because `store.ts` had no tests at all.
 *
 * The companion to this is `server/test/client-events.test.ts`, which reads
 * the protocol and insists something handles every member of the union. That
 * one catches a deletion; these say the handling is right. It lives on the
 * server side because it reads files, and `web` deliberately has no node types
 * — the boundary that stops browser code importing `node:fs` is worth more
 * than keeping the two halves in one file.
 */

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 's1', title: 'One', cwd: '/repo', state: 'idle', lastActivityAt: 1, ...over } as SessionSummary;
}

/** The store's reducer, which is private to it and has no other way in. */
function deliver(event: ServerEvent): ClaudiaState {
  (store as unknown as { handle(e: ServerEvent): void }).handle(event);
  return store.getSnapshot();
}

describe('the session list', () => {
  beforeEach(() => {
    deliver({ type: 'session_removed', sessionId: 's1' });
    deliver({ type: 'session_removed', sessionId: 's2' });
  });

  it('adds a session it has not seen', () => {
    const state = deliver({ type: 'session_upsert', session: session() });
    expect(state.sessions.map((s) => s.id)).toContain('s1');
  });

  it('replaces a session in place rather than moving it to the end', () => {
    deliver({ type: 'session_upsert', session: session({ id: 's1' }) });
    deliver({ type: 'session_upsert', session: session({ id: 's2', title: 'Two' }) });
    const state = deliver({ type: 'session_upsert', session: session({ id: 's1', title: 'Renamed' }) });
    expect(state.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(state.sessions[0]?.title).toBe('Renamed');
  });

  it('removes a session and everything keyed by it', () => {
    deliver({ type: 'session_upsert', session: session() });
    deliver({ type: 'feed_append', sessionId: 's1', step: { id: 'f1', kind: 'text', text: 'hi', at: 1 } as never });
    deliver({ type: 'transcript', sessionId: 's1', items: [] });
    deliver({ type: 'models', sessionId: 's1', models: [] });
    deliver({ type: 'mcp_status', sessionId: 's1', servers: [] });

    const state = deliver({ type: 'session_removed', sessionId: 's1' });
    expect(state.sessions.map((s) => s.id)).not.toContain('s1');
    // The maps too. A removed session that left its feed, transcript and MCP
    // list behind is a leak that grows with every session ever held.
    for (const map of [state.feeds, state.transcripts, state.models, state.mcp]) {
      expect(Object.hasOwn(map, 's1')).toBe(false);
    }
  });

  it('leaves the other sessions alone when one goes', () => {
    deliver({ type: 'session_upsert', session: session({ id: 's1' }) });
    deliver({ type: 'session_upsert', session: session({ id: 's2' }) });
    const state = deliver({ type: 'session_removed', sessionId: 's1' });
    expect(state.sessions.map((s) => s.id)).toEqual(['s2']);
  });
});

describe('the rest of the snapshot', () => {
  it('knows the fleet limits before anything changes them', () => {
    // They arrive on `hello` as well as on a settings broadcast. Without that
    // the board would show a default it invented until somebody happened to
    // change a setting — a number that looks authoritative and is not.
    const state = deliver({
      type: 'hello',
      sessions: [],
      feeds: {},
      trigger: { armed: false } as never,
      platform: 'linux' as never,
      usage: { tier: 'auto' } as never,
      recentDirectories: [],
      countdownSec: 30,
      stopSessionsWhenClosedSec: 30,
      defaultPermissionMode: 'auto',
      templates: [],
      toolkit: [],
      fleetLimits: { maxChildren: 3, maxAttempts: 7 },
      mcp: {},
      observed: [],
      monitoring: false,
    });
    expect(state.fleetLimits).toEqual({ maxChildren: 3, maxAttempts: 7 });
  });

  it('takes a settings broadcast', () => {
    const state = deliver({
      type: 'settings',
      recentDirectories: ['/a'],
      countdownSec: 90,
      stopSessionsWhenClosedSec: 0,
      defaultPermissionMode: 'plan',
      templates: [],
      toolkit: [],
      fleetLimits: { maxChildren: 2, maxAttempts: 5 },
    });
    expect(state.countdownSec).toBe(90);
    expect(state.stopSessionsWhenClosedSec).toBe(0);
    expect(state.defaultPermissionMode).toBe('plan');
    expect(state.recentDirectories).toEqual(['/a']);
    expect(state.fleetLimits).toEqual({ maxChildren: 2, maxAttempts: 5 });
  });

  it('takes a usage snapshot', () => {
    const usage = { tier: 'auto' } as never;
    expect(deliver({ type: 'usage', usage }).usage).toBe(usage);
  });

  it('takes a trigger status', () => {
    const trigger = { armed: false } as never;
    expect(deliver({ type: 'trigger_status', trigger }).trigger).toBe(trigger);
  });

  it('shows a notice, which is not an error', () => {
    const state = deliver({ type: 'notice', message: 'Wrote your settings.' });
    expect(state.lastNotice).toBe('Wrote your settings.');
    expect(state.lastError).toBeUndefined();
  });

  it('hands a picked folder to whoever asked for it', () => {
    // The folder picker's reply is the one event that is not part of the
    // rendered snapshot, so nothing about the state would show its loss.
    const heard: string[][] = [];
    const stop = store.onFoldersPicked((paths) => heard.push(paths));
    deliver({ type: 'folders_picked', paths: ['/picked'] });
    stop();
    expect(heard).toEqual([['/picked']]);
  });
});
