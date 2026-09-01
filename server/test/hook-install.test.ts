import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countInstalled, hookBlock, hookUrl, installHooks, isInstalled, uninstallHooks, HOOK_EVENTS } from '../src/hook-install.js';

/**
 * This writer touches the owner's GLOBAL settings — every Claude Code session
 * on the machine — so the tests that matter are the ones proving what it does
 * NOT do: it never drops somebody else's hook, never writes over a file it
 * could not parse, and can put the file back exactly as it found it.
 */

const PORT = 4317;
const URL = hookUrl(PORT);

function settingsFile(contents?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-hooks-'));
  const file = join(dir, 'settings.json');
  if (contents !== undefined) writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'));
const backups = (file: string): string[] =>
  readdirSync(join(file, '..')).filter((f) => f.includes('claudia-backup'));

describe('installHooks', () => {
  it('creates a settings file that did not exist, with no backup to take', () => {
    const file = settingsFile();
    return installHooks(PORT, file).then((result) => {
      expect(result.ok).toBe(true);
      expect(result.backupPath).toBeUndefined();
      expect(result.events).toEqual([...HOOK_EVENTS]);
      expect(countInstalled(read(file), URL)).toBe(HOOK_EVENTS.length);
    });
  });

  it('keeps every other key in the file', async () => {
    const file = settingsFile({ permissions: { allow: ['Bash(ls)'] }, model: 'opus', env: { A: '1' } });
    await installHooks(PORT, file);
    const after = read(file);
    expect(after['permissions']).toEqual({ allow: ['Bash(ls)'] });
    expect(after['model']).toBe('opus');
    expect(after['env']).toEqual({ A: '1' });
  });

  it("never drops somebody else's hook on an event it also wants", async () => {
    // The owner's own Stop hook is load-bearing; silently replacing it would
    // break tooling that has nothing to do with Claudia.
    const theirs = { matcher: '', hooks: [{ type: 'command', command: '~/.claude/stop-hook-git-check.sh' }] };
    const file = settingsFile({ hooks: { Stop: [theirs] } });
    await installHooks(PORT, file);
    const stop = (read(file)['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual(theirs);
  });

  it('backs the file up before changing it', async () => {
    const original = { permissions: { allow: ['Bash(ls)'] } };
    const file = settingsFile(original);
    const result = await installHooks(PORT, file);
    expect(result.backupPath).toBeDefined();
    expect(JSON.parse(readFileSync(result.backupPath as string, 'utf8'))).toEqual(original);
  });

  it('is idempotent — a second install writes nothing and takes no backup', async () => {
    const file = settingsFile({});
    await installHooks(PORT, file);
    const before = backups(file).length;
    const again = await installHooks(PORT, file);
    expect(again).toMatchObject({ ok: true, unchanged: true, events: [] });
    expect(backups(file).length).toBe(before);
    expect(countInstalled(read(file), URL)).toBe(HOOK_EVENTS.length);
  });

  it('refuses a file it cannot parse instead of clobbering it', async () => {
    // Someone's hand-edited settings with a trailing comma should not be
    // replaced by ours — their rules live below the syntax error.
    const file = settingsFile();
    writeFileSync(file, '{ "permissions": { "allow": ["Bash(ls)"], } }');
    const result = await installHooks(PORT, file);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toContain('Bash(ls)');
    expect(backups(file)).toHaveLength(0);
  });

  it('refuses a settings file that is not an object', async () => {
    const file = settingsFile([1, 2, 3]);
    expect(await installHooks(PORT, file)).toMatchObject({ ok: false });
  });

  it('adds a handler pointing at the port it was told, not a fixed one', async () => {
    const file = settingsFile({});
    await installHooks(4319, file);
    expect(countInstalled(read(file), hookUrl(4319))).toBe(HOOK_EVENTS.length);
    expect(countInstalled(read(file), hookUrl(4317))).toBe(0);
  });
});

describe('uninstallHooks', () => {
  it('puts the file back exactly as it was', async () => {
    const original = { permissions: { allow: ['Bash(ls)'] }, model: 'opus' };
    const file = settingsFile(original);
    await installHooks(PORT, file);
    expect(read(file)).not.toEqual(original);
    await uninstallHooks(PORT, file);
    // Including removing the now-empty `hooks` key it introduced, rather than
    // leaving "Stop": [] litter behind.
    expect(read(file)).toEqual(original);
  });

  it("removes only Claudia's entry, keeping the owner's on the same event", async () => {
    const theirs = { matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] };
    const file = settingsFile({ hooks: { Stop: [theirs], SessionStart: [theirs] } });
    await installHooks(PORT, file);
    await uninstallHooks(PORT, file);
    expect(read(file)).toEqual({ hooks: { Stop: [theirs], SessionStart: [theirs] } });
  });

  it('keeps a co-tenant handler sharing one group with ours', async () => {
    // A group holding both handlers must lose ours and keep theirs, rather
    // than being dropped whole.
    const file = settingsFile({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }, { type: 'http', url: URL }] }] },
    });
    await uninstallHooks(PORT, file);
    expect(read(file)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
  });

  it('does nothing when Claudia has no hooks in the file', async () => {
    const file = settingsFile({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } });
    const result = await uninstallHooks(PORT, file);
    expect(result).toMatchObject({ ok: true, unchanged: true });
    expect(backups(file)).toHaveLength(0);
  });

  it('leaves a hookless file untouched', async () => {
    const file = settingsFile({ model: 'opus' });
    expect(await uninstallHooks(PORT, file)).toMatchObject({ ok: true, unchanged: true });
    expect(read(file)).toEqual({ model: 'opus' });
  });

  it('removes only the port it was asked about', async () => {
    const file = settingsFile({});
    await installHooks(4319, file);
    await uninstallHooks(4317, file);
    expect(countInstalled(read(file), hookUrl(4319))).toBe(HOOK_EVENTS.length);
  });
});

describe('isInstalled', () => {
  it('answers for a file that does not exist', async () => {
    expect(await isInstalled(PORT, settingsFile())).toBe(false);
  });

  it('tracks install and uninstall', async () => {
    const file = settingsFile({});
    expect(await isInstalled(PORT, file)).toBe(false);
    await installHooks(PORT, file);
    expect(await isInstalled(PORT, file)).toBe(true);
    await uninstallHooks(PORT, file);
    expect(await isInstalled(PORT, file)).toBe(false);
  });
});

describe('hookBlock', () => {
  it('is the exact JSON the UI shows before anything is written', () => {
    // The owner approved this edit on condition the change is reported back,
    // so what is shown has to BE the change, not a paraphrase.
    const block = hookBlock(PORT) as Record<string, Array<{ hooks: unknown[] }>>;
    expect(Object.keys(block)).toEqual([...HOOK_EVENTS]);
    expect(block['Stop']?.[0]?.hooks).toEqual([{ type: 'http', url: 'http://127.0.0.1:4317/hooks' }]);
  });

  it('posts only to loopback', () => {
    expect(hookUrl(4317)).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

describe('two writes in the same millisecond', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * Seen first as an intermittent failure of the uninstall test above — once in
   * eight full-suite runs, never reproducible in isolation — then pinned here
   * with a frozen clock. The backup name is a millisecond timestamp and the
   * copy is EXCL, which is right: a second run must not clobber the backup the
   * first one took. But EEXIST was a hard failure, so the second write aborted
   * having changed nothing. Install-then-uninstall is exactly that pair.
   */
  it('does not abort the second write when the backup name collides', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T01:00:00.000Z'));
    const theirs = { matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] };
    const file = settingsFile({ hooks: { Stop: [theirs], SessionStart: [theirs] } });

    expect(await installHooks(PORT, file)).toMatchObject({ ok: true });
    const removal = await uninstallHooks(PORT, file);
    // The failure this replaces: ok:false, and the user keeps hooks they asked
    // to remove — a settings.json posting to a dead port for every event in
    // every terminal they open.
    expect(removal.ok, removal.ok ? '' : removal.error).toBe(true);
    expect(read(file)).toEqual({ hooks: { Stop: [theirs], SessionStart: [theirs] } });
  });

  it('keeps both backups, so the earlier one is never overwritten', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T01:00:00.000Z'));
    const original = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    const file = settingsFile(original);

    await installHooks(PORT, file);
    await uninstallHooks(PORT, file);

    const taken = backups(file);
    expect(taken).toHaveLength(2);
    expect(new Set(taken).size).toBe(2);
    // The first backup still holds the file as it was before Claudia touched
    // anything, which is the whole promise the backup exists to keep.
    const first = taken.sort()[0];
    expect(JSON.parse(readFileSync(join(file, '..', String(first)), 'utf8'))).toEqual(original);
  });

  it('still refuses when the backup itself cannot be taken, leaving the file untouched', async () => {
    // Third attempt at this test, and the first two are the lesson.
    //
    // The original pointed through a FILE, so readExisting failed with ENOTDIR
    // and returned before takeBackup was reached — it asserted ok:false for a
    // reason unrelated to the code it named. Caught in review.
    //
    // The rewrite used a 230-character basename to blow the OS name limit. That
    // passed on Linux and FAILED ON WINDOWS, where the long name survives the
    // copy and instead blows MAX_PATH later, inside writeAtomic's temp file:
    // "Could not write ... ENOENT ... .tmp". The product refused correctly on
    // both; the test had pinned WHICH STAGE refused, and that is a property of
    // the platform. Exactly the trap the review had just pointed out.
    //
    // So the failure is now one this code owns rather than one the filesystem
    // decides: every backup name for this instant already taken, which is the
    // bound takeBackup gives up at. Deterministic on every platform.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T01:00:00.000Z'));
    const original = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    const file = settingsFile(original);
    const stamp = '2026-08-31T01-00-00-000Z';
    for (let attempt = 0; attempt < 50; attempt++) {
      writeFileSync(`${file}.claudia-backup-${stamp}${attempt === 0 ? '' : `-${attempt}`}`, 'taken');
    }

    const result = await installHooks(PORT, file);
    expect(result.ok, 'the backup must fail, not the read or the write').toBe(false);
    if (!result.ok) expect(result.error).toContain('Could not back up');
    // The promise the backup exists to keep: the owner agreed to this edit on
    // the condition the original was kept, so a backup that did not happen
    // means the edit does not happen either.
    expect(read(file)).toEqual(original);
    // And nothing it left behind: the 50 squatters, and not one more.
    expect(backups(file)).toHaveLength(50);
  });
});
