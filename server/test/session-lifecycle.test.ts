import type { FeedStep, FeedStepPatch, SessionSummary, TranscriptItem } from '@claudia/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeQuery, assistantText, initMsg, resultMsg, streamDelta, tick } from './fake-query.js';

/**
 * Lifecycle vectors for ClaudiaSession, driven through a fake SDK query.
 *
 * These exist because the permission-toggle bug shipped with every unit test
 * green: the failure lived in the orchestration between the session and the
 * SDK, which nothing exercised. The single construction seam (query-factory)
 * is mocked so every launch/relaunch/race can be replayed deterministically.
 */

const fakes: FakeQuery[] = [];

vi.mock('../src/query-factory.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/query-factory.js')>();
  return {
    ...real,
    createSessionQuery: (spec: import('../src/query-factory.js').QuerySpec) => {
      const fake = new FakeQuery(spec);
      fakes.push(fake);
      return fake as never;
    },
  };
});

const { ClaudiaSession } = await import('../src/session.js');

interface Recorded {
  session: InstanceType<typeof ClaudiaSession>;
  updates: SessionSummary[];
  feeds: FeedStep[];
  patches: Array<{ stepId: string; patch: FeedStepPatch }>;
  drafts: Array<string | null>;
  transcriptItems: TranscriptItem[];
}

function launch(opts: { prompt?: string; permissionMode?: SessionSummary['permissionMode'] } = {}): Recorded {
  const rec: Recorded = { session: null as never, updates: [], feeds: [], patches: [], drafts: [], transcriptItems: [] };
  rec.session = new ClaudiaSession(
    { cwd: 'C:/x', permissionMode: opts.permissionMode ?? 'auto', ...(opts.prompt ? { prompt: opts.prompt } : {}) },
    {
      onUpdate: (s) => rec.updates.push(s),
      onFeed: (_id, step) => rec.feeds.push(step),
      onFeedPatch: (_id, stepId, patch) => rec.patches.push({ stepId, patch }),
      onDraft: (_id, text) => rec.drafts.push(text),
      onCommands: () => {},
      onTranscript: (_id, item) => rec.transcriptItems.push(item),
    },
  );
  rec.session.start();
  return rec;
}

const current = (): FakeQuery => {
  const fake = fakes[fakes.length - 1];
  if (!fake) throw new Error('no query was created');
  return fake;
};

beforeEach(() => {
  fakes.length = 0;
});

describe('launch vectors', () => {
  it('V1: launch with a prompt creates one query and delivers the prompt', async () => {
    const rec = launch({ prompt: 'do the thing' });
    await tick();
    expect(fakes).toHaveLength(1);
    expect(current().received).toEqual(['do the thing']);

    current().emit(initMsg('sess-1', 'claude-opus-5'));
    await tick();
    expect(rec.session.summary().state).toBe('working');
    expect(rec.session.summary().model).toBe('claude-opus-5');
    expect(rec.session.summary().claudeSessionId).toBe('sess-1');
  });

  it('V2: an empty launch spawns nothing and reads idle', async () => {
    const rec = launch();
    await tick();
    expect(fakes).toHaveLength(0);
    expect(rec.session.summary().state).toBe('idle');
    expect(rec.feeds.some((f) => /Session ready/.test(f.title))).toBe(true);
  });

  it('V3: the first prompt to an empty session starts exactly one query', async () => {
    const rec = launch();
    await tick();
    rec.session.sendPrompt('wake up');
    rec.session.sendPrompt('and another');
    await tick();
    expect(fakes).toHaveLength(1);
    expect(current().received).toEqual(['wake up', 'and another']);
  });
});

describe('permission-mode vectors (the shipped regression)', () => {
  it('V4: toggling on an empty session records the mode without any query', async () => {
    const rec = launch();
    await tick();
    const how = await rec.session.setPermissionMode('bypassPermissions');
    expect(how).toBe('in-place');
    expect(fakes).toHaveLength(0);
    expect(rec.session.summary().permissionMode).toBe('bypassPermissions');

    // The eventual first prompt launches with the recorded mode.
    rec.session.sendPrompt('go');
    await tick();
    expect(current().spec.permissionMode).toBe('bypassPermissions');
  });

  it('V5: tightening a live session applies in place — no relaunch', async () => {
    const rec = launch({ prompt: 'x', permissionMode: 'bypassPermissions' });
    await tick();
    current().allowInPlaceSwitch = true;
    const how = await rec.session.setPermissionMode('default');
    expect(how).toBe('in-place');
    expect(fakes).toHaveLength(1);
  });

  it('V6: loosening a live session relaunches with resume and the new mode', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    current().emit(initMsg('sess-resume-me'));
    await tick();

    const old = current();
    const how = await rec.session.setPermissionMode('bypassPermissions');
    await tick();
    expect(how).toBe('relaunched');
    expect(fakes).toHaveLength(2);
    expect(old.closed).toBe(true);
    expect(current().spec.resume).toBe('sess-resume-me');
    expect(current().spec.permissionMode).toBe('bypassPermissions');
  });

  it('V7: the superseded query terminating late must NOT mark the session stopped', async () => {
    // The exact race that shipped: the old consume loop only observes its
    // termination a microtask after the relaunch already cleared its flag.
    const rec = launch({ prompt: 'x' });
    await tick();
    const old = current();
    await rec.session.setPermissionMode('bypassPermissions');
    // Old loop ends now — strictly after the relaunch completed.
    old.close();
    await tick();
    expect(rec.session.summary().state).not.toBe('stopped');
  });

  it('V8: messages from a superseded query are ignored', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    const old = current();
    await rec.session.setPermissionMode('bypassPermissions');
    await tick();

    const feedsBefore = rec.feeds.length;
    old.emit(assistantText('ghost message from the dead query'));
    await tick();
    expect(rec.feeds.length).toBe(feedsBefore);
  });

  it('V9: rapid double relaunch — only the newest generation counts', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    await rec.session.setPermissionMode('bypassPermissions');
    await rec.session.setPermissionMode('default'); // fake rejects switching, so relaunches again
    await tick();
    expect(fakes).toHaveLength(3);

    fakes[0]?.close();
    fakes[1]?.close();
    await tick();
    expect(rec.session.summary().state).not.toBe('stopped');

    current().emit(assistantText('still alive'));
    await tick();
    expect(rec.feeds.some((f) => /still alive/.test(f.title))).toBe(true);
  });

  it('V10: a prompt buffered behind a busy turn survives the relaunch', async () => {
    const rec = launch({ prompt: 'first' });
    await tick();
    current().stopReading(); // CLI busy: next prompt stays buffered
    rec.session.sendPrompt('queued behind the turn');
    await tick();

    await rec.session.setPermissionMode('bypassPermissions');
    await tick(5);
    expect(current().received).toContain('queued behind the turn');
  });

  it('V11: prompts sent after the relaunch reach only the new query', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    const old = current();
    await rec.session.setPermissionMode('bypassPermissions');
    rec.session.sendPrompt('for the new one');
    await tick();
    expect(current().received).toContain('for the new one');
    expect(old.received).not.toContain('for the new one');
  });
});

describe('plan-mode vectors', () => {
  // 'plan' rides the same generic tighten/loosen mechanism as every other
  // mode in permission-switch.ts — nothing in that file special-cases it, so
  // these vectors just replay V4/V5/V6 with 'plan' standing in to prove that
  // holds rather than duplicating the switching logic itself.

  it('V21: an empty session records a switch into plan mode without any query', async () => {
    const rec = launch();
    await tick();
    const how = await rec.session.setPermissionMode('plan');
    expect(how).toBe('in-place');
    expect(fakes).toHaveLength(0);
    expect(rec.session.summary().permissionMode).toBe('plan');
  });

  it('V22: switching a live session into plan mode tightens in place — no relaunch', async () => {
    const rec = launch({ prompt: 'x', permissionMode: 'bypassPermissions' });
    await tick();
    current().allowInPlaceSwitch = true;
    const how = await rec.session.setPermissionMode('plan');
    expect(how).toBe('in-place');
    expect(fakes).toHaveLength(1);
  });

  it('V23: switching a live session out of plan mode relaunches with resume, same as any other loosen', async () => {
    const rec = launch({ prompt: 'x', permissionMode: 'plan' });
    await tick();
    current().emit(initMsg('sess-plan-resume'));
    await tick();

    const old = current();
    const how = await rec.session.setPermissionMode('bypassPermissions');
    await tick();
    expect(how).toBe('relaunched');
    expect(fakes).toHaveLength(2);
    expect(old.closed).toBe(true);
    expect(current().spec.resume).toBe('sess-plan-resume');
    expect(current().spec.permissionMode).toBe('bypassPermissions');
  });
});

describe('termination vectors', () => {
  it('V12: the current query ending naturally marks the session stopped', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    current().close();
    await tick();
    expect(rec.session.summary().state).toBe('stopped');
  });

  it('V13: a current-generation failure marks error with the message', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    current().fail(new Error('transport exploded'));
    await tick();
    expect(rec.session.summary().state).toBe('error');
    expect(rec.session.summary().errorMessage).toBe('transport exploded');
  });

  it('V14: a superseded failure is silent', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    const old = current();
    await rec.session.setPermissionMode('bypassPermissions');
    old.fail(new Error('too late to matter'));
    await tick();
    expect(rec.session.summary().state).not.toBe('error');
  });

  it('V15: stop() clears the queue and reports stopped', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    rec.session.sendPrompt('never sent');
    rec.session.stop();
    expect(rec.session.summary().state).toBe('stopped');
    expect(rec.session.summary().queuedPrompts).toEqual([]);
  });
});

describe('streaming vectors', () => {
  it('V16: deltas surface as a draft and the complete message clears it', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    current().emit(streamDelta('Hel'));
    await tick();
    expect(rec.drafts).toEqual(['Hel']); // first emit is immediate

    current().emit(assistantText('Hello there'));
    await tick();
    expect(rec.drafts[rec.drafts.length - 1]).toBeNull();
  });

  it('V17: a relaunch clears any in-flight draft instead of leaving a ghost', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    current().emit(streamDelta('half a thou'));
    await tick();
    await rec.session.setPermissionMode('bypassPermissions');
    await tick();
    expect(rec.drafts[rec.drafts.length - 1]).toBeNull();
  });
});

describe('transcript vectors', () => {
  it('V19: the launch prompt is the first transcript line', async () => {
    const rec = launch({ prompt: 'hello there' });
    await tick();
    const items = rec.session.transcript.list();
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello there' });
  });

  it('V20: prompts sent later append user items too', async () => {
    const rec = launch({ prompt: 'first' });
    await tick();
    rec.session.sendPrompt('second');
    const kinds = rec.session.transcript.list().map((i) => i.kind);
    expect(kinds).toEqual(['user', 'user']);
  });
});

describe('turn-queue vectors', () => {
  it('V18: prompts sent mid-turn are listed, and a result consumes one', async () => {
    const rec = launch({ prompt: 'x' });
    await tick();
    current().emit(initMsg());
    await tick();
    rec.session.sendPrompt('second');
    expect(rec.session.summary().queuedPrompts).toEqual(['second']);

    current().emit(resultMsg());
    await tick();
    expect(rec.session.summary().queuedPrompts).toEqual([]);
  });
});
