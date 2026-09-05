import type { Mission } from '@claudia/shared';
import { judge, missingEvidence, type Evidence } from './acceptance.js';
import { gitLine, gitSays } from './git-facts.js';
import type { PulseDeps } from './pulse.js';

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
    if (alreadyJudged(deps, mission.id, run.id)) continue;
    const evidence = await gatherEvidence(deps, run.worktreeId);
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
      },
      idempotencyKey: `judged:${encodeURIComponent(run.id)}`,
    });
    if (appended.ok) judged += 1;
  }
  return judged;
}

function alreadyJudged(deps: PulseDeps, missionId: string, runId: string): boolean {
  const events = deps.store.events.sinceForMission(missionId);
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
async function gatherEvidence(deps: PulseDeps, worktreeId: string | undefined): Promise<Evidence> {
  if (worktreeId === undefined) return {};
  const held = deps.store.worktrees.get(worktreeId);
  if (!held.ok || !held.value) return {};
  const { path, branch, baseSha } = held.value;

  const headSha = await gitLine(path, ['rev-parse', 'HEAD']);
  if (headSha === undefined) return { branch, baseSha };

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
  };
}
