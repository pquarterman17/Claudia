import type { Mission } from '@claudia/shared';
import { judge, missingEvidence, type Evidence } from './acceptance.js';
import { childReport } from './child-report.js';
import { gitLine, gitSays } from './git-facts.js';
import { pullRequestFor } from './pr-facts.js';
import type { PulseDeps } from './pulse.js';
import { runVerify } from './verify.js';

/**
 * What a finished child can actually show for itself.
 *
 * `acceptance.ts` has judged evidence since the first fleet PR and had never
 * been called: `judge`, `missingEvidence` and `blocksCleanup` were a fully
 * tested module that nothing in the server imported. The reason was upstream —
 * nothing ever wrote `reported`, so there was never a claim to judge — and
 * with a child able to finish, the gap is just this: somebody has to go and
 * look at the worktree.
 *
 * Observed SERVER-SIDE, from git, never taken from the child's own account of
 * itself. That is the module's founding rule and the whole reason `reported`
 * and `accepted` are separate states: a child's summary is untrusted input,
 * and what counts is a branch that exists, a diff that is not empty, and a
 * head that provably descends from the base it was given.
 *
 * The verdict is recorded, not applied. `DEFAULT_ACCEPTANCE` has
 * `autoAcceptWhenGreen: false` on the argument that "nobody looked" is not an
 * auditable decision — so this puts the evidence in front of the person who
 * clicks, and nothing here moves a task.
 */

/** Runs after the pulse has committed, because git is I/O and a transaction is not. */
export async function judgeReported(deps: PulseDeps, mission: Mission): Promise<number> {
  const { store } = deps;
  const runs = store.runs.listByMission(mission.id);
  if (!runs.ok) return 0;
  let judged = 0;
  for (const run of runs.value) {
    if (run.state !== 'reported') continue;
    // The append below is keyed on the run, so a second pass over a run
    // already judged is a no-op in the store. Checked here as well only to
    // avoid the git calls, which are the expensive half.
    if (alreadyJudged(deps, run.taskId, run.id)) continue;
    const gathered = await gatherEvidence(deps, run.worktreeId, mission.verify);
    const { checks, ...evidence } = gathered;
    const verdict = judge(evidence);
    const appended = store.events.append({
      missionId: mission.id,
      taskId: run.taskId,
      runId: run.id,
      // `system`, not `child`: this is the server's own reading of a worktree,
      // not anything the run said about itself.
      actor: 'system',
      kind: 'task_judged',
      payload: {
        verdict: verdict.kind,
        reason: verdict.reason,
        missing: missingEvidence(evidence),
        evidence,
        // What the mission's own command said, in one line, including the
        // cases that produced no test result: "could not run" and "did not
        // finish" are the difference between work nobody checked and work
        // that failed, and a verdict of `needs_human` alone does not say
        // which.
        ...(checks !== undefined ? { checks } : {}),
      },
      idempotencyKey: `judged:${encodeURIComponent(run.id)}`,
    });
    if (appended.ok) judged += 1;
  }
  return judged;
}

/**
 * Whether this run's verdict is already in the log.
 *
 * Asked of the TASK's log, not the mission's. `sinceForMission(id)` is
 * `seq > 0 ORDER BY seq LIMIT 500` — the OLDEST 500 events of the mission — so
 * once a mission had that much history this answered `false` for a run judged
 * seconds ago. The append is keyed on the run, so nothing was duplicated; what
 * ran again, on every pulse, for as long as the run sat in `reported`, was the
 * half this check exists to skip: the git reads and the mission's verify
 * command, up to its 120-second timeout. A task's own log is bounded by its
 * attempts, so the same read answers truthfully here.
 */
function alreadyJudged(deps: PulseDeps, taskId: string, runId: string): boolean {
  const events = deps.store.events.sinceForTask(taskId);
  return events.ok && events.value.some((event) => event.kind === 'task_judged' && event.runId === runId);
}

/**
 * The git half of the evidence, or as much of it as there is.
 *
 * Every field is optional and absent means NOBODY CHECKED, which
 * `missingEvidence` reports as a gap rather than treating as a pass. A run
 * with no worktree — one whose claim came in before a directory existed —
 * produces nothing at all, and that is the honest answer.
 */
async function gatherEvidence(
  deps: PulseDeps,
  worktreeId: string | undefined,
  verify: string | undefined,
): Promise<Evidence & { checks?: string }> {
  if (worktreeId === undefined) return {};
  const held = deps.store.worktrees.get(worktreeId);
  if (!held.ok || !held.value) return {};
  const { path, branch, baseSha } = held.value;

  // Run in the worktree the child worked in, which is the only directory its
  // claim is about. A mission with no command checks nothing, and the evidence
  // then says so through `missingEvidence` rather than through silence.
  const verified = verify === undefined ? undefined : await runVerify(path, verify);
  const tests = verified?.kind === 'checked' ? [verified.result] : undefined;

  const said = verified === undefined ? {} : { checks: verified.note };
  const ran = tests === undefined ? {} : { tests };

  // The forge, and the child's own account. Both answer nothing rather than
  // guessing: no `gh` and no report file are absences, which `missingEvidence`
  // never demanded and `judge` never blocks on — the point of collecting them
  // is that a closed pull request is a real rejection and a flagged risk is
  // something a reviewer should see, not that either is required.
  const pr = branch === undefined ? {} : await pullRequestFor(path, branch);
  const reported = await childReport(path);

  const headSha = await gitLine(path, ['rev-parse', 'HEAD']);
  if (headSha === undefined) return { branch, baseSha, ...ran, ...said, ...pr, ...reported };

  // `--numstat` over `--shortstat`: one line per file is a count that cannot be
  // misparsed, and zero lines is a real answer — an empty diff is a red flag,
  // not a pass.
  const numstat = await gitLine(path, ['diff', '--numstat', `${baseSha}..${headSha}`], { allowEmpty: true });
  const filesChanged = numstat === undefined ? undefined : numstat === '' ? 0 : numstat.split('\n').length;
  const descendsFromBase = await gitSays(path, ['merge-base', '--is-ancestor', baseSha, headSha]);

  return {
    branch,
    baseSha,
    headSha,
    ...(filesChanged !== undefined ? { filesChanged } : {}),
    ...(descendsFromBase !== undefined ? { descendsFromBase } : {}),
    ...ran,
    ...said,
    ...pr,
    ...reported,
  };
}
