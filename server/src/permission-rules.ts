/**
 * Pure derivation of a Claude Code settings permission rule from one
 * approved tool call. No file I/O — this must be safe to call just to
 * decide whether the "always allow" button appears at all, and testable
 * without touching disk.
 *
 * This button grants STANDING permission with no further human in the
 * loop, so "cannot be sure it's narrow" and "cannot derive anything at
 * all" are treated identically: both return undefined, and the caller
 * must offer no button rather than fall back to a broader guess.
 *
 * The rule is always an EXACT match — never a prefix wildcard. Claude
 * Code's own syntax supports a `:*` prefix suffix (seen live in a
 * resolved effective config as `Bash(npm run test:*)`), but appending
 * one here would let the standing rule reach past the single call the
 * user actually approved: a rule derived from "npm run build" with
 * `:*` tacked on would also silently allow "npm run build && rm -rf /".
 * An exact match can never cover more than the literal string that was
 * approved, which is what "never broader than the request" requires.
 */

// Only tool names Claude Code's own permission engine understands. A Codex
// tool call ('Codex Command' / 'Codex Patch' — see codex-driver.ts) rides
// the same approval gate as Claude's, but a rule written for either would
// sit in .claude/settings.local.json doing nothing, since Codex never reads
// that file. Keying off the literal tool name — not which agent is running
// — is what makes writing a useless rule structurally impossible rather
// than something a future caller has to remember to check.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
// Deliberately excludes Glob/Grep: both can carry `pattern` *and* `path`
// at once, and which one should stand in for "the thing the user approved"
// isn't something the given facts settle. Guessing wrong there would mean
// writing a rule for the wrong specifier — better to offer no button.
const PATH_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);

// Long enough for any real command or path; short enough to reject the
// kind of oversized "input" an adversarial or buggy caller might hand
// this, which would otherwise become a multi-KB line in a settings file.
const MAX_SPECIFIER_LENGTH = 500;

/** "*", "**", "* *": nothing but wildcard/space characters — never specific. */
function isBareWildcard(value: string): boolean {
  return /^[\s*]+$/.test(value);
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

/** The literal text that would sit inside ToolName(...), or undefined if unsafe. */
function sanitizeSpecifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SPECIFIER_LENGTH) return undefined;
  if (isBareWildcard(trimmed)) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined; // could hide a second command from the one-line preview
  return trimmed;
}

/** Escapes the one character that would break out of the rule's own parens. */
function escapeSpecifier(value: string): string {
  return value.replaceAll(')', '\\)');
}

/**
 * Returns the exact settings rule text this approval justifies, or
 * undefined when nothing specific and safe can be derived. Callers must
 * treat undefined as "offer no button" — never substitute a broader guess.
 */
export function deriveAllowRule(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!toolName) return undefined;

  if (COMMAND_TOOLS.has(toolName)) {
    const command = sanitizeSpecifier(input['command']);
    return command ? `${toolName}(${escapeSpecifier(command)})` : undefined;
  }

  if (PATH_TOOLS.has(toolName)) {
    const path = sanitizeSpecifier(input['file_path']);
    if (!path || hasParentTraversal(path)) return undefined;
    return `${toolName}(${escapeSpecifier(path)})`;
  }

  return undefined;
}
