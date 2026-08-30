import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addAllowRule } from '../src/settings-writer.js';

const root = mkdtempSync(join(tmpdir(), 'claudia-settings-writer-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh, empty project directory for one test — writes never bleed across tests. */
function project(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function settingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
}

describe('addAllowRule', () => {
  it('creates .claude/settings.local.json when none exists', async () => {
    const cwd = project('fresh');
    const result = await addAllowRule(cwd, 'Bash(npm test)');
    expect(result).toMatchObject({ ok: true, alreadyPresent: false });
    const written = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash(npm test)']);
  });

  it('preserves every other top-level key untouched', async () => {
    const cwd = project('other-keys');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(cwd),
      JSON.stringify({ model: 'opus', env: { FOO: 'bar' }, permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm -rf /)'] } }),
    );

    await addAllowRule(cwd, 'Bash(npm test)');

    const written = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'));
    expect(written.model).toBe('opus');
    expect(written.env).toEqual({ FOO: 'bar' });
    expect(written.permissions.deny).toEqual(['Bash(rm -rf /)']);
    expect(written.permissions.allow).toEqual(['Bash(ls)', 'Bash(npm test)']);
  });

  it('preserves every existing allow rule verbatim, appending rather than replacing', async () => {
    const cwd = project('existing-rules');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(cwd), JSON.stringify({ permissions: { allow: ['Bash(grep:*)', 'Bash(npm run test:*)'] } }));

    await addAllowRule(cwd, 'Edit(/repo/a.ts)');

    const written = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash(grep:*)', 'Bash(npm run test:*)', 'Edit(/repo/a.ts)']);
  });

  it('does not add a rule that is already present — exact match dedupe', async () => {
    const cwd = project('dedupe');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(cwd), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));

    const result = await addAllowRule(cwd, 'Bash(npm test)');

    expect(result).toMatchObject({ ok: true, alreadyPresent: true });
    const written = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash(npm test)']); // not duplicated
  });

  it('aborts and reports an error on malformed existing JSON, never overwriting it', async () => {
    const cwd = project('malformed');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const before = '{ this is not valid json';
    writeFileSync(settingsPath(cwd), before);

    const result = await addAllowRule(cwd, 'Bash(npm test)');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not valid JSON/);
    expect(readFileSync(settingsPath(cwd), 'utf8')).toBe(before); // untouched
  });

  it('aborts when the existing file is valid JSON but not an object', async () => {
    const cwd = project('non-object');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(cwd), JSON.stringify(['not', 'an', 'object']));

    const result = await addAllowRule(cwd, 'Bash(npm test)');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not contain a JSON object/);
  });

  it('never leaves a temp file behind after a successful write', async () => {
    const cwd = project('no-leftovers');
    await addAllowRule(cwd, 'Bash(npm test)');
    const entries = readdirSync(join(cwd, '.claude'));
    expect(entries).toEqual(['settings.local.json']);
  });

  it('writes formatted, parseable JSON with a trailing newline', async () => {
    const cwd = project('formatted');
    await addAllowRule(cwd, 'Bash(npm test)');
    const raw = readFileSync(settingsPath(cwd), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('creates permissions.allow from scratch when permissions exists but has no allow array', async () => {
    const cwd = project('partial-permissions');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(cwd), JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }));

    await addAllowRule(cwd, 'Bash(npm test)');

    const written = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash(npm test)']);
    expect(written.permissions.deny).toEqual(['Bash(rm -rf /)']);
  });
});
