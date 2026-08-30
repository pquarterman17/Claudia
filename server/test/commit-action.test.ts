import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { commitAndPush, commitMessage, repoName } from '../src/commit-action.js';

/**
 * Driven against real repositories, like git-info.test.ts. What matters here is
 * what git actually does with a pathspec commit — a mocked git would only
 * assert my assumptions about that back at me, and the whole safety property of
 * this action (unrelated dirty files are NOT swept in) lives in git's behaviour.
 */

// Vitest's 5s default is sized for unit tests, and every test below drives
// real git: the heaviest spawn fifteen to twenty processes. That costs ~280ms
// here and over 5s on a Windows CI runner, where process creation is slow and
// Defender scans each new file under the temp directory — which is exactly how
// this file started timing out. Bounded, not removed: nothing here should take
// thirty seconds, so a genuine hang still fails.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const git = (dir: string, args: string[]): string =>
  // stderr dropped: `git init` warns about the default branch name and would
  // bury a real failure, which still throws, in hint text.
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Enough identity to commit, without spending a spawn to persist it. */
const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

function repo(branch = 'feat/work', withRemote = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-commit-'));
  git(dir, ['init', '--initial-branch', branch]);
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  git(dir, ['add', '.']);
  // Identity inline rather than two more `git config` spawns per repository:
  // process creation is the expensive part on Windows, and this helper runs
  // once or twice per test.
  git(dir, [...IDENTITY, 'commit', '-m', 'first']);
  if (withRemote) {
    const bare = mkdtempSync(join(tmpdir(), 'claudia-origin-'));
    git(bare, ['init', '--bare']);
    git(dir, ['remote', 'add', 'origin', bare]);
  }
  return dir;
}

const write = (dir: string, name: string, body: string): string => {
  const full = join(dir, name);
  writeFileSync(full, body);
  return full;
};

const log = (dir: string) => git(dir, ['log', '--format=%s']).split('\n');
/** Untrimmed: the status letters are two columns, and the first line of a
 * modified tracked file starts with a space that trimming would eat. */
const dirty = (dir: string): string[] =>
  execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

describe('commitAndPush', () => {
  it('commits the files a session wrote and leaves the rest of the tree alone', async () => {
    const dir = repo();
    const mine = write(dir, 'mine.txt', 'session work');
    write(dir, 'theirs.txt', 'a half-finished edit in the editor');
    writeFileSync(join(dir, 'tracked.txt'), 'also edited by hand\n');

    const result = await commitAndPush([{ cwd: dir, files: [mine], titles: ['Add a thing'] }]);

    expect(log(dir)[0]).toBe('Add a thing');
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('mine.txt');
    // The point of the whole feature: the unrelated work is still uncommitted.
    expect(dirty(dir).map((l) => l.slice(3)).sort()).toEqual(['theirs.txt', 'tracked.txt']);
    expect(result).toContain('left 2 other changed alone');
  });

  it('refuses on main, and commits nothing anywhere when it does', async () => {
    const safe = repo('feat/ok');
    const onMain = repo('main');
    const a = write(safe, 'a.txt', 'work');
    const b = write(onMain, 'b.txt', 'work');

    await expect(
      commitAndPush([
        { cwd: safe, files: [a], titles: ['Safe'] },
        { cwd: onMain, files: [b], titles: ['Risky'] },
      ]),
    ).rejects.toThrow(/main/);

    // Planned before anything is committed: the first repo must be untouched,
    // or a refusal would leave exactly the half-done state this avoids.
    expect(log(safe)).toEqual(['first']);
    expect(log(onMain)).toEqual(['first']);
  });

  it('refuses on master too, naming the repository', async () => {
    const dir = repo('master');
    const file = write(dir, 'a.txt', 'work');
    await expect(commitAndPush([{ cwd: dir, files: [file], titles: [] }])).rejects.toThrow(/master/);
  });

  it('pushes and sets an upstream the first time', async () => {
    const dir = repo();
    const file = write(dir, 'a.txt', 'work');
    const result = await commitAndPush([{ cwd: dir, files: [file], titles: ['First push'] }]);
    expect(result).toContain('pushed');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(git(dir, ['rev-parse', 'origin/feat/work']));
  });

  it('pushes a second time over the upstream it set', async () => {
    const dir = repo();
    await commitAndPush([{ cwd: dir, files: [write(dir, 'a.txt', 'one')], titles: ['One'] }]);
    const result = await commitAndPush([{ cwd: dir, files: [write(dir, 'b.txt', 'two')], titles: ['Two'] }]);
    expect(result).toContain('and pushed');
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(git(dir, ['rev-parse', 'origin/feat/work']));
  });

  it('commits without pushing when there is no remote, and says so', async () => {
    // Not a failure: the commit already made the work durable, and stopping a
    // chain over a missing remote would be stopping it over configuration.
    const dir = repo('feat/local', false);
    const result = await commitAndPush([{ cwd: dir, files: [write(dir, 'a.txt', 'work')], titles: [] }]);
    expect(result).toContain('no remote');
    expect(log(dir)[0]).toMatch(/Claudia/);
  });

  it('leaves changes the operator staged by hand staged, not committed', async () => {
    const dir = repo();
    write(dir, 'staged-by-hand.txt', 'someone was mid-commit');
    git(dir, ['add', 'staged-by-hand.txt']);

    await commitAndPush([{ cwd: dir, files: [write(dir, 'mine.txt', 'work')], titles: ['Mine'] }]);

    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('mine.txt');
    expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('staged-by-hand.txt');
  });

  it('commits a new file inside a new directory', async () => {
    // `git status` reports an untracked directory as one entry unless asked for
    // every file, and a candidate path would never match the directory.
    const dir = repo();
    mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
    const file = write(dir, join('nested', 'deep', 'new.ts'), 'export {};');
    await commitAndPush([{ cwd: dir, files: [file], titles: ['Nested'] }]);
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('nested/deep/new.ts');
  });

  it('takes paths relative to the session directory', async () => {
    const dir = repo();
    write(dir, 'rel.txt', 'work');
    await commitAndPush([{ cwd: dir, files: ['rel.txt'], titles: ['Relative'] }]);
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('rel.txt');
  });

  it('ignores a written file that lives outside the repository', async () => {
    const dir = repo();
    const outside = write(mkdtempSync(join(tmpdir(), 'claudia-elsewhere-')), 'stray.txt', 'not ours');
    const result = await commitAndPush([{ cwd: dir, files: [outside], titles: [] }]);
    expect(result).toMatch(/nothing of its own/);
    expect(log(dir)).toEqual(['first']);
  });

  it('ignores a written file that belongs to a DIFFERENT repository', async () => {
    // Sharper than a plain directory: this one is inside a repo, just not this
    // one, so "is it under the root" has to be answered by identity rather than
    // by whether some repository claims it.
    const dir = repo();
    const other = repo('feat/other');
    const result = await commitAndPush([{ cwd: dir, files: [write(other, 'theirs.txt', 'not ours')], titles: [] }]);
    expect(result).toMatch(/nothing of its own/);
    expect(log(dir)).toEqual(['first']);
    expect(log(other)).toEqual(['first']);
  });

  it('commits a file reported from a subdirectory of the repository', async () => {
    // The path git reports back is prefixed ('server/'), and that prefix has to
    // come from git rather than from arithmetic on two strings that may spell
    // the same directory differently.
    const dir = repo();
    mkdirSync(join(dir, 'server'));
    const file = write(dir, join('server', 'deep.ts'), 'export {};');
    await commitAndPush([{ cwd: join(dir, 'server'), files: [file], titles: ['Sub'] }]);
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('server/deep.ts');
  });

  it('says nothing was there rather than committing an empty change', async () => {
    const dir = repo();
    // A file the session wrote and then reverted: written, but not dirty now.
    const result = await commitAndPush([{ cwd: dir, files: [join(dir, 'tracked.txt')], titles: [] }]);
    expect(result).toMatch(/nothing of its own/);
    expect(log(dir)).toEqual(['first']);
  });

  it('reports a directory that is not a repository instead of failing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'claudia-plain-'));
    const result = await commitAndPush([{ cwd: plain, files: [write(plain, 'a.txt', 'x')], titles: [] }]);
    expect(result).toMatch(/not a git repository/);
  });

  it('refuses a detached HEAD, which has no branch to push', async () => {
    const dir = repo();
    git(dir, ['checkout', '--detach']);
    const result = await commitAndPush([{ cwd: dir, files: [write(dir, 'a.txt', 'work')], titles: [] }]);
    expect(result).toMatch(/no branch/);
    expect(log(dir)).toEqual(['first']);
  });

  it('refuses a change too large to commit unattended', async () => {
    const dir = repo();
    const files = Array.from({ length: 101 }, (_, i) => write(dir, `f${i}.txt`, String(i)));
    await expect(commitAndPush([{ cwd: dir, files, titles: [] }])).rejects.toThrow(/more than this action commits/);
    expect(log(dir)).toEqual(['first']);
  });

  it('commits sessions in two subdirectories of one repository once', async () => {
    // Grouped by repository root, not by working directory: two commits here
    // would each report the other's files as somebody's uncommitted work.
    const dir = repo();
    mkdirSync(join(dir, 'server'));
    mkdirSync(join(dir, 'web'));
    const a = write(dir, join('server', 'a.ts'), 'one');
    const b = write(dir, join('web', 'b.ts'), 'two');

    const result = await commitAndPush([
      { cwd: join(dir, 'server'), files: [a], titles: ['Server work'] },
      { cwd: join(dir, 'web'), files: [b], titles: ['Web work'] },
    ]);

    expect(log(dir)).toHaveLength(2);
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n')).toEqual(['server/a.ts', 'web/b.ts']);
    expect(result).not.toContain('left');
  });

  it('finds the repository through a symlinked working directory', async () => {
    // git reports the physical root; a session's cwd is whatever the user
    // typed, and on macOS that is routinely a symlink. Comparing the two
    // directly makes every file look as though it were outside the repo.
    const dir = repo();
    const link = join(mkdtempSync(join(tmpdir(), 'claudia-link-')), 'repo');
    symlinkSync(dir, link);
    write(dir, 'a.txt', 'work');

    await commitAndPush([{ cwd: link, files: [join(link, 'a.txt')], titles: ['Through a link'] }]);
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('a.txt');
  });

  it('commits the first change in a repository that has no commits yet', async () => {
    // An unborn branch cannot be read with rev-parse, but committing onto it
    // works fine — refusing here would be refusing over the wrong question.
    const dir = mkdtempSync(join(tmpdir(), 'claudia-fresh-'));
    git(dir, ['init', '--initial-branch', 'feat/first']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    // Persisted here on purpose: commitAndPush does the committing in this
    // test, so the identity has to outlive the setup.
    await commitAndPush([{ cwd: dir, files: [write(dir, 'a.txt', 'work')], titles: ['First ever'] }]);
    expect(log(dir)).toEqual(['First ever']);
  });

  it('does nothing at all when no session wrote anything', async () => {
    const dir = repo();
    write(dir, 'someone-elses.txt', 'not from a session');
    expect(await commitAndPush([{ cwd: dir, files: [], titles: ['Read-only session'] }])).toBe('Nothing to commit');
    expect(dirty(dir)).toHaveLength(1);
  });

  it('commits several sessions in one repository as one commit', async () => {
    const dir = repo();
    const a = write(dir, 'a.txt', 'from one');
    const b = write(dir, 'b.txt', 'from two');
    await commitAndPush([{ cwd: dir, files: [a, b], titles: ['Session one', 'Session two'] }]);
    expect(log(dir)).toHaveLength(2);
    expect(git(dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n')).toEqual(['a.txt', 'b.txt']);
  });
});

describe('commitMessage', () => {
  it('uses a single session title as the subject', () => {
    const message = commitMessage({ titles: ['Add the commit finish action'], paths: ['a.ts'] });
    expect(message.split('\n')[0]).toBe('Add the commit finish action');
    expect(message).toContain('1 file');
  });

  it('lists every session when more than one contributed', () => {
    const message = commitMessage({ titles: ['One', 'Two'], paths: ['a.ts', 'b.ts'] });
    expect(message.split('\n')[0]).toBe('Claudia: work from 2 sessions');
    expect(message).toContain('- One');
    expect(message).toContain('- Two');
  });

  it('still writes a subject when no session had a title yet', () => {
    expect(commitMessage({ titles: [], paths: ['a.ts'] }).split('\n')[0]).toBe('Claudia: work from a session');
  });

  it('keeps the subject to one clamped line', () => {
    const message = commitMessage({ titles: [`${'x'.repeat(200)}\nsecond line`], paths: ['a.ts'] });
    const subject = message.split('\n')[0] ?? '';
    expect(subject.length).toBeLessThanOrEqual(72);
  });
});

describe('repoName', () => {
  it('reads the last segment whichever separator the caller used', () => {
    // Both appear on Windows in the same run: git reports a forward-slashed
    // root, the folder picker returns backslashes.
    expect(repoName('C:\\Users\\p\\Claudia')).toBe('Claudia');
    expect(repoName('C:/Users/p/Claudia')).toBe('Claudia');
    expect(repoName('/home/p/Claudia')).toBe('Claudia');
  });

  it('ignores a trailing separator', () => {
    expect(repoName('/home/p/Claudia/')).toBe('Claudia');
    expect(repoName('C:\\Users\\p\\Claudia\\')).toBe('Claudia');
  });

  it('falls back to the whole string when there is nothing to split', () => {
    expect(repoName('Claudia')).toBe('Claudia');
    expect(repoName('')).toBe('');
  });
});
