import type { AgentKind, SessionSummary } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { MAX_TASKS, runCrew, type CrewDeps, type CrewProgress, type LaunchedMember } from '../src/crew.js';

/**
 * Driven through fake sessions, because what needs pinning is the SHAPE of the
 * run: who is launched, in what order, what happens when one member cannot
 * start, and that a planner answering in prose still gets the work done rather
 * than producing an error after a paid planning turn.
 */

interface Harness {
  deps: CrewDeps;
  launches: Array<{ agent: AgentKind; branch?: string; at: number }>;
  sent: Array<{ session: string; text: string }>;
  progress: CrewProgress[];
  /** Sessions that had been launched but not yet settled, at each launch. */
  concurrentAtLaunch: number[];
  /** Sessions currently mid-turn, to prove members overlap and launches do not. */
  inFlight: Set<string>;
  peakInFlight: number;
  cancelled: string[];
  /** How each session's turn ends. Defaults to `idle`. */
  states: Map<string, string>;
}

interface HarnessOpts {
  /** Reply queued per session id, consumed in order. */
  replies?: Record<string, string[]>;
  /** Branch names that cannot get a worktree. */
  refuseBranch?: (branch: string) => boolean;
}

function harness(opts: HarnessOpts = {}): Harness {
  const replies = new Map(Object.entries(opts.replies ?? {}));
  // Transcripts GROW, as a real one does. A replacing map would hide the very
  // defect the turn-aware read exists to catch.
  const transcripts = new Map<string, Array<{ kind: string; text: string }>>();
  const appended = new Map<string, number>();
  let next = 0;
  let openLaunches = 0;

  const h: Harness = {
    deps: null as never,
    launches: [],
    sent: [],
    progress: [],
    concurrentAtLaunch: [],
    inFlight: new Set(),
    peakInFlight: 0,
    cancelled: [],
    states: new Map(),
  };

  h.deps = {
    launch: async (opts2) => {
      // A launch that overlaps another would mean two `git worktree add` calls
      // racing for the repository lock.
      h.concurrentAtLaunch.push(openLaunches);
      openLaunches += 1;
      await Promise.resolve();
      if (opts2.branch && opts.refuseBranch?.(opts2.branch)) {
        openLaunches -= 1;
        throw new Error(`no worktree for ${opts2.branch}`);
      }
      const id = `session-${(next += 1)}`;
      h.launches.push({ agent: opts2.agent, ...(opts2.branch ? { branch: opts2.branch } : {}), at: h.launches.length });
      openLaunches -= 1;
      const result: LaunchedMember = { sessionId: id, cwd: opts2.branch ? `/tree/${opts2.branch}` : opts2.cwd };
      return opts2.branch ? { ...result, branch: opts2.branch } : result;
    },
    send: (session, text) => {
      h.sent.push({ session, text });
      const reply = replies.get(session)?.shift();
      const items = transcripts.get(session) ?? [];
      if (reply !== undefined) {
        items.push({ kind: 'assistant', text: reply });
        appended.set(session, (appended.get(session) ?? 0) + 1);
      }
      transcripts.set(session, items);
      h.inFlight.add(session);
      h.peakInFlight = Math.max(h.peakInFlight, h.inFlight.size);
    },
    awaitSettled: async (session) => {
      // Two ticks, so members started together are all in flight at once
      // before any of them finishes.
      await Promise.resolve();
      await Promise.resolve();
      h.inFlight.delete(session);
      // A real settle carries the state it settled INTO — `idle` for a turn
      // that finished, `error`/`stopped` for one that died. Returning nothing
      // is what let a dead turn read as an answer.
      return { id: session, state: h.states.get(session) ?? 'idle' } as SessionSummary;
    },
    transcript: (session) => transcripts.get(session) ?? [],
    cursor: (session) => appended.get(session) ?? 0,
    since: (session, cursor) => {
      const items = transcripts.get(session) ?? [];
      const total = appended.get(session) ?? 0;
      return items.slice(Math.max(0, cursor - (total - items.length)));
    },
    progress: (update) => h.progress.push(update),
    cancel: (id) => h.cancelled.push(id),
  };
  return h;
}

const PLAN = ['TASK: alpha', 'DO: do alpha.', 'TASK: beta', 'DO: do beta.'].join('\n');

function spec(over: Partial<Parameters<typeof runCrew>[0]> = {}) {
  return {
    cwd: '/repo',
    objective: 'build the thing',
    planner: 'claude' as AgentKind,
    workers: ['claude', 'codex'] as AgentKind[],
    maxTasks: 3,
    runId: 'run001',
    ...over,
  };
}

describe('runCrew', () => {
  it('stops a member whose own turn times out, without failing the run', async () => {
    // Found in review. The per-member catch returns normally, so Promise.all
    // resolves and the run-level cleanup never fires — the planner writes a
    // report while a timed-out member is still editing and still spending.
    const h = harness({ replies: { 'session-1': [PLAN, 'the report'], 'session-3': ['did beta'] } });
    const settle = h.deps.awaitSettled;
    h.deps.awaitSettled = (session, ms) =>
      session === 'session-2' ? Promise.reject(new Error('member timed out')) : settle(session, ms);

    const result = await runCrew(spec(), h.deps);
    expect(h.cancelled).toEqual(['session-2']);
    expect(result.members[0]).toMatchObject({ state: 'failed' });
    // The other member and the report are unaffected: one failure is not the run's.
    expect(result.members[1]?.state).toBe('done');
    expect(result.report).toBe('the report');
  });

  it('stops every session it started when the planner turn fails', async () => {
    // Found in review. The bookkeeping promise rejecting is not a reason to
    // leave several agents editing several worktrees with nobody reading it.
    const h = harness({ replies: { 'session-1': [PLAN] } });
    const settle = h.deps.awaitSettled;
    let calls = 0;
    h.deps.awaitSettled = (session, ms) => {
      calls += 1;
      // Fail the closing report, by which point the members exist.
      return calls > 3 ? Promise.reject(new Error('turn timed out')) : settle(session, ms);
    };
    await expect(runCrew(spec(), h.deps)).rejects.toThrow('turn timed out');
    expect(h.cancelled).toContain('session-1');
    expect(h.cancelled).toContain('session-2');
    expect(h.cancelled).toContain('session-3');
  });

  it('stops the planner when the split itself times out, before any member exists', async () => {
    const h = harness();
    h.deps.awaitSettled = () => Promise.reject(new Error('turn timed out'));
    await expect(runCrew(spec(), h.deps)).rejects.toThrow('turn timed out');
    expect(h.cancelled).toEqual(['session-1']);
  });

  it("never reports a member\u2019s earlier words as its summary", async () => {
    // A member whose turn produced nothing must read as silence, not as
    // whatever it happened to say before the crew existed.
    const h = harness({ replies: { 'session-1': [PLAN, 'the report'] } });
    const result = await runCrew(spec(), h.deps);
    expect(result.members.map((m) => m.summary)).toEqual([undefined, undefined]);
  });

  it('plans first, then launches one session per piece', async () => {
    const h = harness({ replies: { 'session-1': [PLAN, 'the report'] } });
    const result = await runCrew(spec(), h.deps);

    expect(h.launches).toHaveLength(3); // planner + two members
    expect(result.members.map((m) => m.title)).toEqual(['alpha', 'beta']);
    expect(result.report).toBe('the report');
  });

  it('gives every member its own branch', async () => {
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    const result = await runCrew(spec(), h.deps);
    const branches = result.members.map((m) => m.branch);
    expect(new Set(branches).size).toBe(2);
    for (const branch of branches) expect(branch).toContain('crew-run001');
  });

  it('never opens two checkouts at once', async () => {
    // `git worktree add` takes the repository lock; concurrent adds fail on a
    // lock the caller never sees.
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    await runCrew(spec(), h.deps);
    expect(Math.max(...h.concurrentAtLaunch)).toBe(0);
  });

  it('works the pieces at the same time', async () => {
    // The whole reason to split: sequential members would just be one agent
    // with extra steps and extra worktrees.
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    await runCrew(spec(), h.deps);
    expect(h.peakInFlight).toBeGreaterThan(1);
  });

  it('deals the agents round-robin across the pieces', async () => {
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    const result = await runCrew(spec({ workers: ['claude', 'codex'] }), h.deps);
    expect(result.members.map((m) => m.agent)).toEqual(['claude', 'codex']);
  });

  it("uses the planner's own agent when no workers were given", async () => {
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    const result = await runCrew(spec({ workers: [], planner: 'codex' }), h.deps);
    expect(result.members.map((m) => m.agent)).toEqual(['codex', 'codex']);
  });

  it('gives the whole objective to one agent when the plan is unreadable', async () => {
    // The alternative is an error after a paid planning turn, which is strictly
    // worse than what the human would have had without this feature at all.
    const h = harness({ replies: { 'session-1': ['I would rather not split this.', 'r'] } });
    const result = await runCrew(spec(), h.deps);
    expect(result.members).toHaveLength(1);
    expect(result.members[0]?.brief).toBe('build the thing');
    expect(result.stoppedBecause).toMatch(/did not return a usable split/);
  });

  it('falls back the same way when the planner says nothing at all', async () => {
    const h = harness();
    const result = await runCrew(spec(), h.deps);
    expect(result.members).toHaveLength(1);
    expect(result.stoppedBecause).toBeDefined();
  });

  it('never asks for more pieces than the cap allows', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `TASK: p${i}\nDO: d${i}.`).join('\n');
    const h = harness({ replies: { 'session-1': [many, 'r'] } });
    const result = await runCrew(spec({ maxTasks: 99 }), h.deps);
    expect(result.members.length).toBeLessThanOrEqual(MAX_TASKS);
  });

  it('carries on when one member cannot get a checkout', async () => {
    // One failed worktree must not cost the other members' work.
    const h = harness({
      replies: { 'session-1': [PLAN, 'r'], 'session-2': ['did beta'] },
      refuseBranch: (b) => b.includes('alpha'),
    });
    const result = await runCrew(spec(), h.deps);
    expect(result.members[0]?.state).toBe('failed');
    expect(result.members[0]?.error).toContain('no worktree');
    expect(result.members[1]?.state).toBe('done');
  });

  it('tells the planner about the member that failed', async () => {
    const h = harness({
      replies: { 'session-1': [PLAN, 'r'] },
      refuseBranch: (b) => b.includes('alpha'),
    });
    await runCrew(spec(), h.deps);
    const report = h.sent.filter((s) => s.session === 'session-1').at(-1);
    expect(report?.text).toContain('FAILED: no worktree');
  });

  it('still writes a report when every member failed', async () => {
    // A run where nothing worked is exactly when the human most needs to be
    // told, rather than shown an empty panel.
    const h = harness({ replies: { 'session-1': [PLAN, 'all of it failed'] }, refuseBranch: () => true });
    const result = await runCrew(spec(), h.deps);
    expect(result.members.every((m) => m.state === 'failed')).toBe(true);
    expect(result.report).toBe('all of it failed');
  });

  it("records each member's own words as its summary", async () => {
    const h = harness({
      replies: { 'session-1': [PLAN, 'r'], 'session-2': ['did alpha'], 'session-3': ['did beta'] },
    });
    const result = await runCrew(spec(), h.deps);
    expect(result.members.map((m) => m.summary)).toEqual(['did alpha', 'did beta']);
  });

  it('reports progress before the run finishes, not only at the end', async () => {
    // A panel that shows nothing for twenty minutes is indistinguishable from
    // a hang, and gets killed.
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    await runCrew(spec(), h.deps);
    expect(h.progress[0]).toEqual({ kind: 'planner', sessionId: 'session-1' });
    expect(h.progress.some((p) => p.kind === 'planned')).toBe(true);
    expect(h.progress.filter((p) => p.kind === 'member').length).toBeGreaterThanOrEqual(4);
  });

  it("asks the planner for the report last, on the planner's own session", async () => {
    const h = harness({ replies: { 'session-1': [PLAN, 'r'] } });
    await runCrew(spec(), h.deps);
    const last = h.sent.at(-1);
    expect(last?.session).toBe('session-1');
    expect(last?.text).toContain('DONE:');
  });
});
