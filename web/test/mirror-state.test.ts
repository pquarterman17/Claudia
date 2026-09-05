import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@claudia/shared';
import { foldMirror, type Mirrors } from '../src/mirror-state';

/**
 * What the client keeps for a session it is only watching.
 *
 * The interesting cases are all about a mirror that is NOT open — closing races
 * every event already in flight, and rebuilding an entry from a fragment would
 * show a conversation that appears to start in the middle.
 */

const step = (id: string, status?: 'running' | 'ok' | 'error') => ({
  id,
  ts: 1,
  kind: 'tool' as const,
  title: 'Bash',
  ...(status ? { status } : {}),
});

const item = (text: string) => ({ ts: 1, kind: 'user' as const, text });

const opened = (sessionId: string): ServerEvent => ({
  type: 'mirror_opened',
  sessionId,
  transcript: [item('hello')],
  feed: [step('s1', 'running')],
  elided: 3,
});

describe('folding mirror events', () => {
  it('ignores events that are not a mirror', () => {
    expect(foldMirror({}, { type: 'server_error', message: 'unrelated' })).toBeUndefined();
  });

  it('opens with the backlog, and says how much was cut', () => {
    const next = foldMirror({}, opened('s'));
    expect(next?.['s']?.elided).toBe(3);
    expect(next?.['s']?.transcript).toHaveLength(1);
  });

  it('appends steps and items to an open mirror', () => {
    const open = foldMirror({}, opened('s')) as Mirrors;
    const withStep = foldMirror(open, { type: 'mirror_step', sessionId: 's', step: step('s2') }) as Mirrors;
    const withItem = foldMirror(withStep, { type: 'mirror_item', sessionId: 's', item: item('more') }) as Mirrors;
    expect(withItem['s']?.feed.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(withItem['s']?.transcript.map((i) => i.text)).toEqual(['hello', 'more']);
  });

  it('revises a step already sent', () => {
    const open = foldMirror({}, opened('s')) as Mirrors;
    const patched = foldMirror(open, {
      type: 'mirror_patch',
      sessionId: 's',
      stepId: 's1',
      patch: { status: 'ok', durMs: 12 },
    }) as Mirrors;
    expect(patched['s']?.feed[0]?.status).toBe('ok');
    expect(patched['s']?.feed[0]?.durMs).toBe(12);
  });

  it('drops events for a mirror that was closed', () => {
    // The race closing always has: the server read and sent before it saw the
    // close. Re-creating the entry here would start a conversation midway.
    const after = foldMirror({}, { type: 'mirror_step', sessionId: 'gone', step: step('s9') });
    expect(after).toEqual({});
  });

  it('records why there is nothing to read', () => {
    const next = foldMirror({}, {
      type: 'mirror_unavailable',
      sessionId: 's',
      reason: 'no transcript for that session on this machine',
    });
    expect(next?.['s']?.reason).toContain('no transcript');
    expect(next?.['s']?.transcript).toEqual([]);
  });
});
