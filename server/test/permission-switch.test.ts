import type { PermissionLaunchMode } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../src/async-queue.js';
import { switchPermissionMode, type SwitchCtx } from '../src/permission-switch.js';

/**
 * Changing permissions on a running session.
 *
 * Tightening applies in place; loosening cannot, because the SDK refuses with
 * "the session was not launched with --dangerously-skip-permissions", so the
 * session is relaunched with `resume` and the conversation is carried over.
 *
 * What is pinned here is the teardown. The relaunch used to close the outgoing
 * driver by reaching for a `close` on whatever `getQuery()` returned — true of
 * the Claude SDK query, and false of the small facade Codex exposes so the
 * model picker can read `supportedModels`. That facade has no `close`, so a
 * Codex app-server child outlived every permission change made to its session.
 */

interface Recorded {
  ctx: SwitchCtx;
  mode: PermissionLaunchMode;
  started: boolean;
  /** What `getQuery()` hands back — deliberately independent of `started`. */
  query: Record<string, unknown> | null;
  closed: number;
  abandoned: number;
  relaunches: Array<{ mode: PermissionLaunchMode; resume: string | undefined }>;
  feed: Array<{ title: string; meta?: string }>;
}

function harness(query: Record<string, unknown> | null, opts: { started?: boolean; resumeId?: string } = {}): Recorded {
  const rec: Recorded = {
    ctx: null as never,
    mode: 'default',
    started: opts.started ?? true,
    query,
    closed: 0,
    abandoned: 0,
    relaunches: [],
    feed: [],
  };
  let input = new AsyncQueue<unknown>();
  rec.ctx = {
    getMode: () => rec.mode,
    setMode: (m) => (rec.mode = m),
    hasStarted: () => rec.started,
    getQuery: () => rec.query,
    closeDriver: () => (rec.closed += 1),
    getInput: () => input,
    setInput: (q) => (input = q),
    bumpGeneration: () => undefined,
    resumeId: () => opts.resumeId,
    abandonForRestart: () => (rec.abandoned += 1),
    feedInfo: (title, meta) => rec.feed.push({ title, ...(meta ? { meta } : {}) }),
    updated: () => undefined,
    replaceQuery: (mode, resume) => rec.relaunches.push({ mode, resume }),
  };
  return rec;
}

describe('switchPermissionMode', () => {
  it('applies in place when the query can take the change', async () => {
    let applied: PermissionLaunchMode | undefined;
    const rec = harness({ setPermissionMode: async (m: PermissionLaunchMode) => { applied = m; } });
    expect(await switchPermissionMode(rec.ctx, 'acceptEdits')).toBe('in-place');
    expect(applied).toBe('acceptEdits');
    expect(rec.relaunches).toHaveLength(0);
    expect(rec.closed).toBe(0);
  });

  it('relaunches when the query refuses, keeping the conversation', async () => {
    const rec = harness(
      { setPermissionMode: async () => { throw new Error('not launched with --dangerously-skip-permissions'); } },
      { resumeId: 'thread-1' },
    );
    expect(await switchPermissionMode(rec.ctx, 'bypassPermissions')).toBe('relaunched');
    expect(rec.relaunches).toEqual([{ mode: 'bypassPermissions', resume: 'thread-1' }]);
    expect(rec.feed.at(-1)?.meta).toContain('conversation kept');
  });

  it('closes the driver it is replacing, even when the query exposes no close', async () => {
    // The Codex shape: a live driver whose `raw` carries the model-picker
    // facade and nothing else. Reaching for `close` on that found nothing and
    // left the app-server child running beside its own replacement.
    const rec = harness({ supportedModels: async () => [], setModel: async () => undefined });
    expect(await switchPermissionMode(rec.ctx, 'bypassPermissions')).toBe('relaunched');
    expect(rec.closed).toBe(1);
    expect(rec.relaunches).toHaveLength(1);
  });

  it('relaunches a started session whose driver exposes no query at all', async () => {
    // A Codex driver whose app-server never came up. It is running, so the
    // mode has to actually be applied — recording it would tell the user the
    // session had changed when nothing had.
    const rec = harness(null, { started: true, resumeId: 'thread-2' });
    expect(await switchPermissionMode(rec.ctx, 'bypassPermissions')).toBe('relaunched');
    expect(rec.relaunches).toEqual([{ mode: 'bypassPermissions', resume: 'thread-2' }]);
    expect(rec.closed).toBe(1);
  });

  it('records the mode without relaunching when nothing has started', async () => {
    const rec = harness(null, { started: false });
    expect(await switchPermissionMode(rec.ctx, 'plan')).toBe('in-place');
    expect(rec.relaunches).toHaveLength(0);
    expect(rec.closed).toBe(0);
    expect(rec.abandoned).toBe(0);
  });

  it('does nothing at all when the mode is already the one asked for', async () => {
    const rec = harness({});
    expect(await switchPermissionMode(rec.ctx, 'default')).toBe('unchanged');
    expect(rec.closed).toBe(0);
  });
});
