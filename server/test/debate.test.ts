import type { AgentKind, SessionSummary } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { MAX_ROUNDS, reviewerIsSatisfied, runDebate, type DebateDeps, type DebateEntry } from '../src/debate.js';

/**
 * Driven through fake sessions, because what needs pinning is the ORDER and
 * the BOUNDS — who is asked what, in which sequence, and that it always stops.
 * This drives two agents with nobody watching, so an exchange that fails to
 * terminate spends real money in a loop.
 */

/** Mirrors TranscriptLog's default cap, scaled down so tests can reach it. */
const HARNESS_CAP = 500;

interface Harness {
  deps: DebateDeps;
  sent: Array<{ session: string; text: string }>;
  launched: Array<{ agent: AgentKind }>;
  notes: DebateEntry[];
  /** Queued replies per session, consumed in order. */
  replies: Map<string, string[]>;
  /** Transcripts that GROW, as a real one does: a reply is appended, never
   * replaced, so a turn-aware read can tell this turn's answer from the last. */
  transcripts: Map<string, Array<{ kind: string; text: string }>>;
  /** Total ever appended per session, which keeps counting after eviction. */
  appended: Map<string, number>;
  cancelled: string[];
  states: Map<string, string>;
  diff: string | null;
}

function harness(replies: Record<string, string[]> = {}, diff: string | null = 'diff --git a b'): Harness {
  const h: Harness = {
    deps: null as never,
    sent: [],
    launched: [],
    notes: [],
    replies: new Map(Object.entries(replies)),
    transcripts: new Map(),
    appended: new Map(),
    cancelled: [],
    states: new Map(),
    diff,
  };
  let next = 0;
  h.deps = {
    launch: ({ agent }) => {
      h.launched.push({ agent });
      return `session-${(next += 1)}`;
    },
    send: (session, text) => {
      h.sent.push({ session, text });
      // The reply a session gives is whatever was queued for it next.
      const queued = h.replies.get(session);
      const reply = queued?.shift();
      const items = h.transcripts.get(session) ?? [];
      if (reply !== undefined) {
        items.push({ kind: 'assistant', text: reply });
        h.appended.set(session, (h.appended.get(session) ?? 0) + 1);
        // Evicts from the front like the real TranscriptLog, so a cursor bug
        // fails here rather than only in production.
        if (items.length > HARNESS_CAP) items.splice(0, items.length - HARNESS_CAP);
      }
      h.transcripts.set(session, items);
    },
    awaitSettled: (id) => Promise.resolve({ id, state: h.states.get(id) ?? 'idle' } as SessionSummary),
    transcript: (id) => h.transcripts.get(id) ?? [],
    // Models the real log: a cursor that keeps counting past eviction.
    cursor: (id) => h.appended.get(id) ?? 0,
    since: (id, cursor) => {
      const items = h.transcripts.get(id) ?? [];
      const total = h.appended.get(id) ?? 0;
      return items.slice(Math.max(0, cursor - (total - items.length)));
    },
    readDiff: () => Promise.resolve(h.diff),
    note: (entry) => h.notes.push(entry),
    cancel: (id) => h.cancelled.push(id),
    stateOf: (id) => h.states.get(id) ?? 'idle',
  };
  return h;
}

const spec = {
  cwd: '/repo',
  objective: 'Add a retry to the upload path',
  subject: 'diff' as const,
  author: 'claude' as const,
  reviewer: 'codex' as const,
  rounds: 2,
};

describe('runDebate', () => {
  it("does not read a dead turn's preamble as the critique", async () => {
    // Found in review. `error` and `stopped` are settled too, so waiting for a
    // turn to end cannot tell finishing from dying — and a turn that died has
    // already written its opener ("Let me read the diff first.") after the
    // baseline, where every other guard waves it through.
    const h = harness({ 'session-1': ['Let me read the diff first.'] });
    h.states.set('session-1', 'error');
    const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(result.stoppedBecause).toBe('the reviewer said nothing');
    expect(result.entries).toEqual([]);
  });

  it('does not bill the author for rebutting a turn that died', async () => {
    // The cost of the bug above: the human's OWN tile pays for a rebuttal to
    // a non-critique, and then for a verdict.
    const h = harness({ 'session-1': ['Let me read the diff first.'] });
    h.states.set('session-1', 'error');
    await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(h.sent.filter((entry) => entry.session === 'author')).toEqual([]);
  });

  it('spends nothing when there is nothing uncommitted to review', async () => {
    // `readDiff` returns a truthy marker for a clean tree, and `diff` is the
    // default subject — so asking for a review just after committing bought a
    // reviewer session and five model turns about "(no tracked changes)".
    const h = harness({}, '(no tracked changes)');
    const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(result.stoppedBecause).toBe('there is nothing uncommitted to review');
    expect(h.launched).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('still reviews a tree whose only changes are untracked files', async () => {
    const h = harness(
      { 'session-1': ['a critique'], author: ['a rebuttal', 'a verdict'] },
      '(no tracked changes)\n\nUntracked files not shown in the diff:\n- new.ts',
    );
    const result = await runDebate({ ...spec, authorSessionId: 'author', rounds: 1 }, h.deps);
    expect(result.stoppedBecause).not.toBe('there is nothing uncommitted to review');
    expect(h.launched).toHaveLength(1);
  });

  it('finds the reply even when the transcript is at its eviction cap', async () => {
    // Found in review. TranscriptLog splices from the front at 500, so the
    // array length stays 500 forever — a length-based cursor reports "said
    // nothing" on precisely the long-lived sessions a human has worked in.
    const h = harness({ 'session-1': ['a real critique'], author: ['a rebuttal', 'a verdict'] });
    // A session already at the cap: 500 held, 900 ever appended.
    h.transcripts.set('session-1', Array.from({ length: 500 }, (_, i) => ({ kind: 'assistant', text: `old ${i}` })));
    h.appended.set('session-1', 900);

    const result = await runDebate({ ...spec, authorSessionId: 'author', rounds: 1 }, h.deps);
    expect(result.entries.find((e) => e.role === 'review')?.text).toBe('a real critique');
    expect(result.stoppedBecause).not.toBe('the reviewer said nothing');
  });

  it('refuses a stopped author instead of reading its last reply as an answer', async () => {
    // Found in review. `awaitSettled` is satisfied instantly by a session that
    // is already settled, so a stopped author "answered" every question with
    // whatever it last said — real, fluent text about the right repository.
    const h = harness();
    h.transcripts.set('author', [{ kind: 'assistant', text: 'stale text from an earlier question' }]);
    h.appended.set('author', 1);
    h.states.set('author', 'stopped');
    const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(result.stoppedBecause).toContain('stopped');
    expect(result.verdict).toBeUndefined();
    // And it spent nothing: no reviewer was launched for a dead exchange.
    expect(h.launched).toEqual([]);
  });

  it.each(['working', 'awaiting_approval', 'error', 'starting'])(
    'refuses an author that is %s',
    async (state) => {
      const h = harness();
      h.states.set('author', state);
      const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
      expect(result.stoppedBecause).toContain(state);
    },
  );

  it('never reads a reply from before the question it just asked', async () => {
    // The same defect one level down: even a live session has a transcript,
    // and "the last thing it said" is only an answer if it came after the ask.
    const h = harness();
    h.transcripts.set('session-1', [{ kind: 'assistant', text: 'something it said earlier' }]);
    h.appended.set('session-1', 1);
    const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(result.stoppedBecause).toBe('the reviewer said nothing');
    expect(result.entries).toEqual([]);
  });

  it('stops the sessions it started when a turn times out', async () => {
    // Otherwise the bookkeeping promise rejects and two agents carry on
    // spending money on a question nobody will ever read.
    const h = harness();
    h.deps.awaitSettled = () => Promise.reject(new Error('turn timed out'));
    await expect(runDebate({ ...spec, subject: 'plan' }, h.deps)).rejects.toThrow('turn timed out');
    expect(h.cancelled).toEqual(['session-1', 'session-2']);
  });

  it("never stops the human's own tile, only what it launched", async () => {
    const h = harness();
    h.deps.awaitSettled = () => Promise.reject(new Error('turn timed out'));
    await expect(runDebate({ ...spec, authorSessionId: 'author' }, h.deps)).rejects.toThrow();
    expect(h.cancelled).not.toContain('author');
    expect(h.cancelled).toEqual(['session-1']);
  });

  it('launches the reviewer as the OTHER agent, which is the whole point', async () => {
    const h = harness({ 'session-1': ['a critique', 'a verdict'] });
    await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(h.launched).toEqual([{ agent: 'codex' }]);
  });

  it('reuses an existing tile as the author rather than starting a second one', async () => {
    const h = harness({ 'session-1': ['critique'], author: ['rebuttal', 'verdict'] });
    const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(result.authorSessionId).toBe('author');
    expect(h.launched).toHaveLength(1);
  });

  it('runs review then rebuttal, in that order, and ends with a verdict', async () => {
    const h = harness({ 'session-1': ['critique one'], author: ['rebuttal one', 'the verdict'] });
    const result = await runDebate({ ...spec, authorSessionId: 'author', rounds: 1 }, h.deps);
    expect(h.sent.map((s) => s.session)).toEqual(['session-1', 'author', 'author']);
    expect(result.entries.map((e) => e.role)).toEqual(['review', 'rebuttal', 'verdict']);
    expect(result.verdict).toBe('the verdict');
  });

  it('stops early when the reviewer has no objections', async () => {
    // Paying for a rebuttal to "I agree" is the cost this avoids.
    const h = harness({ 'session-1': ['I agree, this is correct.'], author: ['verdict'] });
    const result = await runDebate({ ...spec, authorSessionId: 'author', rounds: 4 }, h.deps);
    expect(result.stoppedBecause).toMatch(/no objections/);
    expect(result.entries.filter((e) => e.role === 'rebuttal')).toHaveLength(0);
  });

  it('never exceeds the round ceiling however many are asked for', async () => {
    const h = harness({
      'session-1': Array(20).fill('a real objection'),
      author: Array(20).fill('a real answer'),
    });
    const result = await runDebate({ ...spec, authorSessionId: 'author', rounds: 99 }, h.deps);
    expect(result.rounds).toBe(MAX_ROUNDS);
  });

  it('always runs at least one round, even if asked for none', async () => {
    const h = harness({ 'session-1': ['critique'], author: ['rebuttal', 'verdict'] });
    const result = await runDebate({ ...spec, authorSessionId: 'author', rounds: 0 }, h.deps);
    expect(result.rounds).toBe(1);
  });

  it('gives up rather than looping when the reviewer says nothing', async () => {
    const h = harness({ author: ['verdict'] });
    const result = await runDebate({ ...spec, authorSessionId: 'author' }, h.deps);
    expect(result.stoppedBecause).toMatch(/reviewer said nothing/);
  });

  it('asks the author first for a design question, since nothing is written yet', async () => {
    const h = harness({ author: ['my proposal', 'rebuttal', 'verdict'], 'session-1': ['critique'] }, null);
    const result = await runDebate({ ...spec, subject: 'plan', authorSessionId: 'author' }, h.deps);
    expect(h.sent[0]).toMatchObject({ session: 'author', text: spec.objective });
    expect(result.entries[0]).toMatchObject({ role: 'opening', text: 'my proposal' });
  });

  it('shows the reviewer the diff for a diff debate', async () => {
    const h = harness({ 'session-1': ['critique'], author: ['rebuttal', 'verdict'] }, 'diff --git a/x b/x');
    await runDebate({ ...spec, authorSessionId: 'author', rounds: 1 }, h.deps);
    expect(h.sent[0]?.text).toContain('diff --git a/x b/x');
  });

  it('re-reads the diff between rounds, so round two argues about the new state', async () => {
    // Otherwise the reviewer keeps critiquing code the author already changed.
    const h = harness({ 'session-1': ['objection one', 'objection two'], author: ['fixed it', 'fixed again', 'verdict'] });
    h.diff = 'first state';
    const deps: DebateDeps = {
      ...h.deps,
      readDiff: () => Promise.resolve(h.diff),
    };
    const sentTexts: string[] = [];
    const wrapped: DebateDeps = {
      ...deps,
      send: (session, text) => {
        sentTexts.push(text);
        if (sentTexts.length === 2) h.diff = 'second state';
        deps.send(session, text);
      },
    };
    await runDebate({ ...spec, authorSessionId: 'author', rounds: 2 }, wrapped);
    expect(sentTexts[2]).toContain('second state');
  });

  it('reports every exchange as it happens, not just at the end', async () => {
    // The human is reading this while it runs; a result that only lands at the
    // end is indistinguishable from a hang.
    const h = harness({ 'session-1': ['critique'], author: ['rebuttal', 'verdict'] });
    await runDebate({ ...spec, authorSessionId: 'author', rounds: 1 }, h.deps);
    expect(h.notes.map((n) => n.role)).toEqual(['review', 'rebuttal', 'verdict']);
  });
});

describe('reviewerIsSatisfied', () => {
  it('recognises plain agreement', () => {
    for (const text of ['I agree, this is correct.', 'Agreed — nothing to add.', 'No objections.', 'LGTM']) {
      expect(reviewerIsSatisfied(text), text).toBe(true);
    }
  });

  it('does not mistake a real objection for agreement', () => {
    for (const text of ['This is wrong: the retry never backs off.', 'I would restructure this entirely.']) {
      expect(reviewerIsSatisfied(text), text).toBe(false);
    }
  });

  it('errs toward another round rather than swallowing an objection', () => {
    // A missed match costs one more round; a false match drops a real finding.
    expect(reviewerIsSatisfied('Mostly fine, but the error path leaks a handle.')).toBe(false);
  });

  it('sees through an objection wearing an agreement as a hat', () => {
    // The dangerous case: opens with the exact words of agreement and then
    // objects. Matching "i agree" anywhere in the text would end the debate
    // and lose the finding.
    expect(reviewerIsSatisfied('I agree with the general approach, but the retry never backs off.')).toBe(false);
    expect(reviewerIsSatisfied('Agreed on structure. One concern: the handle leaks.')).toBe(false);
    expect(reviewerIsSatisfied('LGTM overall, though I would rename the flag.')).toBe(false);
  });

  it('does not count agreement buried after the opening sentence', () => {
    expect(reviewerIsSatisfied('The retry path is broken. Everything else, I agree with.')).toBe(false);
  });
});
