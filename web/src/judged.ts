import { readableTest, VERDICTS, type FleetEvent } from '@claudia/shared';

/**
 * The server's reading of what a finished child left behind.
 *
 * Carried in a `task_judged` event's payload, which is typed `unknown` by
 * design — the event log stores JSON and never reaches into it for structure.
 * So this reads it defensively rather than casting: `null`, `42`, `"done"` and
 * `[]` are all valid JSON, and a component that assumed an object would throw
 * on any of them.
 *
 * Absent fields mean NOBODY CHECKED, which is not the same as a pass. That is
 * the whole point of `missing` being shown next to the verdict.
 */
export interface Judgement {
  verdict: 'accept' | 'reject' | 'needs_human';
  reason: string;
  missing: string[];
  filesChanged?: number;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  descendsFromBase?: boolean;
  tests?: { command: string; exitCode: number; summary?: string }[];
  prUrl?: string;
  prState?: 'draft' | 'open' | 'merged' | 'closed';
  risks?: string[];
  artifacts?: string[];
  /** Entries present in the event but too malformed to show as evidence. */
  unreadTests?: number;
  unreadRisks?: number;
  unreadArtifacts?: number;
  /**
   * What the mission's own verify command did, in one line.
   *
   * Sits outside `evidence` because it also describes the runs that produced
   * NO evidence: a command that could not start and one that never finished
   * both leave `tests` absent, and "no test results" alone does not say which
   * — or that anything was even attempted.
   */
  checks?: string;
}

const PR_STATES = new Set(['draft', 'open', 'merged', 'closed']);

/**
 * The verdict on the attempt currently on the table, or nothing.
 *
 * Scoped by RUN, because a judgement describes the worktree of the run that
 * produced it. A task sent back to `ready` and run again has an older verdict
 * about a tree that no longer exists, and the case that bites is the ordinary
 * one: the second attempt reports before the pulse judges it, and taking the
 * newest verdict by position hands back attempt 1's `accept`.
 *
 * Which attempt that is comes off the task row — `Task.currentRunId`, written
 * by the server in the transaction that moved the status — so this and
 * `accept_task` read the same field rather than two reconstructions of it.
 * They used to derive it separately from the log, which is how the panel came
 * to offer decisions the server refused.
 *
 * `undefined` is a task carried over from before that column: the newest
 * verdict stands, whichever attempt it belongs to, and `accept_task` reads it
 * unscoped too. Hiding every verdict there would be worse, and being wrong in
 * the same direction on both ends is at least a state a human can act on.
 */
export function judgementFor(
  events: readonly FleetEvent[] | undefined,
  taskId: string,
  currentRunId: string | undefined,
): Judgement | undefined {
  let latest: Judgement | undefined;
  let latestSeq = Number.NEGATIVE_INFINITY;
  for (const event of events ?? []) {
    if (event.taskId !== taskId) continue;
    if (event.kind !== 'task_judged') continue;
    // A judgement that does not name the current run cannot be shown to
    // describe it. Refusing it costs an override, with its reason; accepting
    // it would spend one attempt's evidence on another.
    if (currentRunId !== undefined && event.runId !== currentRunId) continue;
    const read = readJudgement(event.payload);
    // By SEQUENCE, like `latestJudgement` server-side, rather than by position
    // in the array. The two agreed only because `fleet-state.ts` happens to
    // sort by seq three modules away — an invariant nothing here asserts, and
    // one an unsorted slice from a future caller would break silently, which
    // is the panel-versus-server disagreement all over again.
    //
    // Kept only if it parses: a malformed payload should leave the previous
    // good one standing rather than blanking the panel.
    if (read && event.seq > latestSeq) {
      latest = read;
      latestSeq = event.seq;
    }
  }
  return latest;
}

function readJudgement(payload: unknown): Judgement | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const verdict = record['verdict'];
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return undefined;
  const evidence = asRecord(record['evidence']) ?? {};
  const tests = readTests(evidence['tests']);
  const risks = readStrings(evidence['risks']);
  const artifacts = readStrings(evidence['artifacts']);
  const strings = { unreadRisks: risks?.unread ?? 0, unreadArtifacts: artifacts?.unread ?? 0 };
  const prUrl = safeWebUrl(evidence['prUrl']);
  return {
    verdict: verdict as Judgement['verdict'],
    reason: typeof record['reason'] === 'string' ? record['reason'] : '',
    missing: Array.isArray(record['missing']) ? record['missing'].filter((m): m is string => typeof m === 'string') : [],
    // A safe integer AND non-negative, which is the rule `malformedEvidence`
    // applies — it rejects `filesChanged: -3` by name. This accepted it and
    // rendered `Files: -3` straight through `String(...)` as an observed fact.
    ...(readableCount(evidence['filesChanged']) ? { filesChanged: evidence['filesChanged'] as number } : {}),
    ...(typeof evidence['branch'] === 'string' ? { branch: evidence['branch'] } : {}),
    ...(typeof evidence['baseSha'] === 'string' ? { baseSha: evidence['baseSha'] } : {}),
    ...(typeof evidence['headSha'] === 'string' ? { headSha: evidence['headSha'] } : {}),
    ...(typeof evidence['descendsFromBase'] === 'boolean'
      ? { descendsFromBase: evidence['descendsFromBase'] }
      : {}),
    ...(tests !== undefined ? { tests: tests.values } : {}),
    unreadTests: tests?.unread ?? 0,
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(typeof evidence['prState'] === 'string' && PR_STATES.has(evidence['prState'])
      ? { prState: evidence['prState'] as Judgement['prState'] }
      : {}),
    ...(risks !== undefined ? { risks: risks.values } : {}),
    ...(artifacts !== undefined ? { artifacts: artifacts.values } : {}),
    ...strings,
    ...(typeof record['checks'] === 'string' ? { checks: record['checks'] } : {}),
  };
}

function readTests(value: unknown): { values: NonNullable<Judgement['tests']>; unread: number } | undefined {
  if (value === undefined) return undefined;
  // Present but not a list: `tests: 'none'`, or an object. Counted as unread
  // rather than absent, matching `readStrings` — and it matters more here than
  // there, because `evidenceSupportsAcceptance` keys the plain-accept button
  // on this field. Bailing to `undefined` rendered "None recorded" and left
  // the one-click accept live over test evidence nothing could read.
  if (!Array.isArray(value)) return { values: [], unread: 1 };
  const tests: NonNullable<Judgement['tests']> = [];
  let unread = 0;
  for (const item of value) {
    // `readableTest` is the rule, and it lives in `shared` because the server
    // refuses what it rejects while this counts the same thing as unread. The
    // two used to be separate implementations kept in step by a comment, which
    // is how the board comes to treat as readable a result the server calls
    // malformed.
    const test = readableTest(item);
    if (!test) {
      unread += 1;
      continue;
    }
    const summary = asRecord(item)?.['summary'];
    tests.push({ ...test, ...(typeof summary === 'string' ? { summary } : {}) });
  }
  return { values: tests, unread };
}

/**
 * A list the child wrote about itself, and how much of it could not be read.
 *
 * `undefined` means the field was absent — nobody reported any, which is a
 * real answer. Anything else present but unreadable counts as unread rather
 * than vanishing: a `risks` of `'none'`, or of `[{note: 'data loss'}]`, used
 * to render as "None reported", which affirmatively tells a reviewer the child
 * flagged nothing when the board simply could not read what it flagged. Risks
 * are the one self-reported field this panel treats as a safety signal, and
 * silence about them has to mean silence.
 */
function readStrings(value: unknown): { values: string[]; unread: number } | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return { values: [], unread: 1 };
  const values: string[] = [];
  let unread = 0;
  for (const item of value) {
    if (typeof item === 'string') values.push(item);
    else unread += 1;
  }
  return { values, unread };
}

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this judgement supports an acceptance without an override.
 *
 * The same bar the server applies, computed from the judgement the board is
 * already holding — so the button can say what it is going to do instead of
 * asking and being refused. The server decides; this only chooses the wording.
 *
 * `needs_human` is not a blocker on its own: it is what a green run gets,
 * because the policy will not accept on nobody's behalf. What blocks is a
 * rejection, or evidence with holes in it.
 */
export function evidenceSupportsAcceptance(judgement: Judgement | undefined): boolean {
  if (!judgement) return false;
  if (judgement.verdict === 'reject' || judgement.missing.length > 0) return false;
  // What this board could not read, and what it read and can see failed. The
  // first because a plain accept over evidence nobody could parse is not the
  // same offer as one over a complete green verdict. The second because the
  // panel draws `failed (1)` from this very object, and offering a one-click
  // acceptance beside it would be the board disagreeing with itself. Neither
  // should be reachable from today's `judge()`, which rejects a failing run —
  // both are the cheap half of not depending on that. The server stays the
  // authority either way; the reasoned override records why a human proceeded.
  if ((judgement.unreadTests ?? 0) > 0) return false;
  // Ancestry too. `judge()` refuses outright on it, and the panel paints
  // `Does not descend from base` in the failure colour — so a plain accept
  // beside that line would be the board contradicting itself. Reachable from
  // a build judging under `allowUnverifiedAncestry`, which leaves the fact in
  // the evidence while the verdict says nothing about it.
  if (judgement.descendsFromBase === false) return false;
  return !judgement.tests?.some((test) => test.exitCode !== 0);
}

/** A count of things, on the same terms the server records one. */
function readableCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
