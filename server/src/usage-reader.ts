import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { UsageStore } from './usage-store.js';

const PROJECTS_DIR = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects');

/** Only files touched within this horizon are worth reading at all. */
const HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

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
      for (const file of await this.recentFiles(now)) {
        await this.readIncrementally(file.path, file.size);
      }
      this.store.prune(now);
      this.lastScan = now;
    } finally {
      this.scanning = false;
    }
  }

  private async recentFiles(now: number): Promise<Array<{ path: string; size: number }>> {
    const out: Array<{ path: string; size: number }> = [];
    let projects: string[];
    try {
      projects = await readdir(PROJECTS_DIR);
    } catch {
      return out; // no Claude Code history on this machine yet
    }
    for (const project of projects) {
      const dir = join(PROJECTS_DIR, project);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const path = join(dir, entry);
        try {
          const info = await stat(path);
          // Skip cold files outright — most of the 736 MB is history we never need.
          if (now - info.mtimeMs > HORIZON_MS) continue;
          out.push({ path, size: info.size });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
    return out;
  }

  private async readIncrementally(path: string, size: number): Promise<void> {
    const previous = this.offsets.get(path) ?? 0;
    // A shrunk file means it was rotated or rewritten; start over.
    const start = size < previous ? 0 : previous;
    if (size === start) return;
    this.offsets.set(path, size);

    const project = decodeProject(path);
    const stream = createReadStream(path, { start, end: size - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      // Cheap pre-filter: JSON.parse on every line of 81 MB would dominate.
      if (!line.includes('"usage"')) continue;
      this.ingest(line, project);
    }
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

/**
 * Claude Code encodes a project's path into the directory name by replacing
 * separators with dashes, which is lossy — so show the tail, which is the part
 * a human recognises.
 */
export function decodeProject(path: string): string {
  const parts = path.split(/[\\/]/);
  const dir = parts[parts.length - 2] ?? 'unknown';
  const segments = dir.split('-').filter(Boolean);
  return segments.slice(-2).join('/') || dir;
}
