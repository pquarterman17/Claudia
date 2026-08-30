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
 * A capability grant, bound to one run.
 *
 * Bound rather than ambient because the alternative — a mission-wide grant —
 * means approving a push for one task silently approves it for every task the
 * mission ever starts, including ones created after the human said yes.
 */
export interface Grant {
  runId: string;
  capabilities: readonly Capability[];
  issuedBy: FleetActor;
  expiresAt?: number;
}

export type CapabilityCheck =
  | { ok: true }
  | { ok: false; reason: string; elevated: boolean };

/**
 * Whether `runId` may do `needed` right now.
 *
 * Refuses a grant issued by a child outright, before looking at anything else.
 * A grant is a decision, and a child does not get to make one even if it
 * somehow constructed a well-formed object.
 */
export function checkCapability(
  needed: Capability,
  grant: Grant | undefined,
  runId: string,
  now: number,
): CapabilityCheck {
  if (!grant) return refuse(needed, 'nothing has been granted to this run');
  if (grant.issuedBy === 'child') return refuse(needed, 'a child cannot grant a capability');
  // Lateral movement: one run's approval must not become another's.
  if (grant.runId !== runId) return refuse(needed, `that grant belongs to run ${grant.runId}`);
  if (grant.expiresAt !== undefined && now >= grant.expiresAt) {
    return refuse(needed, 'that grant has expired');
  }
  if (!grant.capabilities.includes(needed)) return refuse(needed, `this run was not granted ${needed}`);
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

/** The capabilities a task starts with, before anyone approves anything. */
export function defaultGrant(runId: string): Grant {
  return { runId, capabilities: [...DEFAULT_CHILD_CAPABILITIES], issuedBy: 'system' };
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
