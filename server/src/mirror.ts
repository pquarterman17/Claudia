import { createReadStream } from 'node:fs';
import type { FeedStep, FeedStepPatch, TranscriptItem } from '@claudia/shared';
import { readMirror } from './observed-transcript.js';
import { recentTranscripts } from './transcript-files.js';

/**
 * Following one session Claudia does not own, while somebody is looking at it.
 *
 * The hook stream (`hook-monitor.ts`) says what such a session is DOING; it
 * cannot say what the session said, because a payload carries a tool name and
 * a truncated prompt. This reads the conversation out of the transcript, which
 * `transcript-files.ts` already knows how to find and `observed-transcript.ts`
 * already knows how to parse.
 *
 * Two channels, two jobs, and neither replaces the other. Hooks stay the
 * liveness signal and are the ONLY source of `needs_you`, because a session
 * blocked on a permission prompt writes nothing to its log while it waits.
 * This is the detail signal. When they disagree — and briefly they will, since
 * a hook arrives before the line it describes is flushed — hooks win on state
 * and the transcript wins on content.
 *
 * Per subscription rather than a sweep. The usage reader sweeps because it
 * wants totals across the machine; a mirror wants one conversation, so this
 * reads only while a client is watching and stops when it lets go.
 */

/** Steps kept in the opening backlog. A 9,616-line transcript is not a payload. */
const BACKLOG = 200;

/** Bytes read per poll, so one enormous catch-up cannot block the loop. */
const CHUNK = 2 * 1024 * 1024;

export interface MirrorSink {
  opened(sessionId: string, backlog: { transcript: TranscriptItem[]; feed: FeedStep[]; elided: number }): void;
  step(sessionId: string, step: FeedStep): void;
  item(sessionId: string, item: TranscriptItem): void;
  patch(sessionId: string, stepId: string, patch: FeedStepPatch): void;
  unavailable(sessionId: string, reason: string): void;
}

interface Watch {
  path: string;
  offset: number;
  /** Tool calls whose results have not arrived yet, kept ACROSS reads: a call
   * near the end of one byte range is answered in the next, and forgetting
   * between polls would leave the step running for the life of the session. */
  pending: Map<string, { stepId: string; ts: number }>;
}

export class MirrorService {
  private readonly watching = new Map<string, Watch>();
  private reading = false;

  constructor(
    private readonly sink: MirrorSink,
    private readonly projectsDir?: string,
  ) {}

  get size(): number {
    return this.watching.size;
  }

  /** Begins following a session, and sends whatever it has so far. */
  async open(sessionId: string): Promise<void> {
    if (this.watching.has(sessionId)) return;
    const found = await this.locate(sessionId);
    if (!found) {
      // Not an error. A session on another machine — or on the web, like the
      // one that wrote this — has no local log and never will, and saying so
      // is more use than a failure a viewer cannot act on.
      this.sink.unavailable(sessionId, 'no transcript for that session on this machine');
      return;
    }

    const watch: Watch = { path: found.path, offset: 0, pending: new Map() };
    const slice = await this.read(watch, found.size);
    if (!slice) {
      this.sink.unavailable(sessionId, 'that transcript could not be read');
      return;
    }
    this.watching.set(sessionId, watch);
    // Tail-first: the last N steps, and how many were cut, so a partial
    // conversation is not mistaken for a whole one.
    const elided = Math.max(0, slice.feed.length - BACKLOG);
    this.sink.opened(sessionId, {
      transcript: slice.transcript.slice(-BACKLOG),
      feed: slice.feed.slice(-BACKLOG),
      elided,
    });
    for (const { stepId, patch } of slice.patches) this.sink.patch(sessionId, stepId, patch);
  }

  close(sessionId: string): void {
    this.watching.delete(sessionId);
  }

  closeAll(): void {
    this.watching.clear();
  }

  /**
   * Reads whatever has been appended to every watched transcript.
   *
   * Guarded against re-entry, because the caller is a timer that does not wait:
   * a slow read would otherwise have a second pass start from the same offset
   * and send every step twice.
   */
  async poll(): Promise<void> {
    if (this.reading || this.watching.size === 0) return;
    this.reading = true;
    try {
      for (const [sessionId, watch] of [...this.watching]) {
        const size = await this.sizeOf(watch.path);
        if (size === undefined || size <= watch.offset) continue;
        const slice = await this.read(watch, size);
        if (!slice) continue;
        for (const item of slice.transcript) this.sink.item(sessionId, item);
        for (const step of slice.feed) this.sink.step(sessionId, step);
        for (const { stepId, patch } of slice.patches) this.sink.patch(sessionId, stepId, patch);
      }
    } finally {
      this.reading = false;
    }
  }

  /** Reads to the last complete line and advances the offset by real bytes. */
  private async read(watch: Watch, size: number): Promise<ReturnType<typeof readMirror> | undefined> {
    const end = Math.min(size, watch.offset + CHUNK);
    if (end <= watch.offset) return undefined;
    let bytes: Buffer;
    try {
      bytes = await collect(watch.path, watch.offset, end);
    } catch {
      return undefined;
    }
    // Kept as BYTES the whole way. The usage reader learned this the hard way:
    // decoding a range that ends mid-character yields U+FFFD, which does not
    // re-encode to the length that was read, so an offset measured off the
    // decoded text drifts and can go negative. Stop at the last complete line,
    // found in the raw buffer, and decode only what is behind it.
    const lastBreak = bytes.lastIndexOf(0x0a);
    if (lastBreak === -1) return undefined;
    watch.offset += lastBreak + 1;
    return readMirror(bytes.subarray(0, lastBreak).toString('utf8'), watch.pending);
  }

  private async locate(sessionId: string): Promise<{ path: string; size: number } | undefined> {
    const files = await recentTranscripts(this.projectsDir);
    return files.find((file) => file.sessionId === sessionId);
  }

  private async sizeOf(path: string): Promise<number | undefined> {
    const { stat } = await import('node:fs/promises');
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  }
}

async function collect(path: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start, end: end - 1 })) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
