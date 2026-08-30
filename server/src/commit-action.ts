import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Branches this action will not commit to, ever.
 *
 * The owner's standing rule is branch-before-implement: work happens on a
 * feature branch and main is reached by a deliberate merge. An unattended
 * commit onto main would quietly break that, and it is the one mistake here
 * that a human cannot easily undo once it has been pushed.
 */
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * Above this, stop and let a human look. A session that changed 150 files did
 * something structural — a rename sweep, a generated bundle — and that is not
 * the kind of change to commit and push while nobody is watching.
 */
const MAX_FILES = 100;

/** What one directory's sessions changed, gathered by the session manager. */
export interface RepoWork {
  cwd: string;
  /** Paths the sessions wrote, absolute or relative to `cwd`. */
  files: string[];
  /** Session titles, used to write the commit message. */
  titles: string[];
}

interface RepoPlan {
  root: string;
  branch: string;
  /** Repo-relative paths, confirmed dirty, forward-slashed as git reports them. */
  paths: string[];
  /** Changed files in this repo that no session claims — deliberately untouched. */
  leftover: number;
  titles: string[];
}

/**
 * Commits each session's own work and pushes it.
 *
 * Two rules shape everything here. It commits only files a session actually
 * wrote, because a repository is routinely dirty for unrelated reasons and
 * `git add -A` would sweep a half-finished edit into an unattended push. And
 * it refuses outright on main or master rather than committing there.
 *
 * Every repository is planned and checked BEFORE any of them is committed: with
 * three sessions across two repositories, discovering the second is on main
 * after the first has already been pushed would leave exactly the half-done
 * state this action exists to avoid.
 */
export async function commitAndPush(work: RepoWork[]): Promise<string> {
  const skipped: string[] = [];
  const plans: RepoPlan[] = [];

  // Grouped by repository ROOT rather than by working directory: two sessions
  // in different subdirectories of one repository are still one repository, and
  // committing them separately would produce two commits that each report the
  // other's files as somebody else's uncommitted work.
  const byRoot = new Map<string, { candidates: Set<string>; titles: Set<string> }>();
  for (const item of work) {
    if (item.files.length === 0) continue;
    const root = (await tryGit(item.cwd, ['rev-parse', '--show-toplevel']))?.trim();
    if (!root) {
      skipped.push(`${repoName(item.cwd)} is not a git repository`);
      continue;
    }
    const entry = byRoot.get(root) ?? { candidates: new Set<string>(), titles: new Set<string>() };
    for (const file of item.files) {
      const rel = toRepoPath(root, item.cwd, file);
      if (rel) entry.candidates.add(rel);
    }
    for (const title of item.titles) entry.titles.add(title);
    byRoot.set(root, entry);
  }

  for (const [root, entry] of byRoot) {
    const plan = await planRepo(root, entry);
    if (typeof plan === 'string') skipped.push(plan);
    else plans.push(plan);
  }

  // Refusals are collected rather than thrown at the first one, so the operator
  // sees every repository that needs attention instead of one at a time.
  const refusals = plans
    .filter((p) => PROTECTED_BRANCHES.has(p.branch))
    .map((p) => `${repoName(p.root)} is on ${p.branch}`);
  if (refusals.length > 0) {
    throw new Error(`Refused: ${refusals.join(', ')} — Claudia never commits to main or master`);
  }

  const oversized = plans.find((p) => p.paths.length > MAX_FILES);
  if (oversized) {
    throw new Error(
      `Refused: ${oversized.paths.length} changed files in ${repoName(oversized.root)} is more than this action commits unattended`,
    );
  }

  if (plans.length === 0) {
    return skipped.length > 0 ? `Nothing to commit — ${skipped.join('; ')}` : 'Nothing to commit';
  }

  const done: string[] = [];
  for (const plan of plans) done.push(await commitRepo(plan));
  return [...done, ...skipped].join(' · ');
}

/**
 * Turns one repository's candidate files into a plan, or a sentence explaining
 * why there is nothing to do there.
 */
async function planRepo(
  root: string,
  entry: { candidates: Set<string>; titles: Set<string> },
): Promise<RepoPlan | string> {
  // `branch --show-current` rather than `rev-parse --abbrev-ref HEAD`: on a
  // repository with no commits yet the latter fails outright, while a partial
  // commit onto that unborn branch works perfectly well. Empty means a detached
  // HEAD, which has no branch to push and would strand the commit.
  const branch = (await tryGit(root, ['branch', '--show-current']))?.trim();
  if (!branch) return `${repoName(root)} has no branch checked out`;

  const dirty = await dirtyPaths(root);
  const paths = [...dirty].filter((p) => entry.candidates.has(p));
  if (paths.length === 0) return `${repoName(root)} has nothing of its own left to commit`;

  return { root, branch, paths, leftover: dirty.size - paths.length, titles: [...entry.titles] };
}

async function commitRepo(plan: RepoPlan): Promise<string> {
  // Staged first because an untracked file cannot be named in a partial commit
  // until git knows about it. The commit then names the same paths again: that
  // form ignores the index, so anything the operator had staged by hand stays
  // staged and uncommitted rather than riding along.
  await git(plan.root, ['add', '--', ...plan.paths]);
  await git(plan.root, ['commit', '-m', commitMessage(plan), '--', ...plan.paths]);

  const files = `${plan.paths.length} file${plan.paths.length === 1 ? '' : 's'}`;
  const left = plan.leftover > 0 ? `, left ${plan.leftover} other changed alone` : '';
  return `${repoName(plan.root)} (${plan.branch}): committed ${files}${left}${await push(plan)}`;
}

/**
 * Pushes the branch, setting an upstream the first time.
 *
 * A repository with no remote is reported rather than failed. The commit
 * already made the work durable, which is what the chain's ordering protects —
 * failing here would stop a chain over a configuration fact, not a lost change.
 * A push that is attempted and fails is a different matter and does throw.
 */
async function push(plan: RepoPlan): Promise<string> {
  const upstream = await tryGit(plan.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream) {
    await git(plan.root, ['push'], 120_000);
    return ' and pushed';
  }
  const remotes = (await tryGit(plan.root, ['remote']))?.split('\n').map((r) => r.trim()) ?? [];
  if (!remotes.includes('origin')) return ' — no remote, not pushed';
  await git(plan.root, ['push', '--set-upstream', 'origin', plan.branch], 120_000);
  return ' and pushed (new upstream)';
}

/**
 * Subject line from the session's own auto-generated title, which is already a
 * short description of the task — the closest thing to a real commit message
 * available without asking a model to write one.
 */
export function commitMessage(plan: Pick<RepoPlan, 'titles' | 'paths'>): string {
  const titles = plan.titles.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const first = titles[0];
  // No title means no session got far enough to be given one, so the count of
  // sessions is not known here either — say "a session" rather than guess.
  const subject =
    titles.length === 1 && first
      ? clamp(first, 72)
      : titles.length > 1
        ? `Claudia: work from ${titles.length} sessions`
        : 'Claudia: work from a session';
  const body = titles.length > 1 ? `\n\n${titles.map((t) => `- ${clamp(t, 100)}`).join('\n')}` : '';
  const files = `${plan.paths.length} file${plan.paths.length === 1 ? '' : 's'}`;
  return `${subject}${body}\n\nCommitted by Claudia when every session settled (${files}).`;
}

/** Paths git reports as changed, repo-relative. Untracked files are listed
 * individually (`-uall`): without it a new file inside a new directory is
 * reported as the directory, which no candidate path would ever match. */
async function dirtyPaths(root: string): Promise<Set<string>> {
  const out = await git(root, ['status', '--porcelain', '-z', '-uall']);
  const fields = out.split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    paths.add(entry.slice(3));
    // A rename or copy carries its original path in the NEXT field, which is a
    // bare path rather than an entry — reading status letters off it would
    // produce a nonsense path.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

/**
 * The part of `node:path` this needs, taken as a parameter so the Windows
 * behaviour can be pinned from a POSIX host — the same trick the per-OS finish
 * command table uses. Without it the separator conversion below is a no-op
 * everywhere the tests run, and only the Windows CI leg would ever notice it
 * being wrong.
 */
export type PathFlavour = Pick<typeof path, 'isAbsolute' | 'resolve' | 'relative' | 'sep'>;

/**
 * Repo-relative and forward-slashed, or null when the file is outside the repo.
 *
 * Forward slashes because that is the only vocabulary git speaks: `git status`
 * reports `server/src/x.ts` on every platform, while `path.relative` hands back
 * `server\src\x.ts` on Windows. Comparing those two directly matches nothing,
 * so the action would commit nothing and report nothing wrong.
 *
 * Symlinks have to be resolved for the same reason. `git rev-parse
 * --show-toplevel` reports the physical path, while a session's cwd is whatever
 * the user typed — and on macOS that is routinely a symlink (`/tmp`, and the
 * synced folders some of these repositories live under).
 */
export function toRepoPath(root: string, cwd: string, file: string, p: PathFlavour = path): string | null {
  const absolute = p.isAbsolute(file) ? file : p.resolve(real(cwd), file);
  const rel = p.relative(real(root), real(absolute));
  if (!rel || rel.startsWith('..') || p.isAbsolute(rel)) return null;
  return rel.split(p.sep).join('/');
}

/** The path with symlinks resolved, or unchanged when it no longer exists. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Last segment of a directory, for messages. Splits on BOTH separators
 * regardless of host, because the strings reaching it are mixed: git reports a
 * forward-slashed root even on Windows, while a session's cwd came from a
 * native folder picker. This is display text only — nothing builds a path from
 * it — so a POSIX directory whose name legitimately contains a backslash being
 * shortened here is cosmetic, not a correctness bug.
 */
export const repoName = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout, windowsHide: true });
    return stdout;
  } catch (err) {
    // git says why on stderr; the Error's own message is just the argv.
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed in ${repoName(cwd)}: ${clamp(stderr || String(err), 200)}`);
  }
}

/** Null instead of throwing, for the questions where "no" is an answer. */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch(() => null);
}
