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

/** The latest judgement for one task, or nothing if it has not been judged. */
export function judgementFor(events: readonly FleetEvent[] | undefined, taskId: string): Judgement | undefined {
  let latest: Judgement | undefined;
  for (const event of events ?? []) {
    if (event.kind !== 'task_judged' || event.taskId !== taskId) continue;
    const read = readJudgement(event.payload);
    // Kept only if it parses. A malformed payload should leave the previous
    // good one standing rather than blanking the panel.
    if (read) latest = read;
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
    ...(tests !== undefined ? { tests } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(typeof evidence['prState'] === 'string' && PR_STATES.has(evidence['prState'])
      ? { prState: evidence['prState'] as Judgement['prState'] }
      : {}),
    ...(risks !== undefined ? { risks } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(typeof record['checks'] === 'string' ? { checks: record['checks'] } : {}),
  };
}

function readTests(value: unknown): Judgement['tests'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tests: NonNullable<Judgement['tests']> = [];
  for (const item of value) {
    const test = asRecord(item);
    if (!test || typeof test['command'] !== 'string' || typeof test['exitCode'] !== 'number') continue;
    tests.push({
      command: test['command'],
      exitCode: test['exitCode'],
      ...(typeof test['summary'] === 'string' ? { summary: test['summary'] } : {}),
    });
  }
  return tests;
}

function readStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
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
  return judgement.verdict !== 'reject' && judgement.missing.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
