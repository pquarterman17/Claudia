/**
 * Wire types for `codex app-server`, the JSON-RPC interface OpenAI's own IDE
 * extensions use. This is the only Codex surface that can broker approvals:
 * the `@openai/codex-sdk` package sets an approvalPolicy but has no callback,
 * so a UI cannot decide per command with it.
 *
 * Three details are easy to get wrong and are the reason this file exists:
 *
 * 1. The `"jsonrpc": "2.0"` member is OMITTED on the wire, unlike ordinary
 *    JSON-RPC. Messages are newline-delimited JSON over stdio.
 * 2. Approval decisions are a Rust enum serialised snake_case. Unit variants
 *    are bare strings ("approved"), but DENY is a struct variant and must be
 *    an object: {"denied": {"rejection": "..."}}. Sending the string "deny"
 *    -- as some third-party write-ups claim -- leaves the turn hanging.
 * 3. Ignoring an approval request hangs the agent's turn indefinitely. There
 *    is no timeout on the server side, which is exactly why Claudia's gate
 *    parks it and waits for a human instead of guessing.
 *
 * Shapes here were read from the codex source (protocol/src/protocol.rs,
 * app-server/README.md), not inferred from blog posts.
 */

/** Client -> server methods this driver uses. */
export const METHOD = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
} as const;

/** Server -> client requests that must be answered or the turn stalls. */
export const APPROVAL_METHOD = {
  exec: 'execCommandApproval',
  patch: 'applyPatchApproval',
} as const;

/** A decision Claudia can return. Deny carries a reason the agent reads. */
export type CodexDecision =
  | { kind: 'approved' }
  | { kind: 'approved_for_session' }
  | { kind: 'denied'; rejection: string }
  | { kind: 'abort' };

/**
 * Encodes a decision for the wire. Unit variants serialise as bare strings;
 * `denied` carries a payload, so it becomes an object. Getting this wrong does
 * not error — the turn simply never resumes.
 */
export function encodeDecision(decision: CodexDecision): unknown {
  switch (decision.kind) {
    case 'denied':
      return { denied: { rejection: decision.rejection } };
    case 'approved_for_session':
      return 'approved_for_session';
    case 'abort':
      return 'abort';
    default:
      return 'approved';
  }
}

/** An exec approval request, as the server sends it. */
export interface ExecApprovalParams {
  conversationId?: string;
  callId?: string;
  approvalId?: string;
  command?: string[];
  cwd?: string;
  reason?: string | null;
}

/** A patch approval request. `fileChanges` is keyed by absolute path. */
export interface PatchApprovalParams {
  conversationId?: string;
  callId?: string;
  fileChanges?: Record<string, unknown>;
  reason?: string | null;
  grantRoot?: string;
}

/** One line off the wire: a response, a server-initiated request, or an event. */
export interface CodexFrame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}
