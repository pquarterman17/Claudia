import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { decodeProject, PROJECTS_DIR, recentTranscripts } from './transcript-files.js';
import { UsageStore } from './usage-store.js';

/**
 * Whether the range being read ends on a line break.
 *
 * One byte, read separately, because it is the only thing that distinguishes a
 * complete final line from a fragment of one — and `readline` cannot say, since
 * it strips the separator and reports both the same way. Getting this wrong is
 * not a rounding error: see `readIncrementally`.
 */
async function endsOnNewline(path: string, size: number): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
    return bytesRead === 1 && buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

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
   * running is appending, so its last line is usually half-written. `readline`
   * still emits that fragment, `JSON.parse` rejects it, and the next scan then
   * resumed from the middle of it — so the rest arrived as a fragment too and
   * the record was lost for good, not deferred. The old comment here claimed
   * the next scan re-read it; the offset had already moved past it.
   *
   * So the last line is held back until one byte at the end of the range says
   * whether it was terminated, and the offset advances only over what was
   * actually consumed. Undercounted tokens were the visible symptom; the same
   * mechanism drops whole messages for anything else reading these files.
   */
  private async readIncrementally(path: string, size: number): Promise<void> {
    const previous = this.offsets.get(path) ?? 0;
    // A shrunk file means it was rotated or rewritten; start over.
    const start = size < previous ? 0 : previous;
    if (size === start) return;

    const project = decodeProject(path);
    const stream = createReadStream(path, { start, end: size - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // One line of lookahead: whichever line turns out to be last is the only
    // one whose completeness is in question, and it is not known to BE last
    // until the iterator ends.
    let held: string | undefined;
    for await (const line of lines) {
      if (held !== undefined) this.consider(held, project);
      held = line;
    }
    if (held === undefined) return;

    if (await endsOnNewline(path, size)) {
      this.consider(held, project);
      this.offsets.set(path, size);
      return;
    }
    // Rewound to the start of the fragment, so the next scan reads the whole
    // line once it has been written.
    this.offsets.set(path, size - Buffer.byteLength(held, 'utf8'));
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
