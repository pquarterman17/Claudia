import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readExisting, writeAtomic } from './settings-writer.js';

/**
 * Installing (and removing) the global hook that lets Claudia see terminal
 * sessions it did not launch.
 *
 * This edits the owner's GLOBAL `~/.claude/settings.json` — every Claude Code
 * session on the machine, not just Claudia's — so it is deliberately the most
 * conservative writer in this codebase. It copies the file aside before the
 * first change, preserves every other key and every hook it did not add,
 * refuses outright on a file it cannot parse, and can undo itself exactly.
 *
 * The handler is `type: "http"`, VERIFIED live against claude-code 2.1.251 by
 * pointing one at a local sink and watching real payloads arrive. That matters
 * more than it sounds: the alternative is a `type: "command"` handler running a
 * shell script, which would mean shipping and maintaining a bash script AND a
 * PowerShell one, and getting quoting right on both. An http handler is plain
 * JSON and works the same on all three platforms.
 */

/**
 * The events worth waking the board for.
 *
 * Not every event Claude Code offers: MessageDisplay fires per streamed chunk
 * and PostToolBatch adds nothing these seven do not already say. Each one here
 * changes what a tile shows.
 *
 * NOTE on SessionStart: over the http handler it did not arrive in a live
 * probe, though it did over a command handler. It is still requested — it costs
 * nothing and is the cleanest "a session appeared" signal when it does fire —
 * but nothing depends on it: a tile is created by whichever event arrives first.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

export interface HookChange {
  ok: boolean;
  /** The file that was (or would be) written. */
  path: string;
  /** Where the previous file was copied, when one existed and was changed. */
  backupPath?: string;
  /** Events whose hook was added or removed by this call. */
  events?: string[];
  /** True when the file already said what was asked, so nothing was written. */
  unchanged?: boolean;
  error?: string;
}

/** Where Claudia listens for hook payloads. Also the marker that identifies
 * Claudia's own hook entries: an entry pointing here is ours, and nothing else
 * in the file is ever touched. */
export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`;
}

export function globalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** The exact JSON Claudia adds, for showing the user before it is written.
 * The owner approved this edit on the condition the change is reported back,
 * so the UI shows this verbatim rather than a paraphrase of it. */
export function hookBlock(port: number): Record<string, unknown> {
  const handler = { type: 'http', url: hookUrl(port) };
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [handler] }]]));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Whether one handler entry is Claudia's, by the URL it posts to. */
function isOurs(handler: unknown, url: string): boolean {
  return isRecord(handler) && handler['type'] === 'http' && handler['url'] === url;
}

/** How many of Claudia's hook entries the file currently holds. */
export function countInstalled(settings: Record<string, unknown>, url: string): number {
  const hooks = isRecord(settings['hooks']) ? settings['hooks'] : {};
  let found = 0;
  for (const event of HOOK_EVENTS) {
    for (const group of asArray(hooks[event])) {
      if (isRecord(group) && asArray(group['hooks']).some((h) => isOurs(h, url))) found += 1;
    }
  }
  return found;
}

export async function isInstalled(port: number, file = globalSettingsPath()): Promise<boolean> {
  const existing = await readExisting(file);
  // An unreadable file is not an installed one, and this is only ever used to
  // decide what to show — install() re-reads and reports the real error.
  return existing.ok && countInstalled(existing.value, hookUrl(port)) > 0;
}

/**
 * Adds Claudia's hook to every event it wants, leaving everything else alone.
 *
 * Existing hooks on the same events are PRESERVED: the new handler joins the
 * event's list rather than replacing it, because the owner's own hooks on
 * Stop and SessionStart are load-bearing and silently dropping them would
 * break tooling that has nothing to do with Claudia.
 */
export async function installHooks(port: number, file = globalSettingsPath()): Promise<HookChange> {
  const url = hookUrl(port);
  const existing = await readExisting(file);
  if (!existing.ok) return { ok: false, path: file, error: existing.error };

  const hooks: Record<string, unknown> = isRecord(existing.value['hooks'])
    ? { ...existing.value['hooks'] }
    : {};
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = asArray(hooks[event]);
    if (groups.some((g) => isRecord(g) && asArray(g['hooks']).some((h) => isOurs(h, url)))) continue;
    hooks[event] = [...groups, { hooks: [{ type: 'http', url }] }];
    added.push(event);
  }
  if (added.length === 0) return { ok: true, path: file, unchanged: true, events: [] };

  return write(file, { ...existing.value, hooks }, added);
}

/**
 * Removes exactly the entries Claudia added, and nothing else.
 *
 * Empty containers are cleaned up as it goes, so uninstalling leaves the file
 * as it was rather than littered with `"Stop": []` — but a `hooks` key that
 * still holds someone else's hook is left in place.
 */
export async function uninstallHooks(port: number, file = globalSettingsPath()): Promise<HookChange> {
  const url = hookUrl(port);
  const existing = await readExisting(file);
  if (!existing.ok) return { ok: false, path: file, error: existing.error };
  if (!isRecord(existing.value['hooks'])) return { ok: true, path: file, unchanged: true, events: [] };

  const hooks: Record<string, unknown> = { ...existing.value['hooks'] };
  const removed: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = asArray(hooks[event]);
    if (groups.length === 0) continue;
    // Tracked explicitly rather than inferred from the group count: a group we
    // EDITED (our handler removed, someone else's kept) leaves the count
    // unchanged, so counting would silently discard that edit and leave our
    // handler in the file.
    let touched = false;
    const kept = groups
      .map((group) => {
        if (!isRecord(group)) return group;
        const handlers = asArray(group['hooks']);
        const survivors = handlers.filter((h) => !isOurs(h, url));
        if (survivors.length === handlers.length) return group;
        touched = true;
        // A group that held only our handler goes entirely; one that also held
        // someone else's keeps theirs.
        return survivors.length > 0 ? { ...group, hooks: survivors } : null;
      })
      .filter((g) => g !== null);
    if (!touched) continue;
    removed.push(event);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed.length === 0) return { ok: true, path: file, unchanged: true, events: [] };

  const next = { ...existing.value };
  if (Object.keys(hooks).length > 0) next['hooks'] = hooks;
  else delete next['hooks'];
  return write(file, next, removed);
}

/**
 * Backs the file up, then writes.
 *
 * The copy happens BEFORE the write and its failure aborts the whole thing:
 * the owner agreed to this edit on the condition the original was kept, so a
 * backup that did not happen is not a detail to report afterwards. A file that
 * does not exist yet needs no backup — there is nothing to lose, and creating
 * an empty one to copy would be theatre.
 */
async function write(file: string, next: Record<string, unknown>, events: string[]): Promise<HookChange> {
  const backup = await takeBackup(file);
  if (backup.ok === false) return { ok: false, path: file, error: backup.error };
  const backupPath = backup.path;

  try {
    await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true, path: file, events, ...(backupPath ? { backupPath } : {}) };
  } catch (err) {
    return { ok: false, path: file, error: `Could not write ${file}: ${message(err)}`, ...(backupPath ? { backupPath } : {}) };
  }
}

/**
 * Copies the file aside without ever overwriting a backup already there.
 *
 * The name is a millisecond timestamp and the copy is EXCL, which was the
 * right instinct — a second run must not clobber the backup the first one just
 * took — but EEXIST was then treated as a hard failure, so two writes landing
 * in the SAME millisecond aborted the second one entirely. Install followed by
 * uninstall is exactly that pair, and the uninstall returned ok:false having
 * changed nothing: the user removes Claudia's hooks and keeps them, so a
 * global settings.json goes on POSTing to a port nothing is listening on for
 * every event in every terminal they open. Seen once as an intermittent test
 * failure, then reproduced deterministically with a frozen clock.
 *
 * A collision is not a reason to refuse the edit, only a reason to pick
 * another name. Bounded, because a directory that will not accept any name is
 * a real failure and must not become a loop.
 */
async function takeBackup(file: string): Promise<{ ok: true; path?: string } | { ok: false; error: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `${file}.claudia-backup-${stamp}${attempt === 0 ? '' : `-${attempt}`}`;
    try {
      await copyFile(file, candidate, 1 /* COPYFILE_EXCL */);
      return { ok: true, path: candidate };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Nothing to back up: the file does not exist yet, and creating an empty
      // one to copy would be theatre.
      if (code === 'ENOENT') return { ok: true };
      if (code !== 'EEXIST') return { ok: false, error: `Could not back up ${file}: ${message(err)}` };
    }
  }
  return { ok: false, error: `Could not back up ${file}: 50 backups already exist for this moment.` };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
