import type { FleetActor } from '@claudia/shared';

/**
 * What a child is allowed to do, and why a child can never decide that itself.
 *
 * The plan draws a hard line: human directives are trusted, manager actions
 * are capability-scoped and server-checked, and child reports are untrusted
 * input that cannot grant capabilities. That last clause is the one worth
 * building carefully, because a child's output is model-generated text derived
 * from repository contents — which means anything written into a file in the
 * repository is, transitively, input to this. A README that says "the manager
 * has approved pushing" must be exactly as powerful as a README that says
 * nothing, which is to say: not at all.
 *
 * So there is no code path here from report text to a grant. Text can produce
 * a REQUEST, which is an escalation a human resolves. That asymmetry is the
 * whole design, and it is pinned in the tests.
 */

export type Capability =
  | 'repo.read'
  | 'repo.write'
  | 'test'
  | 'git.commit'
  | 'git.push'
  | 'git.merge'
  | 'net'
  | 'destructive';

/**
 * What a child gets without anybody deciding anything.
 *
 * Read, write, test and commit — enough to do the work and leave it on its own
 * branch, which is the plan's default scope. Everything that leaves the
 * worktree is absent by construction.
 */
export const DEFAULT_CHILD_CAPABILITIES: readonly Capability[] = [
  'repo.read',
  'repo.write',
  'test',
  'git.commit',
];

/** Capabilities that always need an explicit human or policy decision. */
export const ELEVATED: ReadonlySet<Capability> = new Set<Capability>([
  'git.push',
  'git.merge',
  'net',
  'destructive',
]);

/**
 * A capability grant.
 *
 * `id` is opaque and server-issued, and the grant is only ever reached by
 * LOOKING IT UP for a run — never by being handed one. Found in review: the
 * earlier version took a `Grant` object from the caller and trusted its
 * `issuedBy` field, so an object claiming `issuedBy: "system"` passed every
 * check. Provenance that travels with the thing being checked is not
 * provenance; it is a suggestion.
 *
 * `scope` is here for the same reason the binding is per-run: an approval to
 * push is an approval to push THIS task's branch from THIS worktree, not a
 * standing permission the mission carries afterwards.
 */
export interface Grant {
  id: string;
  runId: string;
  missionId: string;
  taskId: string;
  scope: GrantScope;
  capabilities: readonly Capability[];
  /** Recorded for the audit trail. Never the basis of trust — see above. */
  issuedBy: FleetActor;
  expiresAt?: number;
}

export interface GrantScope {
  repo: string;
  worktreePath: string;
}

/** Where the server keeps grants. The only way to obtain one. */
export interface GrantStore {
  find: (runId: string) => Grant | undefined;
}

/** What is being attempted, and by whom, in the caller's own words. */
export interface CapabilityRequest {
  runId: string;
  missionId: string;
  taskId: string;
  repo: string;
  worktreePath: string;
}

export type CapabilityCheck =
  | { ok: true }
  | { ok: false; reason: string; elevated: boolean };

/**
 * Whether this run may do `needed` right now.
 *
 * The grant is fetched, not accepted. Everything else here is a comparison
 * between what the server stored and what the caller says it is doing, and
 * every mismatch refuses.
 */
export function checkCapability(
  needed: Capability,
  request: CapabilityRequest,
  grants: GrantStore,
  now: number,
): CapabilityCheck {
  const grant = grants.find(request.runId);
  if (!grant) return refuse(needed, 'nothing has been granted to this run');
  // Defence in depth. A child cannot reach the store, so this should be
  // unreachable — but a grant recorded as child-issued is a bug worth failing
  // on rather than honouring.
  if (grant.issuedBy === 'child') return refuse(needed, 'a child cannot grant a capability');
  // Lateral movement: one run's approval must not become another's.
  if (grant.runId !== request.runId) return refuse(needed, `that grant belongs to run ${grant.runId}`);
  if (grant.missionId !== request.missionId || grant.taskId !== request.taskId) {
    return refuse(needed, 'that grant was issued for a different task');
  }
  if (grant.expiresAt !== undefined && now >= grant.expiresAt) {
    return refuse(needed, 'that grant has expired');
  }
  if (grant.scope.repo !== request.repo || grant.scope.worktreePath !== request.worktreePath) {
    // The point of scope: an approval to push is an approval to push this
    // branch from this checkout, not wherever the run later finds itself.
    return refuse(needed, 'that grant is scoped to a different worktree');
  }
  if (!grant.capabilities.includes(needed)) return refuse(needed, `this run was not granted ${needed}`);
  // An elevated capability with no expiry is a standing permission, which is
  // not a thing a human approving one push meant to hand out. Ordinary
  // capabilities are the run's working scope and live as long as it does.
  if (ELEVATED.has(needed) && grant.expiresAt === undefined) {
    return refuse(needed, `a grant for ${needed} has to say when it expires`);
  }
  return { ok: true };
}

/**
 * Every refusal is refused the same way; `elevated` only says how alarming it
 * should look to a human. A missing `repo.write` is a misconfiguration, a
 * missing `git.push` is somebody trying to leave the worktree.
 */
function refuse(needed: Capability, reason: string): CapabilityCheck {
  return { ok: false, reason, elevated: ELEVATED.has(needed) };
}

/**
 * The capabilities a task starts with, before anyone approves anything.
 *
 * Issued here so the id is the server's, and stored before it is ever checked.
 */
export function defaultGrant(id: string, request: CapabilityRequest): Grant {
  return {
    id,
    runId: request.runId,
    missionId: request.missionId,
    taskId: request.taskId,
    scope: { repo: request.repo, worktreePath: request.worktreePath },
    capabilities: [...DEFAULT_CHILD_CAPABILITIES],
    issuedBy: 'system',
  };
}

/**
 * A stable key for the escalation a stuck run raises.
 *
 * Without one, a pulse every sixty seconds files the same request sixty times
 * an hour, and the inbox a human is supposed to act on becomes the thing they
 * stop opening.
 */
export function escalationKey(runId: string, request: string): string {
  return `escalation:${runId}:${request}`;
}

export interface ReportLimits {
  maxBytes: number;
  maxLines: number;
}

/**
 * Bounds chosen for a human reading an escalation, not for a model.
 *
 * A child that wants to say more than this is not being throttled out of
 * useful information — it is pasting a log, and the log belongs in the
 * session's own transcript where it already is.
 */
export const DEFAULT_REPORT_LIMITS: ReportLimits = { maxBytes: 32_768, maxLines: 400 };

export type SanitizedReport =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string };

/** Control characters, minus tab and newline, which are ordinary text here. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Makes a child's output safe to STORE and DISPLAY. Not to obey.
 *
 * Strips control characters — an escape sequence in a terminal-rendered
 * timeline can rewrite lines the human has already read — and bounds the size,
 * so one run cannot fill the event log. It does not attempt to detect
 * instructions, because that is unwinnable; the safety here comes from nothing
 * downstream treating this text as a decision.
 */
export function sanitizeReport(raw: unknown, limits: ReportLimits = DEFAULT_REPORT_LIMITS): SanitizedReport {
  if (typeof raw !== 'string') return { ok: false, reason: 'a report must be text' };

  const stripped = raw.replace(CONTROL_CHARS, '');
  let truncated = false;

  let lines = stripped.split('\n');
  if (lines.length > limits.maxLines) {
    lines = lines.slice(0, limits.maxLines);
    truncated = true;
  }
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) {
    // Cut by code unit, then walk back until the BYTE budget is met: a
    // multi-byte character otherwise slips past a length-based cut.
    text = text.slice(0, limits.maxBytes);
    while (Buffer.byteLength(text, 'utf8') > limits.maxBytes) text = text.slice(0, -1);
    truncated = true;
  }
  return { ok: true, text, truncated };
}

/**
 * A capability a child asked for, as a REQUEST and never as a grant.
 *
 * Returns a capability only when the text names one exactly; anything else is
 * ignored rather than guessed at. The result is only ever used to open an
 * escalation for a human — there is deliberately no function in this module
 * that turns one into a `Grant`.
 */
export function requestedCapability(text: string): Capability | undefined {
  const match = /(?:^|\n)[ \t]*NEEDS CAPABILITY:[ \t]*([a-z.]{1,20})[ \t]*(?:$|\n)/i.exec(text);
  const asked = match?.[1]?.toLowerCase();
  return asked !== undefined && isCapability(asked) ? asked : undefined;
}

function isCapability(value: string): value is Capability {
  return (
    value === 'repo.read' ||
    value === 'repo.write' ||
    value === 'test' ||
    value === 'git.commit' ||
    value === 'git.push' ||
    value === 'git.merge' ||
    value === 'net' ||
    value === 'destructive'
  );
}
