/**
 * Claudia WS protocol — the single contract between server and web UI.
 * Server → client: ServerEvent. Client → server: ClientCommand.
 */

export type SessionState =
  | 'starting'
  | 'working'
  | 'awaiting_approval'
  | 'idle'
  | 'error'
  | 'stopped';

export type PermissionLaunchMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** One abstracted step in a session's activity feed (the prototype's "feed" view). */
export interface FeedStep {
  id: string;
  ts: number;
  kind: 'read' | 'edit' | 'bash' | 'tool' | 'text' | 'approval' | 'result' | 'info' | 'error';
  title: string;
  meta?: string;
  durMs?: number;
}

export interface PendingApproval {
  requestId: string;
  toolName: string;
  /** Human-readable one-liner, e.g. the bash command or file being edited. */
  summary: string;
  requestedAt: number;
}

export interface SessionSummary {
  id: string;
  /** Display name — basename of cwd. */
  name: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
  state: SessionState;
  startedAt: number;
  lastActivityAt: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Claude Code session id (for resume), once known from the init message. */
  claudeSessionId?: string;
  pendingApproval?: PendingApproval;
  /** Last error message when state === 'error'. */
  errorMessage?: string;
}

// ---------- server → client ----------

export type ServerEvent =
  | { type: 'hello'; sessions: SessionSummary[]; feeds: Record<string, FeedStep[]> }
  | { type: 'session_upsert'; session: SessionSummary }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'feed_append'; sessionId: string; step: FeedStep }
  | { type: 'server_error'; message: string };

// ---------- client → server ----------

export type ClientCommand =
  | {
      type: 'launch_session';
      cwd: string;
      prompt: string;
      model?: string;
      permissionMode?: PermissionLaunchMode;
    }
  | { type: 'send_prompt'; sessionId: string; text: string }
  | { type: 'approve'; sessionId: string; requestId: string }
  | { type: 'deny'; sessionId: string; requestId: string; message?: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'stop_session'; sessionId: string }
  | { type: 'remove_session'; sessionId: string };

export const CLAUDIA_PORT = 4317;
