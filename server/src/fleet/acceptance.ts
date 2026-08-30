/**
 * The difference between "the process stopped" and "the task is done".
 *
 * Claudia's finish chain fires when a session goes idle. Idle means the model
 * stopped talking — it does not mean the work happened, and on a fleet that
 * distinction is the whole game: a child that gave up, hit its context limit,
 * or wrote nothing at all goes idle exactly like one that succeeded. The plan
 * separates three states for that reason, and this module is the gate between
 * the second and the third:
 *
 *   running   the process is alive
 *   reported  the child says it is finished — a CLAIM
 *   accepted  the claim was checked against evidence — a DECISION
 *
 * Nothing here trusts prose. A child's summary is untrusted input; what counts
 * is a branch that exists, a diff that is non-empty, and a test command with
 * an exit code.
 */

export interface TestResult {
  command: string;
  exitCode: number;
  /** First line or two of output, for the human reading the decision later. */
  summary?: string;
}

/** What a finished run has to be able to show for itself. */
export interface Evidence {
  branch?: string;
  baseSha?: string;
  headSha?: string;
  /** Files changed between base and head. Zero is a red flag, not a pass. */
  filesChanged?: number;
  tests?: TestResult[];
  prUrl?: string;
  prState?: 'draft' | 'open' | 'merged' | 'closed';
  /** Things the child itself flagged as unresolved. Never blocks on its own —
   * a child that admits a risk is behaving better than one that does not. */
  risks?: string[];
  artifacts?: string[];
}

export interface AcceptancePolicy {
  /** Accept without asking when every check is green. Off by default: the
   * plan requires an auditable decision, and "nobody looked" is not one
   * unless the human has explicitly said it may be. */
  autoAcceptWhenGreen: boolean;
  /** Tasks may be accepted with no test evidence at all. Off by default. */
  allowMissingTests: boolean;
}

export const DEFAULT_ACCEPTANCE: AcceptancePolicy = {
  autoAcceptWhenGreen: false,
  allowMissingTests: false,
};

export type AcceptanceVerdict =
  | { kind: 'accept'; reason: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'needs_human'; reason: string; missing: string[] };

/**
 * What the evidence does not have.
 *
 * Returned as a list rather than a first-failure so the human sees the whole
 * gap at once; being told about one missing field at a time, a pulse apart, is
 * how a person stops reading the escalation inbox.
 */
export function missingEvidence(evidence: Evidence, policy: AcceptancePolicy = DEFAULT_ACCEPTANCE): string[] {
  const missing: string[] = [];
  if (!evidence.branch) missing.push('branch');
  if (!evidence.headSha) missing.push('head commit');
  if (evidence.filesChanged === undefined) missing.push('diff summary');
  if (!policy.allowMissingTests && (!evidence.tests || evidence.tests.length === 0)) {
    missing.push('test results');
  }
  return missing;
}

/**
 * Whether a reported task may be accepted.
 *
 * Rejection is reserved for evidence that actively contradicts the claim — a
 * failing test, an empty diff. Everything else that is merely absent produces
 * `needs_human`, because "I cannot tell" and "this is wrong" are different
 * answers and collapsing them either hides real failures or cries wolf.
 */
export function judge(evidence: Evidence, policy: AcceptancePolicy = DEFAULT_ACCEPTANCE): AcceptanceVerdict {
  const failed = (evidence.tests ?? []).filter((t) => t.exitCode !== 0);
  if (failed.length > 0) {
    return {
      kind: 'reject',
      reason: `${failed.length} failing check${failed.length === 1 ? '' : 's'}: ${failed.map((t) => t.command).join(', ')}`,
    };
  }

  // A child that reports success having changed nothing is the commonest
  // silent failure there is: it explored, ran out of turn, and summarised.
  if (evidence.filesChanged === 0) {
    return { kind: 'reject', reason: 'reported complete but changed no files' };
  }

  const missing = missingEvidence(evidence, policy);
  if (missing.length > 0) {
    return { kind: 'needs_human', reason: `no ${missing.join(', no ')}`, missing };
  }

  if (evidence.prState === 'closed') {
    return { kind: 'reject', reason: 'its pull request was closed without merging' };
  }

  if (!policy.autoAcceptWhenGreen) {
    return { kind: 'needs_human', reason: 'every check passed; acceptance is yours to give', missing: [] };
  }
  return { kind: 'accept', reason: describeGreen(evidence) };
}

function describeGreen(evidence: Evidence): string {
  const tests = evidence.tests?.length ?? 0;
  const files = evidence.filesChanged ?? 0;
  const parts = [`${files} file${files === 1 ? '' : 's'} changed`];
  if (tests) parts.push(`${tests} check${tests === 1 ? '' : 's'} passed`);
  if (evidence.risks?.length) parts.push(`${evidence.risks.length} risk(s) noted`);
  return parts.join(', ');
}

/**
 * Why a task's worktree may not be cleaned up yet.
 *
 * Separate from the accept decision because they fail in opposite directions:
 * refusing to accept costs a human a click, whereas cleaning up too early
 * destroys the only copy of the work. So this refuses on anything unresolved,
 * including a task that was never accepted at all.
 */
export function blocksCleanup(
  accepted: boolean,
  evidence: Evidence,
  observed: { dirty?: boolean; merged?: boolean },
): string | undefined {
  if (observed.dirty) return 'it has uncommitted work';
  if (!accepted) return 'the task has not been accepted';
  if (observed.merged === false && evidence.prState !== 'merged') {
    return `${evidence.branch ?? 'the branch'} is not merged anywhere`;
  }
  const missing = missingEvidence(evidence);
  if (missing.length > 0) return `evidence is incomplete: no ${missing.join(', no ')}`;
  return undefined;
}
