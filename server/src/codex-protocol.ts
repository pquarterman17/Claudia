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

/**
 * Server -> client requests that must be answered or the turn stalls.
 *
 * There are two generations of these and a live CLI uses the newer pair, so
 * handling only the documented legacy names means every approval is refused
 * and the agent reports "shell approval failed" — measured against
 * codex-cli 0.151.0 before both were supported.
 *
 * They do NOT share a decision vocabulary: the legacy pair answers with
 * ReviewDecision ("approved" / {denied:{rejection}}), the modern pair with
 * "accept" / "decline".
 */
export const APPROVAL_METHOD = {
  /** Legacy. */
  exec: 'execCommandApproval',
  patch: 'applyPatchApproval',
  /** Current. */
  execRequest: 'item/commandExecution/requestApproval',
  patchRequest: 'item/fileChange/requestApproval',
  /** A request to widen the sandbox, answered with a permission grant. */
  permissionsRequest: 'item/permissions/requestApproval',
} as const;

/** True when a method answers with the modern accept/decline vocabulary. */
export function usesModernDecision(method: string): boolean {
  return method === APPROVAL_METHOD.execRequest || method === APPROVAL_METHOD.patchRequest;
}

/** A decision Claudia can return. Deny carries a reason the agent reads. */
export type CodexDecision =
  | { kind: 'approved' }
  | { kind: 'approved_for_session' }
  | { kind: 'denied'; rejection: string }
  | { kind: 'abort' };

/**
 * Encodes a decision for the wire, in the vocabulary the asking method expects.
 *
 * Getting this wrong does not error — the turn simply never resumes, or the
 * agent reports an approval failure and gives up on the command.
 *
 * Legacy (ReviewDecision): unit variants are bare strings, but `denied` is a
 * struct variant and must be an object.
 * Modern: every variant is a bare string.
 */
export function encodeDecision(decision: CodexDecision, method: string = APPROVAL_METHOD.exec): unknown {
  if (usesModernDecision(method)) {
    switch (decision.kind) {
      case 'denied':
        return 'decline';
      case 'approved_for_session':
        return 'acceptForSession';
      case 'abort':
        return 'cancel';
      default:
        return 'accept';
    }
  }
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

/**
 * Codex's own permission vocabulary, and how Claudia's modes map onto it.
 *
 * Values verified against `codex app-server generate-json-schema` for the
 * installed CLI: approvalPolicy is "untrusted" | "on-request" | "never", and
 * sandbox is "read-only" | "workspace-write" | "danger-full-access".
 *
 * Without these, thread/start uses Codex's defaults and commands run with no
 * approval at all — measured: a real session executed a shell command without
 * ever asking, which silently defeats the point of supervising it.
 */
export interface CodexPermissions {
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export function codexPermissions(mode: string): CodexPermissions {
  switch (mode) {
    case 'bypassPermissions':
      // "Skip all" means what it says on both sides.
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'plan':
      // Research without changing anything: the sandbox enforces it.
      return { approvalPolicy: 'untrusted', sandbox: 'read-only' };
    case 'acceptEdits':
      // Edits inside the workspace land; anything beyond it still asks.
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'default':
      // Ask for anything not already trusted.
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    default:
      // 'auto' — Codex decides when it needs to escalate.
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}
