import { describe, expect, it } from 'vitest';
import { readMirror } from '../src/observed-transcript.js';

/**
 * The record shapes here are copied from a real Claude Code transcript, not
 * from documentation — the same reason `hook-monitor.ts` gives for having
 * captured its own field names: the published reference was wrong about four
 * of them, and a parser built on the documented shapes produces empty output
 * that looks like a quiet session rather than a bug.
 */

const at = (n: number): string => new Date(1_700_000_000_000 + n).toISOString();

const line = (record: unknown): string => JSON.stringify(record);

const userText = (text: string, n = 0) =>
  line({ type: 'user', uuid: `u${n}`, timestamp: at(n), message: { role: 'user', content: text } });

const assistantBlocks = (blocks: unknown[], n = 0, over: Record<string, unknown> = {}) =>
  line({ type: 'assistant', uuid: `a${n}`, timestamp: at(n), message: { role: 'assistant', content: blocks }, ...over });

const toolResult = (id: string, n: number, over: Record<string, unknown> = {}) =>
  line({
    type: 'user',
    uuid: `r${n}`,
    timestamp: at(n),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false, ...over }] },
  });

describe('reconstructing a conversation from the log', () => {
  it('reads a prompt, a reply, and the thinking between them', () => {
    const slice = readMirror(
      [
        userText('rename the thing', 0),
        assistantBlocks([{ type: 'thinking', thinking: 'weighing it up' }, { type: 'text', text: 'Renamed it.' }], 1),
      ].join('\n'),
    );
    expect(slice.transcript.map((i) => i.kind)).toEqual(['user', 'thinking', 'assistant']);
    expect(slice.transcript[2]?.text).toBe('Renamed it.');
  });

  it('does not read tool output as something a human typed', () => {
    // The trap this file exists for: `tool_result` lives on a `user` record.
    // In the reference transcript 1,787 of 1,936 user rows were tool output, so
    // a reader that trusts `type` alone shows a conversation that is almost
    // entirely fake prompts.
    const slice = readMirror(toolResult('t1', 3));
    expect(slice.transcript.map((i) => i.kind)).toEqual(['tool_result']);
  });

  it('starts a tool step running and patches it when the result lands', () => {
    const slice = readMirror(
      [
        assistantBlocks([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 1),
        toolResult('t1', 450),
      ].join('\n'),
    );
    const step = slice.feed.find((s) => s.kind === 'tool');
    expect(step?.title).toBe('Bash');
    expect(step?.status).toBe('running');
    expect(slice.patches).toEqual([{ stepId: step?.id, patch: { status: 'ok', durMs: 449 } }]);
  });

  it('marks a failed tool call as an error', () => {
    const slice = readMirror(
      [
        assistantBlocks([{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }], 1),
        toolResult('t2', 5, { is_error: true }),
      ].join('\n'),
    );
    expect(slice.patches[0]?.patch.status).toBe('error');
  });

  it('patches a step whose result arrives in a later read', () => {
    // The reason the caller keeps `pending` across slices: a call near the end
    // of one byte range is answered in the next. Forgetting between reads
    // leaves the step stuck at `running` for the life of the session.
    const pending = new Map();
    const first = readMirror(assistantBlocks([{ type: 'tool_use', id: 't3', name: 'Read', input: {} }], 1), pending);
    expect(first.patches).toEqual([]);

    const second = readMirror(toolResult('t3', 900), pending);
    expect(second.patches).toEqual([{ stepId: first.feed[0]?.id, patch: { status: 'ok', durMs: 899 } }]);
  });

  it('says nothing about a result whose call it never saw', () => {
    // Reading from an offset part-way through a session is the normal case, so
    // an unmatched result is not a fault — there is simply no step to revise.
    const slice = readMirror(toolResult('never-seen', 5));
    expect(slice.patches).toEqual([]);
    expect(slice.transcript).toHaveLength(1);
  });

  it('skips the CLI bookkeeping, including the types that carry no timestamp', () => {
    // Nearly half the lines in a real transcript. Two of these have no
    // `timestamp` field at all, which is why the allowlist comes first: a
    // reader that parsed and then fell back would sort on NaN.
    const slice = readMirror(
      [
        line({ type: 'atis-latch', sessionId: 's', atis: {} }),
        line({ type: 'mode', sessionId: 's', mode: 'default' }),
        line({ type: 'last-prompt', sessionId: 's', lastPrompt: 'x', leafUuid: 'y' }),
        line({ type: 'queue-operation', sessionId: 's', operation: 'add', content: 'x', timestamp: at(1) }),
        line({ type: 'attachment', sessionId: 's', attachment: {}, timestamp: at(2) }),
        userText('the only real line', 3),
      ].join('\n'),
    );
    expect(slice.transcript).toHaveLength(1);
    expect(slice.transcript[0]?.text).toBe('the only real line');
  });

  it('keeps sub-agent traffic out of the parent feed', () => {
    const slice = readMirror(
      [
        assistantBlocks([{ type: 'text', text: 'searching' }], 1),
        assistantBlocks([{ type: 'text', text: 'inner step' }], 2, { isSidechain: true }),
      ].join('\n'),
    );
    expect(slice.transcript.map((i) => i.text)).toEqual(['searching']);
  });

  it('survives a corrupt line without losing the rest of the conversation', () => {
    const slice = readMirror([userText('before', 1), '{not json', userText('after', 2)].join('\n'));
    expect(slice.transcript.map((i) => i.text)).toEqual(['before', 'after']);
  });

  it('survives a line that parses to something other than an object', () => {
    // Found in review: `JSON.parse` succeeding says nothing about the shape.
    // `null`, a number and a string are all valid JSON, and reading a property
    // off the first one threw — abandoning the rest of the conversation over a
    // row this file already promises to skip.
    const slice = readMirror(
      [userText('before', 1), 'null', '42', '"a bare string"', '[]', userText('after', 2)].join('\n'),
    );
    expect(slice.transcript.map((i) => i.text)).toEqual(['before', 'after']);
  });

  it('survives a null block inside an otherwise valid message', () => {
    const slice = readMirror(
      [
        assistantBlocks([null, { type: 'text', text: 'still here' }], 1),
        line({
          type: 'user',
          uuid: 'r7',
          timestamp: at(2),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'k', content: [null, { type: 'text', text: 'kept' }] }] },
        }),
      ].join('\n'),
    );
    expect(slice.transcript.map((i) => i.text)).toEqual(['still here', 'kept']);
  });

  it('keeps a result whose content is only a reference to another tool', () => {
    // Found by running this parser over a real transcript rather than over
    // these fixtures: 42 of 1,854 results are a bare `tool_reference` standing
    // in for output recorded elsewhere. Mapping only `text` flattened them to
    // nothing, the item was dropped as empty, and the conversation skipped a
    // turn with no sign it had.
    const slice = readMirror(
      line({
        type: 'user',
        uuid: 'r8',
        timestamp: at(1),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'q', content: [{ type: 'tool_reference', tool_name: 'mcp__github__actions_list' }] },
          ],
        },
      }),
    );
    expect(slice.transcript).toHaveLength(1);
    expect(slice.transcript[0]?.text).toContain('mcp__github__actions_list');
  });

  it('emits nothing for a thinking block whose text was not retained', () => {
    // Also from the real transcript: all 889 thinking blocks carry a
    // `signature` and an empty `thinking`. An empty item is worse than none —
    // it renders as a blank turn — so the absence has to be deliberate.
    const slice = readMirror(
      assistantBlocks([{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'text', text: 'done' }], 1),
    );
    expect(slice.transcript.map((i) => i.kind)).toEqual(['assistant']);
  });

  it('flattens a tool result that arrives as blocks rather than a string', () => {
    const slice = readMirror(
      line({
        type: 'user',
        uuid: 'r9',
        timestamp: at(1),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'z',
              content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
            },
          ],
        },
      }),
    );
    expect(slice.transcript[0]?.text).toBe('line one\nline two');
  });
});
