import { createReadStream } from 'node:fs';
import { decodeProject, PROJECTS_DIR, recentTranscripts } from './transcript-files.js';
import { UsageStore } from './usage-store.js';

const NEWLINE = 0x0a;
const EMPTY: Buffer<ArrayBufferLike> = Buffer.alloc(0);

/**
 * Reads token usage out of Claude Code's own session logs.
 *
 * This covers every session on the machine, not just Claudia-owned ones, so the
 * numbers reflect terminal work too.
 *
 * Two things make it affordable: the logs here total 736 MB with a single 64 MB
 * file, so files are streamed line by line and never read whole, and because
 * JSONL is append-only each file is resumed from the byte offset last read
 * instead of being re-parsed. Steady state costs almost nothing.
 *
 * Note the usage in these logs is trustworthy — unlike the SDK's streaming
 * assistant messages, whose output_tokens is a placeholder. Verified on a real
 * session: median 418 output tokens per message, no placeholder values.
 */
export class UsageReader {
  readonly store = new UsageStore();
  private offsets = new Map<string, number>();
  private scanning = false;
  private lastScan = 0;

  /** The projects directory to walk. Injectable so a test can point at a
   * fixture rather than at whatever this machine happens to have logged. */
  constructor(private readonly projectsDir: string = PROJECTS_DIR) {}

  get scannedAt(): number {
    return this.lastScan;
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  async scan(now = Date.now()): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const file of await recentTranscripts(this.projectsDir, now)) {
        await this.readIncrementally(file.path, file.size);
      }
      this.store.prune(now);
      this.lastScan = now;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Reads the bytes appended since last time, and stops at the last COMPLETE line.
   *
   * The offset used to be advanced to the file size before reading. That is
   * wrong for exactly the files this class exists to follow: a session still
   * running is appending, so its last line is usually half-written. The
   * fragment failed to parse and the next scan resumed from the middle of it,
   * so the rest arrived as a fragment too and the record was lost for good.
   *
   * The split is found in RAW BYTES rather than by measuring decoded text.
   * Found in review, and the second defect in the same three lines: a read that
   * ends partway through a multi-byte character has that trailing fragment
   * replaced by U+FFFD, which re-encodes to a different length than was read —
   * so `size - Buffer.byteLength(fragment)` was not the start of the fragment,
   * and on a four-byte character it went negative and `createReadStream` threw.
   * A file that hit that could never be scanned again. Counting the bytes of
   * the lines actually consumed cannot drift, because it never converts back.
   */
  private async readIncrementally(path: string, size: number): Promise<void> {
    const previous = this.offsets.get(path) ?? 0;
    // A shrunk file means it was rotated or rewritten; start over.
    const start = size < previous ? 0 : previous;
    if (size === start) return;

    const project = decodeProject(path);
    // No encoding, so chunks arrive as Buffers and every position below is a
    // byte position. Still streamed: what is held is one unfinished line, not
    // the delta.
    const stream = createReadStream(path, { start, end: size - 1 });
    let consumed = start;
    let rest: Buffer<ArrayBufferLike> = EMPTY;
    for await (const chunk of stream) {
      const buffer: Buffer<ArrayBufferLike> = rest.length === 0 ? (chunk as Buffer) : Buffer.concat([rest, chunk as Buffer]);
      let from = 0;
      for (let brk = buffer.indexOf(NEWLINE, from); brk !== -1; brk = buffer.indexOf(NEWLINE, from)) {
        this.consider(buffer.subarray(from, brk).toString('utf8'), project);
        consumed += brk - from + 1;
        from = brk + 1;
      }
      rest = buffer.subarray(from);
    }
    // `rest` is an unterminated line, so its bytes are deliberately not counted:
    // the next scan reads it whole once it has been written.
    this.offsets.set(path, consumed);
  }

  /** Cheap pre-filter: JSON.parse on every line of 81 MB would dominate. */
  private consider(line: string, project: string): void {
    if (line.includes('"usage"')) this.ingest(line, project);
  }

  private ingest(line: string, project: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // a partially-written trailing line; the next scan re-reads it
    }
    const message = parsed['message'] as Record<string, unknown> | undefined;
    const usage = message?.['usage'] as Record<string, unknown> | undefined;
    if (!usage) return;
    const ts = Date.parse(String(parsed['timestamp'] ?? ''));
    if (Number.isNaN(ts)) return;

    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    this.store.add({
      ts,
      project,
      model: String(message?.['model'] ?? 'unknown'),
      inputTokens: num(usage['input_tokens']),
      outputTokens: num(usage['output_tokens']),
      cacheReadTokens: num(usage['cache_read_input_tokens']),
      cacheCreationTokens: num(usage['cache_creation_input_tokens']),
    });
  }
}
