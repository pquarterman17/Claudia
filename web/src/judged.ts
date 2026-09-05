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
  descendsFromBase?: boolean;
}

const VERDICTS = new Set(['accept', 'reject', 'needs_human']);

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
  return {
    verdict: verdict as Judgement['verdict'],
    reason: typeof record['reason'] === 'string' ? record['reason'] : '',
    missing: Array.isArray(record['missing']) ? record['missing'].filter((m): m is string => typeof m === 'string') : [],
    ...(typeof evidence['filesChanged'] === 'number' ? { filesChanged: evidence['filesChanged'] } : {}),
    ...(typeof evidence['branch'] === 'string' ? { branch: evidence['branch'] } : {}),
    ...(typeof evidence['descendsFromBase'] === 'boolean'
      ? { descendsFromBase: evidence['descendsFromBase'] }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
