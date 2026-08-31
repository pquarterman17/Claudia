/**
 * Which approvals an unattended run may clear for itself.
 *
 * Shared by every multi-agent run Claudia drives — the two-agent debate and
 * the crew that splits an objective — because they have the same problem and
 * must not answer it differently.
 *
 * This is not a convenience. Such a run has nobody watching, so a session
 * that parks on `canUseTool` waits for a human who is not coming — observed
 * live, and it is not a slow exchange, it is a dead one: the author sat at
 * `awaiting_approval` on a **Read**, zero tokens spent, until the turn timed
 * out. An orchestrator that cannot clear a read cannot read a repository at
 * all.
 *
 * The line is drawn at OBSERVATION. Reading, searching and listing are what a
 * reviewer needs and cannot damage anything; every write, command and network
 * call escalates to the human instead, because "clears the routine approvals"
 * must never quietly become "approves whatever it likes on your machine while
 * you are away". Anything not named here escalates — a tool this build has
 * never heard of is not routine by default.
 */

/**
 * Read-only tools, by exact name.
 *
 * A deny-list would be the wrong shape: a new writing tool added by either CLI
 * would arrive pre-approved. This allow-list means a new tool is escalated
 * until somebody decides otherwise, which is the safe direction to be wrong in.
 */
const OBSERVE_ONLY = new Set([
  // Claude Code
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoRead',
  // Codex, whose tool names come through the router with its own labels
  'Codex Read',
  'Codex Search',
]);

export function isRoutineUnattended(toolName: string): boolean {
  return OBSERVE_ONLY.has(toolName.trim());
}

/**
 * What to say when a run stops for a human.
 *
 * Names the tool, because "waiting for approval" without saying what for is
 * the thing that makes people stop trusting an unattended process.
 */
export function escalationReason(toolName: string): string {
  return `waiting on you to approve ${toolName} — an unattended run only clears read-only tools by itself`;
}
