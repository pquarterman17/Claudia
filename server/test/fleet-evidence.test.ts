import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeReported } from '../src/fleet/evidence.js';
import { startFleet } from '../src/fleet/boot.js';
import { branchFor, createLauncher } from '../src/fleet/launcher.js';
import { pulseFleet, type SessionFacts } from '../src/fleet/pulse.js';
import type { FleetStore } from '../src/store/index.js';
import { worktreePath } from '../src/worktree.js';

/**
 * Checking a claim against a worktree, rather than against the child's word.
 *
 * `acceptance.ts` has judged evidence since the first fleet PR and had never
 * been called — a fully tested module nothing imported. The reason was one
 * layer up: nothing wrote `reported`, so there was never a claim to judge.
 *
 * Everything here is observed from git. That is the module's founding rule and
 * the reason `reported` and `accepted` are separate states: a child's summary
 * is untrusted input, and what counts is a branch that exists, a diff that is
 * not empty, and a head that provably descends from the base it was given.
 */

// Resolved, because the launcher canonicalises the repository it is given —
// git answers with the real path, so the claim has to compare against one —
// and the end-to-end case below computes the worktree's path itself. On the
// Windows runner TEMP is an 8.3 short path, and the two spellings would not
// meet.
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'claudia-evidence-')));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let counter = 0;
/** A real repository, because the whole point is that git is asked. */
function repo(): string {
  const path = join(dir, `repo-${counter++}`);
  // Node's own, not `mkdir -p`: the shell command does not exist on the
  // Windows runner this suite also has to pass on, and a test that can only
  // set itself up on one platform is a test that only runs on one platform.
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com');
  git(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'README.md'), '# base\n', 'utf8');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-q', '-m', 'base');
  return path;
}

function fixture(over: { work?: boolean } = {}) {
  const path = repo();
  const baseSha = git(path, 'rev-parse', 'HEAD');
  if (over.work) {
    writeFileSync(join(path, 'hello.txt'), 'hello\n', 'utf8');
    git(path, 'add', 'hello.txt');
    git(path, 'commit', '-q', '-m', 'the work');
  }

  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);

  const mission = store.missions.create({ name: 'm', body: '', cwd: path });
  if (!mission.ok) throw new Error(mission.message);
  const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: path });
  if (!task.ok) throw new Error(task.message);
  const worktree = store.worktrees.create({
    repo: path,
    path,
    branch: 'main',
    baseSha,
    ownerMissionId: mission.value.id,
    ownerTaskId: task.value.id,
  });
  if (!worktree.ok) throw new Error(worktree.message);

  const run = store.runs.create({
    missionId: mission.value.id,
    taskId: task.value.id,
    worktreeId: worktree.value.id,
    agent: 'claude',
    attempt: 1,
    state: 'dispatched',
  });
  if (!run.ok) throw new Error(run.message);
  const attached = store.runs.attachSession(run.value.id, 'sess-1');
  if (!attached.ok) throw new Error(attached.message);
  const running = store.runs.setState(run.value.id, 'running');
  if (!running.ok) throw new Error(running.message);
  const reported = store.runs.setState(run.value.id, 'reported');
  if (!reported.ok) throw new Error(reported.message);

  return { store, mission: mission.value, task: task.value, run: reported.value };
}

const deps = (store: FleetStore) => ({
  store,
  policy: { maxChildren: 4, maxAttempts: 3 },
  observeSessions: (): ReadonlyMap<string, SessionFacts> => new Map(),
});

function judged(store: FleetStore, missionId: string): Record<string, unknown> | undefined {
  const log = store.events.sinceForMission(missionId);
  if (!log.ok) throw new Error(log.message);
  const found = log.value.find((e) => e.kind === 'task_judged');
  return found?.payload as Record<string, unknown> | undefined;
}

describe('judging a reported run', () => {
  it('reads the worktree and writes what it found', async () => {
    const { store, mission } = fixture({ work: true });
    expect(await judgeReported(deps(store), mission)).toBe(1);

    const payload = judged(store, mission.id);
    const evidence = payload?.['evidence'] as Record<string, unknown>;
    expect(evidence['branch']).toBe('main');
    expect(evidence['filesChanged']).toBe(1);
    // Provably, from git, rather than assumed because the run said so.
    expect(evidence['descendsFromBase']).toBe(true);
  });

  it('counts an empty diff as zero, which is a red flag and not a pass', async () => {
    // A child that committed nothing has a head equal to its base. Zero has to
    // be a real answer here, not an absent field that reads as "not checked".
    const { store, mission } = fixture();
    await judgeReported(deps(store), mission);
    const evidence = judged(store, mission.id)?.['evidence'] as Record<string, unknown>;
    expect(evidence['filesChanged']).toBe(0);
  });

  it('asks a human rather than accepting, because nothing ran the tests', async () => {
    // `DEFAULT_ACCEPTANCE` has `allowMissingTests: false` and
    // `autoAcceptWhenGreen: false`: the plan requires an auditable decision,
    // and "nobody looked" is not one.
    const { store, mission } = fixture({ work: true });
    await judgeReported(deps(store), mission);
    const payload = judged(store, mission.id);
    expect(payload?.['verdict']).toBe('needs_human');
    expect(payload?.['missing']).toContain('test results');
  });

  it('does not move the task, because recording a verdict is not applying one', async () => {
    const { store, mission, task } = fixture({ work: true });
    const before = store.tasks.get(task.id);
    await judgeReported(deps(store), mission);
    const after = store.tasks.get(task.id);
    expect(after.ok && after.value?.status).toBe(before.ok ? before.value?.status : 'unreadable');
  });

  it('judges each run once, however often the pulse comes round', async () => {
    const { store, mission } = fixture({ work: true });
    expect(await judgeReported(deps(store), mission)).toBe(1);
    expect(await judgeReported(deps(store), mission)).toBe(0);
    const log = store.events.sinceForMission(mission.id);
    if (!log.ok) throw new Error(log.message);
    expect(log.value.filter((e) => e.kind === 'task_judged')).toHaveLength(1);
  });

  it('leaves a run alone that has not reported', async () => {
    // Rewritten after CodeQL pointed at an unused variable here, which was the
    // symptom: the old version destructured a mission it never used, moved a
    // run through a transition the store refuses, and then asserted on a
    // SECOND fixture — so it proved nothing about the filter it was named for.
    const { store, mission, task } = fixture({ work: true });
    const running = store.runs.create({
      missionId: mission.id,
      taskId: task.id,
      agent: 'claude',
      attempt: 2,
      state: 'dispatched',
    });
    if (!running.ok) throw new Error(running.message);

    // One reported run and one still dispatched: exactly one judgement, and it
    // belongs to the one that made a claim.
    expect(await judgeReported(deps(store), mission)).toBe(1);
    const log = store.events.sinceForMission(mission.id);
    if (!log.ok) throw new Error(log.message);
    const judgements = log.value.filter((e) => e.kind === 'task_judged');
    expect(judgements).toHaveLength(1);
    expect(judgements[0]?.runId).not.toBe(running.value.id);
  });

  it('says nothing it cannot see when there is no worktree', async () => {
    // A claim from a run with no directory is still a claim. Absent fields
    // mean nobody checked, which `missingEvidence` reports as a gap rather
    // than treating as a pass.
    const { store, mission } = fixture({ work: true });
    const runs = store.runs.listByMission(mission.id);
    if (!runs.ok) throw new Error(runs.message);
    store.db.prepare('UPDATE child_runs SET worktree_id = NULL WHERE id = ?').run(runs.value[0]?.id ?? '');

    expect(await judgeReported(deps(store), mission)).toBe(1);
    const payload = judged(store, mission.id);
    expect(payload?.['verdict']).toBe('needs_human');
    expect(payload?.['missing']).toContain('branch');
  });
});

describe('from the launch to the evidence, with nothing faked but the SDK', () => {
  /**
   * The join that was missing, and that every test here used to hide.
   *
   * The fixture above builds the run-to-worktree link by hand, which is
   * exactly what production did NOT do: `claimFor` made the directory, wrote
   * the worktree row, and returned only a path — so `run.worktreeId` was
   * undefined for every child the fleet ever started. `gatherEvidence` reads
   * that one field, so every real judgement came back `needs_human` with every
   * fact missing, and the feature was inert outside this file.
   *
   * So this drives the whole chain instead: a real repository, the real pulse,
   * the real launcher, a real `git worktree add`, a real commit made in the
   * worktree the child was handed, and the real watchdog moving the run to
   * `reported`. Only starting a session is faked.
   */
  it('judges the worktree the child was actually launched into', async () => {
    const repoPath = repo();
    const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
    if (!boot.store) throw new Error(boot.summary);
    const store = boot.store;
    opened.push(store);

    const mission = store.missions.create({ name: 'm', body: '', cwd: repoPath });
    if (!mission.ok) throw new Error(mission.message);
    const watched = store.missions.setWatch(mission.value.id, 'watching');
    if (!watched.ok) throw new Error(watched.message);
    const task = store.tasks.create({
      missionId: mission.value.id,
      title: 'Add the greeting',
      description: 'Add it.',
      cwd: repoPath,
    });
    if (!task.ok) throw new Error(task.message);
    const ready = store.tasks.setStatus(task.value.id, 'ready');
    if (!ready.ok) throw new Error(ready.message);

    const started: string[] = [];
    const policy = { maxChildren: 2, maxAttempts: 3 };
    const launch = createLauncher({
      store,
      startSession: (spec: { cwd: string }): string => {
        started.push(spec.cwd);
        return `sess-${started.length}`;
      },
      stopSession: (): void => {},
    });

    // A simulated clock, so "the child worked for a while and finished" is a
    // number rather than a sleep.
    const base = Date.now();
    const [dispatched] = await pulseFleet({ store, policy, launch, observeSessions: () => new Map(), now: () => base });
    expect(dispatched?.launched).toBe(1);

    // The child does its work — in the worktree it was handed, which is the
    // whole question this test exists to answer.
    const work = worktreePath(repoPath, branchFor(task.value));
    expect(started).toEqual([work]);
    writeFileSync(join(work, 'hello.txt'), 'hello\n', 'utf8');
    git(work, 'add', 'hello.txt');
    git(work, 'commit', '-q', '-m', 'the work');

    // ...and then finishes its turn, which is what moves the run to `reported`.
    const facts = new Map<string, SessionFacts>([['sess-1', { lastActivityAt: base + 60_000, state: 'idle' }]]);
    const [reported] = await pulseFleet({
      store,
      policy,
      launch,
      observeSessions: () => facts,
      now: () => base + 600_000,
    });
    expect(reported?.reported).toBe(1);

    const runs = store.runs.listByMission(mission.value.id);
    if (!runs.ok) throw new Error(runs.message);
    const run = runs.value[0];
    expect(run?.state).toBe('reported');

    // The link itself: the run row names the worktree row the launcher claimed
    // for it, rather than nothing at all.
    const held = store.worktrees.byPath(work);
    if (!held.ok) throw new Error(held.message);
    expect(held.value?.id).toBeDefined();
    expect(run?.worktreeId).toBe(held.value?.id);

    // And so the judgement the pulse makes on its way through — after its own
    // commit, because reading a worktree is git — has something to read. A
    // second pass finds the work already done.
    expect(await judgeReported(deps(store), watched.value)).toBe(0);
    const payload = judged(store, mission.value.id);
    expect(payload).toBeDefined();
    const evidence = payload?.['evidence'] as Record<string, unknown>;
    expect(evidence['branch']).toBe(branchFor(task.value));
    expect(evidence['headSha']).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(evidence['filesChanged']).toBe(1);
    expect(evidence['descendsFromBase']).toBe(true);
    // Still a human's decision — nothing ran the tests — but now it is one
    // made in front of the facts instead of in front of an empty record.
    expect(payload?.['missing']).not.toContain('branch');
  });
});
