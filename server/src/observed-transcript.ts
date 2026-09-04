import type { FeedStep, FeedStepPatch, TranscriptItem } from '@claudia/shared';

/**
 * Reading one session's conversation out of the log Claude Code writes.
 *
 * The hook stream (`hook-monitor.ts`) says what a session Claudia does not own
 * is DOING; it cannot say what the session said, because a hook payload carries
 * a tool name and a truncated prompt and nothing else. The transcript is where
 * the content is, and `transcript-files.ts` already knows where to find it.
 *
 * Pure and synchronous over a string, deliberately. Everything else that reads
 * these files needed a live CLI to verify; a parser that takes text and returns
 * values can be pinned against a fixture instead. The caller owns the file
 * handle, the byte offsets and the schedule.
 *
 * Every shape below was READ OFF A REAL 9,616-LINE TRANSCRIPT rather than taken
 * from documentation, which is the same discipline `hook-monitor.ts` used after
 * finding four documented field names wrong.
 */

/**
 * Record types that carry conversation. Everything else in the file is the
 * CLI's own bookkeeping — `attachment`, `queue-operation`, `atis-latch`,
 * `mode`, `last-prompt` — and it is nearly half the lines, so this is an
 * allowlist rather than a denylist. Several of those types carry no
 * `timestamp` at all, which is the other reason not to attempt them: a reader
 * that tries and falls back produces NaN sort keys instead of skipping.
 */
const CONVERSATION = new Set(['user', 'assistant']);

/** Longest single item kept, so one enormous tool result cannot dominate. */
const TEXT_LIMIT = 20_000;

export interface MirrorSlice {
  transcript: TranscriptItem[];
  feed: FeedStep[];
  /** Revisions to steps emitted EARLIER, possibly in a previous slice. */
  patches: Array<{ stepId: string; patch: FeedStepPatch }>;
}

interface PendingTool {
  stepId: string;
  ts: number;
}

/**
 * Parses complete lines into transcript items and feed steps.
 *
 * `pending` carries the tool calls whose results have not arrived yet, and the
 * caller keeps it across slices: a `tool_use` near the end of one read is
 * answered by a `tool_result` in the next, and a parser that forgot between
 * calls would leave every such step stuck at `running` forever. This is the
 * same lifecycle an owned session's feed already has, which is the point —
 * a mirrored step should not be visibly second-class.
 */
export function readMirror(text: string, pending: Map<string, PendingTool> = new Map()): MirrorSlice {
  const slice: MirrorSlice = { transcript: [], feed: [], patches: [] };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A line this caller believed complete but is not valid JSON. Skipping it
      // is right: the alternative is abandoning the rest of a conversation over
      // one bad row, which `events.ts` already made the opposite call about and
      // says why.
      continue;
    }
    if (!CONVERSATION.has(String(record['type']))) continue;
    // Sub-agent traffic. Excluded rather than interleaved: it belongs under the
    // Task step that spawned it, and flattening it into the main feed makes a
    // parallel search read as the parent losing its place.
    if (record['isSidechain'] === true) continue;
    const ts = Date.parse(String(record['timestamp'] ?? ''));
    if (Number.isNaN(ts)) continue;
    ingest(record, ts, slice, pending);
  }
  return slice;
}

function ingest(
  record: Record<string, unknown>,
  ts: number,
  slice: MirrorSlice,
  pending: Map<string, PendingTool>,
): void {
  const role = String(record['type']);
  const message = record['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  const uuid = String(record['uuid'] ?? `${ts}`);

  // A bare string is how a typed prompt arrives; the block form is how
  // everything else does. Both are `user` records, which is the trap:
  // `tool_result` lives on a `user` record too, and 1,787 of the 1,936 user
  // rows in the reference transcript were tool output rather than anything a
  // human typed.
  if (typeof content === 'string') {
    push(slice, ts, 'user', content);
    slice.feed.push({ id: `${uuid}:prompt`, ts, kind: 'text', title: clamp(content, 120) });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const [index, raw] of content.entries()) {
    const block = raw as Record<string, unknown>;
    const id = `${uuid}:${index}`;
    switch (String(block['type'])) {
      case 'text': {
        const body = String(block['text'] ?? '');
        push(slice, ts, role === 'assistant' ? 'assistant' : 'user', body);
        slice.feed.push({ id, ts, kind: 'text', title: clamp(body, 120) });
        break;
      }
      case 'thinking': {
        // Often EMPTY, and that is not a parse failure. Every one of the 889
        // thinking blocks in the reference transcript carries a `signature` and
        // an empty `thinking`, because the text is not retained in the log. So
        // this emits an item only when there is something to show, and a UI
        // built on the assumption that a mirrored session displays its
        // reasoning would show an empty panel on real data.
        push(slice, ts, 'thinking', String(block['thinking'] ?? ''));
        break;
      }
      case 'tool_use': {
        const name = String(block['name'] ?? 'tool');
        push(slice, ts, 'tool_use', JSON.stringify(block['input'] ?? {}), name);
        slice.feed.push({ id, ts, kind: 'tool', title: name, status: 'running' });
        const key = String(block['id'] ?? '');
        if (key) pending.set(key, { stepId: id, ts });
        break;
      }
      case 'tool_result': {
        const body = flatten(block['content']);
        push(slice, ts, 'tool_result', body);
        // Patched onto the step that started it, wherever that was. An
        // unmatched result means the call itself was before this reader's
        // window, so there is no step to revise and nothing to say about it.
        const started = pending.get(String(block['tool_use_id'] ?? ''));
        if (!started) break;
        pending.delete(String(block['tool_use_id'] ?? ''));
        slice.patches.push({
          stepId: started.stepId,
          patch: { status: block['is_error'] === true ? 'error' : 'ok', durMs: Math.max(0, ts - started.ts) },
        });
        break;
      }
      default:
        break;
    }
  }
}

function push(slice: MirrorSlice, ts: number, kind: TranscriptItem['kind'], text: string, toolName?: string): void {
  if (!text) return;
  slice.transcript.push({ ts, kind, text: text.slice(0, TEXT_LIMIT), ...(toolName ? { toolName } : {}) });
}

/**
 * Tool results arrive as a string or as a list of blocks; both reduce to text.
 *
 * `tool_reference` is handled because leaving it out lost results silently:
 * 42 of the 1,854 results in the reference transcript are a bare
 * `{ type: 'tool_reference', tool_name }` standing in for output recorded
 * elsewhere, and a mapper that only knew `text` flattened them to nothing, so
 * `push` dropped the item and the conversation skipped a turn with no sign it
 * had. Naming the tool is not the output, but it is the difference between a
 * gap and a gap you can see.
 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const block = raw as Record<string, unknown>;
      if (block['type'] === 'text') return String(block['text'] ?? '');
      if (block['type'] === 'tool_reference') return `(result of ${String(block['tool_name'] ?? 'a tool')})`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function clamp(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
