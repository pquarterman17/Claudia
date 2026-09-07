import type { FleetEvent } from '@claudia/shared';

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

const VERDICTS = new Set(['accept', 'reject', 'needs_human']);
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
 * The first version of this reset on `task_reported`, which read well and was
 * not sound. That note is written only when the task's own status move
 * succeeds — `applyTaskIntent` returns earlier when another run still holds
 * the task, and again when the route is refused — while `judgeReported` judges
 * every reported run regardless. So the marker went missing in exactly the
 * overlapping-attempt cases it was there for. Run identity is on every event
 * instead, which is a fact about the claim rather than a side effect of a
 * transition, and it is the same thing `accept_task` scopes by server-side.
 */
export function judgementFor(events: readonly FleetEvent[] | undefined, taskId: string): Judgement | undefined {
  const mine = (events ?? []).filter((event) => event.taskId === taskId);
  const current = currentRun(mine);
  let latest: Judgement | undefined;
  for (const event of mine) {
    if (event.kind !== 'task_judged') continue;
    // A judgement that does not name the current run cannot be shown to
    // describe it. Refusing it costs an override, with its reason; accepting
    // it would spend one attempt's evidence on another.
    if (current !== undefined && event.runId !== current) continue;
    const read = readJudgement(event.payload);
    // Kept only if it parses. A malformed payload should leave the previous
    // good one standing rather than blanking the panel.
    if (read) latest = read;
  }
  return latest;
}

/**
 * The attempt the log last said anything about.
 *
 * Any run-scoped event will do — a report, a verdict, a run that ended while
 * its task was held. Events are seq-ordered by both merge paths in
 * `fleet-state.ts`, and attempts are sequential, so the last one named is the
 * newest attempt that has done anything at all.
 *
 * `undefined` means no event here names a run, which is what a log written
 * before runs were denormalised onto events looks like. There the old
 * behaviour — the newest verdict, whichever attempt it belongs to — is the
 * only answer available, and it is what this returns to.
 */
function currentRun(events: readonly FleetEvent[]): string | undefined {
  let current: string | undefined;
  for (const event of events) if (event.runId !== undefined) current = event.runId;
  return current;
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
    ...(typeof evidence['filesChanged'] === 'number' ? { filesChanged: evidence['filesChanged'] } : {}),
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
  if (!Array.isArray(value)) return undefined;
  const tests: NonNullable<Judgement['tests']> = [];
  let unread = 0;
  for (const item of value) {
    const test = asRecord(item);
    if (!test || typeof test['command'] !== 'string' || typeof test['exitCode'] !== 'number') {
      unread += 1;
      continue;
    }
    tests.push({
      command: test['command'],
      exitCode: test['exitCode'],
      ...(typeof test['summary'] === 'string' ? { summary: test['summary'] } : {}),
    });
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
  // If this client could not read every result, it cannot honestly present the
  // same plain-accept path as a complete green verdict. The server remains the
  // authority; the reasoned override records why the human proceeded despite
  // what this board could not show.
  return judgement.verdict !== 'reject' && judgement.missing.length === 0 && (judgement.unreadTests ?? 0) === 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
