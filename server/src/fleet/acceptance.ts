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
  /** Whether `headSha` provably descends from `baseSha`, observed server-side.
   * Absent means nobody checked, which is not the same as yes. */
  descendsFromBase?: boolean;
  /** Things the child itself flagged as unresolved. Never blocks on its own —
   * a child that admits a risk is behaving better than one that does not. */
  risks?: string[];
  artifacts?: string[];
}

export interface AcceptancePolicy {
  /** Accept without the head provably descending from the recorded base. Off
   * by default: a diff that does not build on the base is not this task's
   * work, however green its tests are. */
  allowUnverifiedAncestry?: boolean;
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
  // Required whenever ancestry is being claimed. Found in review: a
  // complete-looking object could omit the base entirely while asserting
  // `descendsFromBase: true` — descending from nothing in particular.
  if (!policy.allowUnverifiedAncestry && !evidence.baseSha) missing.push('base commit');
  if (!policy.allowMissingTests && (!evidence.tests || evidence.tests.length === 0)) {
    missing.push('test results');
  }
  return missing;
}

/**
 * Evidence that is present but not usable.
 *
 * Distinct from missing, and checked first: `filesChanged: -1` is not an
 * absent diff summary, it is a claim that cannot be true. Found in review —
 * only zero was rejected, so every other impossible number passed. Whatever
 * produced it is broken, and treating its output as authority is worse than
 * having none.
 */
export function malformedEvidence(evidence: Evidence): string | undefined {
  const files = evidence.filesChanged;
  if (files !== undefined && (!Number.isSafeInteger(files) || files < 0)) {
    return `filesChanged is ${files}, which is not a number of files`;
  }
  for (const test of evidence.tests ?? []) {
    if (typeof test?.command !== 'string' || test.command.trim() === '') {
      return 'a test result has no command';
    }
    if (!Number.isSafeInteger(test.exitCode)) {
      return `the exit code for ${test.command} is not a number`;
    }
  }
  return undefined;
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
  // Before anything is read as a fact. Nonsense is not a near-miss to be
  // weighed against the rest; it means the thing that produced this evidence
  // cannot be trusted about any of it.
  const malformed = malformedEvidence(evidence);
  if (malformed) return { kind: 'reject', reason: malformed };

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

  // Ancestry, when it can be established. A green test run over a diff that
  // does not build on the recorded base is evidence about some other tree.
  if (!policy.allowUnverifiedAncestry && evidence.descendsFromBase !== true) {
    return evidence.descendsFromBase === false
      ? { kind: 'reject', reason: `${evidence.headSha ?? 'the head'} does not descend from ${evidence.baseSha ?? 'the base'}` }
      : { kind: 'needs_human', reason: 'cannot confirm the work builds on its base', missing: ['ancestry'] };
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
  policy: AcceptancePolicy = DEFAULT_ACCEPTANCE,
): string | undefined {
  const malformed = malformedEvidence(evidence);
  if (malformed) return malformed;
  // Every unknown blocks. Found in review: this only refused when `merged` was
  // explicitly false, so an observation that could not answer — a git call
  // that failed, a field nobody filled in — read as permission to delete.
  if (observed.dirty !== false) {
    return observed.dirty ? 'it has uncommitted work' : 'cannot confirm it is clean';
  }
  if (!accepted) return 'the task has not been accepted';
  if (observed.merged !== true && evidence.prState !== 'merged') {
    return observed.merged === false
      ? `${evidence.branch ?? 'the branch'} is not merged anywhere`
      : `cannot confirm ${evidence.branch ?? 'the branch'} is merged anywhere`;
  }
  // The SAME policy the acceptance was made under. Found in review: this
  // recomputed with the default, so a task accepted under `allowMissingTests`
  // was then permanently uncleanable — accepted and undeletable at once, with
  // no way for the human to resolve it.
  const missing = missingEvidence(evidence, policy);
  if (missing.length > 0) return `evidence is incomplete: no ${missing.join(', no ')}`;
  return undefined;
}
