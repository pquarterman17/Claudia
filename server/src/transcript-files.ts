import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code's own session logs live, and which of them are worth opening.
 *
 * Lifted out of `usage-reader.ts` when a second reader needed the same walk.
 * One definition, because the two consumers disagree about everything EXCEPT
 * this: the usage reader sums tokens across every session on the machine, and
 * the transcript reader reconstructs one conversation. Both start by asking the
 * same question — which files are these, and which are recent enough to matter.
 *
 * A session id is a file name: `<projects>/<encoded-cwd>/<session-id>.jsonl`.
 * That is what lets a hook payload, which carries only `session_id`, be joined
 * to the transcript of the session that sent it.
 */

export const PROJECTS_DIR = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects');

/** Only files touched within this horizon are worth reading at all. */
export const HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

export interface TranscriptFile {
  path: string;
  size: number;
  /** The session id, which is the file's own name. */
  sessionId: string;
}

/**
 * Every recently-touched transcript under `projectsDir`.
 *
 * Cold files are skipped by mtime rather than opened and rejected: most of the
 * hundreds of megabytes here is history nothing will ever ask about, and the
 * cheapest way to not read it is to not stat past it.
 *
 * Nothing throws. These are files written by another process, so one that
 * vanishes mid-scan, or a directory that cannot be read, is an ordinary event
 * and not a reason to fail the walk — let alone to take down a server whose
 * other features have never needed them.
 */
export async function recentTranscripts(
  projectsDir: string = PROJECTS_DIR,
  now = Date.now(),
  horizonMs = HORIZON_MS,
): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return out; // no Claude Code history on this machine yet
  }
  for (const project of projects) {
    const dir = join(projectsDir, project);
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
        if (now - info.mtimeMs > horizonMs) continue;
        out.push({ path, size: info.size, sessionId: entry.slice(0, -'.jsonl'.length) });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out;
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
