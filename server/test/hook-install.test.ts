import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
