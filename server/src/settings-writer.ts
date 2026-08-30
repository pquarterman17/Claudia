import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface AddAllowRuleResult {
  ok: boolean;
  /** Absolute path written to. Present only when ok is true. */
  path?: string;
  /** True when the rule was already present — no write was needed. */
  alreadyPresent?: boolean;
  /** User-facing reason. Present only when ok is false. */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ReadResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

async function readExisting(file: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: {} };
    return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never guess at a file we could not parse — the user's own rules could
    // sit right below the syntax error we would otherwise clobber.
    return { ok: false, error: `${file} is not valid JSON — fix or remove it, then try again.` };
  }
  if (!isRecord(parsed)) return { ok: false, error: `${file} does not contain a JSON object — refusing to modify it.` };
  return { ok: true, value: parsed };
}

/**
 * Temp sibling + fsync + rename, so a crash between those steps leaves the
 * ORIGINAL file untouched rather than a half-written one — the rename is the
 * only step observable as "done" from outside this function.
 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = join(dirname(file), `.settings.local.json.${randomUUID()}.tmp`);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Merges `rule` into `<cwd>/.claude/settings.local.json`'s permissions.allow,
 * preserving every other top-level key and every existing rule untouched.
 *
 * settings.local.json, not settings.json: the latter is the SHARED, usually
 * committed project file, and a personal one-click convenience rule has no
 * business landing in a commit. settings.local.json is the personal,
 * gitignored counterpart Claude Code already reads with HIGHER precedence,
 * so this reaches the same "stop asking" outcome without touching anything
 * checked in.
 */
export async function addAllowRule(cwd: string, rule: string): Promise<AddAllowRuleResult> {
  const dir = join(cwd, '.claude');
  const file = join(dir, 'settings.local.json');

  const existing = await readExisting(file);
  if (!existing.ok) return { ok: false, error: existing.error };

  const permissions = isRecord(existing.value['permissions']) ? existing.value['permissions'] : {};
  const allow = Array.isArray(permissions['allow']) ? (permissions['allow'] as unknown[]) : [];
  if (allow.includes(rule)) return { ok: true, path: file, alreadyPresent: true };

  const next = { ...existing.value, permissions: { ...permissions, allow: [...allow, rule] } };

  try {
    await mkdir(dir, { recursive: true });
    await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true, path: file, alreadyPresent: false };
  } catch (err) {
    return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
