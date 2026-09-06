import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * A real script, because what is being tested is what a real process reports.
 *
 * Both dialects: `ls` does not exist on the Windows runner and `exit` there
 * ends the shell rather than the script, so one dialect is a test that only
 * runs on one platform.
 */
function script(name: string, body: { posix: string; windows: string }): string {
  const windows = process.platform === 'win32';
  const path = join(dir, windows ? `${name}.cmd` : `${name}.sh`);
  const text = windows ? `@echo off\r\n${body.windows}\r\n` : `#!/bin/sh\n${body.posix}\n`;
  writeFileSync(path, text, 'utf8');
  if (!windows) chmodSync(path, 0o755);
  // Quoted, so a temp path with a space survives the shell that runs it.
  return `"${path}"`;
}

function fixture(over: { work?: boolean; verify?: string } = {}) {
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

  const mission = store.missions.create({
    name: 'm',
    body: '',
    cwd: path,
    ...(over.verify !== undefined ? { verify: over.verify } : {}),
  });
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

  it('still judges it once on a mission with more history than one read returns', async () => {
    // The skip was asked of `sinceForMission`, which returns the OLDEST 500
    // events of a mission. Past that, a run judged seconds ago looked unjudged
    // and every pulse paid for the evidence again — the git reads and the
    // mission's verify command, which is the expensive half this check exists
    // to avoid. The append is keyed on the run, so the log looked fine.
    const { store, mission } = fixture({ work: true });
    for (let i = 0; i < 520; i++) {
      const filler = store.events.append({ missionId: mission.id, actor: 'system', kind: 'notice', payload: { i } });
      if (!filler.ok) throw new Error(filler.message);
    }

    expect(await judgeReported(deps(store), mission)).toBe(1);
    expect(await judgeReported(deps(store), mission)).toBe(0);
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

    // With a check of its own, so the chain proves the last link too: the
    // command has to run in the worktree the child was given, not in the
    // repository and not in the server's own directory.
    const mission = store.missions.create({
      name: 'm',
      body: '',
      cwd: repoPath,
      verify: script('e2e', { posix: 'ls hello.txt', windows: 'dir /b hello.txt' }),
    });
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
    // `hello.txt` exists only in the worktree, and only because the child
    // committed it there — so an exit of 0 is the command having run in the
    // right directory, over the right work.
    expect(payload?.['checks']).toMatch(/exit 0$/);
    expect(payload?.['missing']).toEqual([]);
  });
});

describe('checking the work, not just looking at it', () => {
  /**
   * The last gap in `acceptance.ts`, and the widest.
   *
   * Nothing ever wrote `evidence.tests`, so `missingEvidence` reported "test
   * results" on every judgement, `judge`'s reject-on-failing-checks branch was
   * unreachable by any input, and every verdict the fleet had ever recorded
   * was `needs_human` — however good the work was. A mission can now say what
   * "green" means for its repository, and the pulse runs it in the worktree
   * the child actually worked in.
   */
  it('runs the mission command and records what it said', async () => {
    const { store, mission } = fixture({ work: true, verify: script('green', { posix: 'exit 0', windows: 'exit /b 0' }) });
    expect(await judgeReported(deps(store), mission)).toBe(1);

    const payload = judged(store, mission.id);
    const evidence = payload?.['evidence'] as Record<string, unknown>;
    const tests = evidence['tests'] as Array<Record<string, unknown>>;
    expect(tests).toHaveLength(1);
    expect(tests[0]?.['exitCode']).toBe(0);
    // The gap that closed: this list has said "test results" on every
    // judgement the fleet has ever made.
    expect(payload?.['missing']).not.toContain('test results');
    expect(payload?.['missing']).toEqual([]);
  });

  it('rejects work whose checks failed, rather than asking a human about it', async () => {
    // The branch no input could reach. A child that reports success over a
    // failing suite is the case the whole `reported`/`accepted` split exists
    // for, and until now it produced the same "check it" as every other run.
    const { store, mission } = fixture({
      work: true,
      verify: script('red', { posix: 'echo boom\nexit 1', windows: 'echo boom\r\nexit /b 1' }),
    });
    await judgeReported(deps(store), mission);

    const payload = judged(store, mission.id);
    expect(payload?.['verdict']).toBe('reject');
    expect(payload?.['reason']).toMatch(/failing check/);
    expect(payload?.['checks']).toMatch(/exit 1$/);
  });

  it('says a command that could not run did not check anything', async () => {
    // Not a failure. A missing binary is evidence about the environment, and
    // reporting it as a non-zero exit would reject good work — so the verdict
    // falls back to the one the fleet had before, with the reason attached.
    const { store, mission } = fixture({ work: true, verify: join(dir, 'no-such-checker') });
    await judgeReported(deps(store), mission);

    const payload = judged(store, mission.id);
    expect(payload?.['verdict']).toBe('needs_human');
    expect(payload?.['missing']).toContain('test results');
    expect(payload?.['checks']).toMatch(/could not run/);
    const evidence = payload?.['evidence'] as Record<string, unknown>;
    expect(evidence['tests']).toBeUndefined();
  });

  it('says nothing about checks for a mission that has none', async () => {
    // The default, and every mission written before the column existed.
    const { store, mission } = fixture({ work: true });
    await judgeReported(deps(store), mission);

    const payload = judged(store, mission.id);
    expect(payload?.['checks']).toBeUndefined();
    expect(payload?.['missing']).toContain('test results');
  });
});

describe('what the child said about its own work', () => {
  it('carries the risks and artifacts it left behind into the judgement', async () => {
    // The two fields that are the child's word rather than an observation, and
    // the two nothing had ever written. They decide nothing — `judge` does not
    // read them and `missingEvidence` never asked for them — which is the
    // point: a child that admits a risk is behaving better than one that does
    // not, and the person reviewing should see it either way.
    const { store, mission, task } = fixture({ work: true });
    const held = store.worktrees.listByMission(mission.id);
    if (!held.ok) throw new Error(held.message);
    const path = held.value[0]?.path;
    if (path === undefined) throw new Error('the fixture has no worktree');

    mkdirSync(join(path, '.claudia'), { recursive: true });
    writeFileSync(
      join(path, '.claudia', 'report.json'),
      JSON.stringify({ risks: ['the migration is not reversible'], artifacts: ['docs/plan.md'] }),
      'utf8',
    );

    expect(await judgeReported(deps(store), mission)).toBe(1);
    const evidence = judged(store, mission.id)?.['evidence'] as Record<string, unknown>;
    expect(evidence['risks']).toEqual(['the migration is not reversible']);
    expect(evidence['artifacts']).toEqual(['docs/plan.md']);
    // And the verdict is unchanged by them: they are not a way for a child to
    // talk itself into being accepted.
    expect(judged(store, mission.id)?.['verdict']).toBe('needs_human');
    expect(task.id).toBeDefined();
  });

  it('is silent when the child left nothing, which is most of the time', async () => {
    const { store, mission } = fixture({ work: true });
    await judgeReported(deps(store), mission);
    const evidence = judged(store, mission.id)?.['evidence'] as Record<string, unknown>;
    expect(evidence['risks']).toBeUndefined();
    expect(evidence['artifacts']).toBeUndefined();
  });
});

describe('every field of the evidence has something that writes it', () => {
  /**
   * The shape of the bug this whole file exists because of.
   *
   * `evidence.tests` was declared, judged on, reported as missing, and never
   * written by anything — so `judge`'s reject-on-failing-checks branch could
   * not be reached by any input and every verdict was `needs_human`. It was
   * invisible because nothing was broken: the type checked, the unit tests
   * passed against hand-built evidence, and the field simply never arrived.
   *
   * This reads the `Evidence` interface out of the source and asks, for each
   * field, whether the server mentions it anywhere outside the module that
   * declares it. It cannot prove a field is written properly. It can prove
   * that nothing NEW joins the list of fields nobody fills in — which is the
   * failure that actually happened, twice.
   */
  const SRC = join(import.meta.dirname, '..', 'src');

  /**
   * Empty, and it took work to get there.
   *
   * This held `prUrl`, `prState`, `risks` and `artifacts` — declared, judged
   * on, and gathered by nothing, so `prState === 'closed'` was a rejection no
   * input could reach. They are collected now: the first two from the forge,
   * the last two from the report file the child is asked for in its brief.
   *
   * The ledger stays, empty, because it is checked in both directions: a new
   * field nobody writes fails, and a listed field that gets wired fails until
   * it comes off. That second half is what just emptied it.
   */
  const NOT_GATHERED_YET = new Set<string>([]);

  function serverSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) serverSources(full, out);
      else if (entry.endsWith('.ts') && entry !== 'acceptance.ts') out.push(full);
    }
    return out;
  }

  it('names them all, and nothing writes only the ones we know about', () => {
    const acceptance = readFileSync(join(SRC, 'fleet', 'acceptance.ts'), 'utf8');
    const block = acceptance.slice(acceptance.indexOf('export interface Evidence'));
    const fields = [...block.slice(0, block.indexOf('\n}')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    // If this ever comes back short, the interface moved and the rest of this
    // test is reading nothing.
    expect(fields.length).toBeGreaterThanOrEqual(8);

    const server = serverSources(SRC)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const dead = fields.filter((field) => !new RegExp(`\\b${field}\\b`).test(server));

    expect(
      dead.filter((field) => !NOT_GATHERED_YET.has(field)),
      `nothing in server/src writes ${dead.join(', ')}. A field the judgement reads and nobody fills in ` +
        'is a verdict that cannot be reached — which is what `tests` was until the verify command landed.',
    ).toEqual([]);

    // And the ledger stays honest in the other direction: a field that has
    // since been wired should come off the list rather than sit there
    // pretending to be dead.
    const revived = [...NOT_GATHERED_YET].filter((field) => !dead.includes(field));
    expect(revived, `${revived.join(', ')} is written now — take it out of NOT_GATHERED_YET.`).toEqual([]);
  });
});
