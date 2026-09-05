import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FeedStep, FeedStepPatch, TranscriptItem } from '@claudia/shared';
import { MirrorService } from '../src/mirror.js';

/**
 * Following a transcript that is still being written.
 *
 * Driven against real files, because everything interesting here is about
 * partial writes and byte offsets — the two things a fake file cannot have.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-mirror-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function transcript(sessionId: string) {
  const root = join(dir, `projects-${counter++}`);
  mkdirSync(join(root, '-home-user-repo'), { recursive: true });
  return { root, path: join(root, '-home-user-repo', `${sessionId}.jsonl`) };
}

const at = (n: number): string => new Date(1_700_000_000_000 + n).toISOString();

const prompt = (text: string, n: number): string =>
  `${JSON.stringify({ type: 'user', uuid: `u${n}`, timestamp: at(n), message: { role: 'user', content: text } })}\n`;

const toolUse = (id: string, name: string, n: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `a${n}`,
    timestamp: at(n),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  })}\n`;

const toolResult = (id: string, n: number): string =>
  `${JSON.stringify({
    type: 'user',
    uuid: `r${n}`,
    timestamp: at(n),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done', is_error: false }] },
  })}\n`;

function recorder() {
  const opened: Array<{ sessionId: string; feed: FeedStep[]; transcript: TranscriptItem[]; elided: number }> = [];
  const steps: FeedStep[] = [];
  const items: TranscriptItem[] = [];
  const patches: Array<{ stepId: string; patch: FeedStepPatch }> = [];
  const unavailable: Array<{ sessionId: string; reason: string }> = [];
  return {
    opened,
    steps,
    items,
    patches,
    unavailable,
    sink: {
      opened: (sessionId: string, backlog: { transcript: TranscriptItem[]; feed: FeedStep[]; elided: number }) =>
        void opened.push({ sessionId, ...backlog }),
      step: (_s: string, step: FeedStep) => void steps.push(step),
      item: (_s: string, item: TranscriptItem) => void items.push(item),
      patch: (_s: string, stepId: string, patch: FeedStepPatch) => void patches.push({ stepId, patch }),
      unavailable: (sessionId: string, reason: string) => void unavailable.push({ sessionId, reason }),
    },
  };
}

describe('mirroring a session Claudia does not own', () => {
  it('sends what the transcript already holds when it opens', async () => {
    const { root, path } = transcript('sess-a');
    appendFileSync(path, prompt('do the thing', 1) + toolUse('t1', 'Bash', 2));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);

    await mirror.open('sess-a');
    expect(rec.opened).toHaveLength(1);
    expect(rec.opened[0]?.transcript.map((i) => i.kind)).toEqual(['user', 'tool_use']);
    expect(rec.opened[0]?.feed.map((s) => s.kind)).toEqual(['text', 'tool']);
    expect(rec.opened[0]?.elided).toBe(0);
  });

  it('streams what is appended after it opened', async () => {
    const { root, path } = transcript('sess-b');
    appendFileSync(path, prompt('first', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-b');

    appendFileSync(path, prompt('second', 2));
    await mirror.poll();
    expect(rec.items.map((i) => i.text)).toEqual(['second']);
  });

  it('does not re-send anything when nothing was appended', async () => {
    const { root, path } = transcript('sess-c');
    appendFileSync(path, prompt('only one', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-c');

    await mirror.poll();
    await mirror.poll();
    expect(rec.items).toEqual([]);
  });

  it('waits for a half-written line rather than losing it', async () => {
    // The normal state of a file a live session is appending to.
    const { root, path } = transcript('sess-d');
    appendFileSync(path, prompt('complete', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-d');

    const half = prompt('split across two polls', 2);
    appendFileSync(path, half.slice(0, 30));
    await mirror.poll();
    expect(rec.items).toEqual([]);

    appendFileSync(path, half.slice(30));
    await mirror.poll();
    expect(rec.items.map((i) => i.text)).toEqual(['split across two polls']);
  });

  it('keeps a split multi-byte character intact across polls', async () => {
    // The defect the usage reader shipped twice: an offset measured off decoded
    // text does not survive U+FFFD, so the resume point drifts.
    const { root, path } = transcript('sess-e');
    appendFileSync(path, prompt('start', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-e');

    const line = Buffer.from(prompt('ship it 🚀 now', 2), 'utf8');
    const cut = line.indexOf(Buffer.from('🚀', 'utf8')) + 1;
    appendFileSync(path, line.subarray(0, cut));
    await mirror.poll();
    appendFileSync(path, line.subarray(cut));
    await mirror.poll();
    expect(rec.items.map((i) => i.text)).toEqual(['ship it 🚀 now']);
  });

  it('patches a tool step whose result arrives in a later poll', async () => {
    // The reason `pending` is kept across reads rather than per slice.
    const { root, path } = transcript('sess-f');
    appendFileSync(path, toolUse('t9', 'Read', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-f');
    expect(rec.opened[0]?.feed[0]?.status).toBe('running');

    appendFileSync(path, toolResult('t9', 500));
    await mirror.poll();
    expect(rec.patches).toEqual([{ stepId: rec.opened[0]?.feed[0]?.id, patch: { status: 'ok', durMs: 499 } }]);
  });

  it('says so when there is no local transcript', async () => {
    // A session on another machine, or on the web, has no local log and never
    // will. That is an answer, not a failure.
    const { root } = transcript('sess-g');
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('nothing-here');
    expect(rec.unavailable[0]?.sessionId).toBe('nothing-here');
    expect(rec.opened).toEqual([]);
  });

  it('stops reading once the mirror is closed', async () => {
    const { root, path } = transcript('sess-h');
    appendFileSync(path, prompt('first', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-h');
    mirror.close('sess-h');
    expect(mirror.size).toBe(0);

    appendFileSync(path, prompt('after the close', 2));
    await mirror.poll();
    expect(rec.items).toEqual([]);
  });

  it('opens a session only once, however often it is asked', async () => {
    // Two viewers of one terminal session read the same transcript; opening it
    // twice would double every step.
    const { root, path } = transcript('sess-i');
    appendFileSync(path, prompt('shared', 1));
    const rec = recorder();
    const mirror = new MirrorService(rec.sink, root);
    await mirror.open('sess-i');
    await mirror.open('sess-i');
    expect(rec.opened).toHaveLength(1);
    expect(mirror.size).toBe(1);
  });
});
