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

/**
 * Who may issue a grant at all.
 *
 * `manager` is deliberately absent. It is a model, and its context is fed by
 * child reports that come from repository contents — the exact injection path
 * this module exists to break. A grant it writes is a suggestion.
 */
const TRUSTED_ISSUERS: ReadonlySet<string> = new Set<string>(['human', 'system']);

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
  // An ALLOW-list. Rejecting only `child` let every other value through —
  // `manager`, `undefined`, and `Child`, which defeated the check on a capital
  // letter. The manager is a model whose context is fed by child reports drawn
  // from repository files, so a grant it writes is a suggestion, not authority.
  if (!TRUSTED_ISSUERS.has(grant.issuedBy)) {
    return refuse(needed, `a grant issued by ${String(grant.issuedBy)} is not honoured`);
  }
  // Lateral movement: one run's approval must not become another's.
  if (grant.runId !== request.runId) return refuse(needed, `that grant belongs to run ${grant.runId}`);
  if (grant.missionId !== request.missionId || grant.taskId !== request.taskId) {
    return refuse(needed, 'that grant was issued for a different task');
  }
  // A non-finite deadline satisfied neither `now >= expiresAt` nor the
  // `=== undefined` check below, so `NaN` — one bad `Number(...)` in an
  // approval handler — produced a permanent elevated grant through the very
  // rule written to prevent standing permissions.
  if (!Number.isFinite(now)) return refuse(needed, 'the clock is not usable');
  if (grant.expiresAt !== undefined && !(Number.isFinite(grant.expiresAt) && now < grant.expiresAt)) {
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
  if (ELEVATED.has(needed) && !Number.isFinite(grant.expiresAt)) {
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
  // Encoded, because a raw join collides: ('r1', 'a:b') and ('r1:a', 'b')
  // produced the same key, and the key is unique in the store — so two
  // different runs' requests would merge into one inbox row and a human would
  // approve something other than what they read.
  return `escalation:${encodeURIComponent(runId)}:${encodeURIComponent(request)}`;
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

/**
 * Control characters minus tab and newline — CARRIAGE RETURN included.
 *
 * CR was missed, and it is the exact attack the stripping exists to stop:
 * `tests: 3 FAILED\rtests: all passed` renders in any CR-honouring view as
 * "tests: all passed" while the stored record says the opposite. A child can
 * show a human a false green. It also broke the line bound, since a
 * CR-delimited report is one line to `split('\n')`.
 *
 * The bidirectional overrides go too: they reorder rendered text without
 * changing the bytes, which is the same lie by a different mechanism.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

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
  // Found by audit: with a non-positive byte budget the trimming loop below
  // never terminates — `''.slice(0, -1)` is `''`, so the condition stays true
  // forever. A synchronous infinite loop on the server's event loop, reached
  // from a config value. `planResync` already refuses an unusable `maxBatch`
  // for exactly this class; this validated nothing.
  if (!usableLimit(limits.maxBytes) || !usableLimit(limits.maxLines)) {
    return { ok: false, reason: 'the report limits are not usable' };
  }

  const stripped = raw.replace(CONTROL_CHARS, '');
  let truncated = false;

  let lines = stripped.split('\n');
  if (lines.length > limits.maxLines) {
    lines = lines.slice(0, limits.maxLines);
    truncated = true;
  }
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) {
    text = cutToBytes(text, limits.maxBytes);
    truncated = true;
  }
  return { ok: true, text, truncated };
}

/**
 * Truncates to a byte budget in one pass, on a character boundary.
 *
 * The previous version cut by code unit and then walked back one unit at a
 * time, re-measuring the whole string each step. Found by audit and measured:
 * clean quadratic, 4x per doubling of the budget, and at the SHIPPED defaults a
 * 1.2 MB report of multi-byte text cost 482ms of synchronous work on the event
 * loop — against 2.6ms for the same byte count in ASCII, so it was the
 * walk-back and not the size. A caller-chosen 512 KiB budget did not finish in
 * two minutes. The earlier fix removed `forever` and left `long`.
 *
 * It also cut mid-surrogate: the orphan's replacement-character encoding
 * satisfied the byte budget, so the loop stopped with a lone surrogate still in
 * the output. This function exists to produce text safe to store and display,
 * and a lone surrogate silently becomes U+FFFD on any UTF-8 round trip — so the
 * stored record and the byte count stop agreeing with what was sanitized.
 *
 * Buffer.write reports how many bytes it wrote without ever splitting a
 * character, so the truncation and the boundary are the same operation.
 */
function cutToBytes(text: string, maxBytes: number): string {
  const room = Buffer.allocUnsafe(maxBytes);
  const written = room.write(text, 0, maxBytes, 'utf8');
  return room.toString('utf8', 0, written);
}

/** A bound has to be a whole number above zero to be a bound at all. */
function usableLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
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
  // \r accepted around the line: Windows is the platform this app is developed
  // on, and a CRLF child request matched nothing — so it was never escalated
  // and the run simply stalled until its timeout.
  const match = /(?:^|\r?\n)[ \t]*NEEDS CAPABILITY:[ \t]*([a-z.]{1,20})[ \t]*(?:$|\r?\n)/i.exec(text);
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
