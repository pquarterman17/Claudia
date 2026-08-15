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

/**
 * Mirrors the SDK's PermissionMode. 'auto' lets Claude decide what genuinely
 * needs asking and is the sensible default; 'default' asks about everything not
 * already allowlisted; 'plan' is the terminal's Shift+Tab research mode —
 * Claude reads and proposes but cannot edit or run commands.
 */
export type PermissionLaunchMode = 'auto' | 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** Runtime reasoning controls supported by the Claude Agent SDK. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingMode = 'adaptive' | 'disabled';

/** Last measured context-window occupancy, captured from Claude Code's `/context`. */
export interface ContextUsage {
  model?: string;
  usedTokens: number;
  maxTokens: number;
  usedPct: number;
  freeTokens?: number;
  fetchedAt: number;
}

/**
 * A sub-agent spawned by a Task step, nested under it in the feed.
 *
 * The SDK reports tokens, tool count and duration per sub-agent, but not cost
 * and not the model — `agentType` is the agent kind ("general-purpose"), not a
 * model id. Tokens are shown because they are real; a per-sub-agent cost would
 * have to be invented.
 */
export interface SubAgentRun {
  taskId: string;
  agentType: string;
  /** What it is doing right now, as the SDK reports it. */
  description: string;
  lastTool?: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  status: 'running' | 'completed' | 'error';
  summary?: string;
}

/** One abstracted step in a session's activity feed (the prototype's "feed" view). */
export interface FeedStep {
  id: string;
  ts: number;
  kind: 'read' | 'edit' | 'bash' | 'tool' | 'text' | 'approval' | 'result' | 'info' | 'error';
  title: string;
  meta?: string;
  durMs?: number;
  /** Tool steps start 'running' and are patched once their result arrives. */
  status?: 'running' | 'ok' | 'error';
  /** Sub-agents spawned by this step, for Task calls. */
  subAgents?: SubAgentRun[];
}

/** Fields of an existing feed step that a later event can revise. */
export type FeedStepPatch = Pick<FeedStep, 'durMs' | 'status' | 'meta' | 'subAgents'>;

/**
 * Claude finished its turn but is waiting on the user — it asked a question, or
 * hit a decision it cannot make alone. Comes from the SDK's `post_turn_summary`,
 * so it is structured rather than guessed from the text of the reply.
 */
export interface NeedsAction {
  /** What it wants, e.g. "reply: tabs, or spaces (2 or 4)?" */
  request: string;
  /** Why it stopped, e.g. "indentation style choice needed". */
  detail?: string;
  since: number;
}

/**
 * A multiple-choice question from Claude, rendered as a picker rather than as a
 * permission prompt. The answer travels back through the same callback.
 */
export interface PendingQuestion {
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: Array<{ label: string; description: string }>;
  }>;
  requestedAt: number;
}

export interface PendingApproval {
  requestId: string;
  toolName: string;
  /** Human-readable one-liner, e.g. the bash command or file being edited. */
  summary: string;
  requestedAt: number;
}

/**
 * Per-model cumulative usage, taken from the SDK result message's `modelUsage`.
 * Keyed by model because plan windows are per-model (the weekly Opus allowance is
 * separate from weekly all-models), and one session can touch several models —
 * a subagent on Haiku bills alongside the main Opus turn.
 */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface SessionSummary {
  id: string;
  /** Display name — basename of cwd. */
  name: string;
  /** Auto-generated from the task (like terminal tab titles), or user-set. */
  title?: string;
  cwd: string;
  model?: string;
  /** A model the user picked that has not run yet — the SDK applies it next turn. */
  selectedModel?: string;
  permissionMode: PermissionLaunchMode;
  effortLevel: EffortLevel;
  thinkingMode: ThinkingMode;
  contextUsage?: ContextUsage;
  contextPending: boolean;
  state: SessionState;
  startedAt: number;
  lastActivityAt: number;
  /** Cumulative session cost. Authoritative; from result messages only. */
  costUsd: number;
  /** Cumulative totals summed across models. Updated at turn end, not mid-turn. */
  inputTokens: number;
  outputTokens: number;
  modelUsage: ModelUsage[];
  /** Claude Code session id (for resume), once known from the init message. */
  claudeSessionId?: string;
  pendingApproval?: PendingApproval;
  /** Set when the turn ended with a question rather than a conclusion. */
  needsAction?: NeedsAction;
  /** Set while Claude is waiting on a multiple-choice answer. */
  pendingQuestion?: PendingQuestion;
  /** Last error message when state === 'error'. */
  errorMessage?: string;
  /** Prompts sent while a turn was in flight, FIFO order. Empty when nothing is queued. */
  queuedPrompts: string[];
}

export interface SavedSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  cwd?: string;
  tag?: string;
  customTitle?: string;
}

/** A user-message file checkpoint; rewind restores files, not conversation history. */
export interface FileCheckpoint { messageId: string; label: string; }

// ---------- terminal parity ----------

/** One model the CLI offers, from the SDK's supportedModels(). */
export interface ModelChoice {
  value: string;
  displayName: string;
  description: string;
}

/**
 * One slash command the CLI knows, from the SDK's supportedCommands() or,
 * when that call is unavailable, the bare names the init message advertises.
 */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** One entry in a session's full conversation transcript. */
export interface TranscriptItem {
  ts: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';
  /** Full text — never truncated; that is the point of the transcript. */
  text: string;
  toolName?: string;
}

// ---------- finish trigger ----------

export type FinishActionKey = 'notify' | 'memory' | 'commit' | 'sleep' | 'shutdown' | 'script';

export type TriggerState = 'disarmed' | 'armed' | 'counting' | 'running' | 'fired';

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** One link in the finish chain. Steps run in order, each awaiting the last. */
export interface ChainStep {
  key: FinishActionKey;
  state: StepState;
  /** Outcome text — what it did, or why it failed. */
  detail?: string;
  durMs?: number;
  /** The actual command that will run on this host. */
  command: string;
  destructive: boolean;
}

export interface TriggerStatus {
  state: TriggerState;
  /** Ordered chain. Empty means nothing is configured to run. */
  chain: ChainStep[];
  /** Seconds left before firing; present only while counting. */
  countdownSec?: number;
  /** Human-readable reason the trigger is held. Absent when nothing blocks it. */
  blockedBy?: string;
  firedAt?: number;
  /** Summary of the last run — e.g. "3 of 4 steps, stopped at Shut down host". */
  lastResult?: string;
  /** True if any step is destructive; arming then needs an explicit confirm. */
  destructive: boolean;
}

export type HostPlatform = 'win32' | 'darwin' | 'linux';

// ---------- templates ----------

/** A saved launch shape: same repo, same kind of prompt, same permission posture. */
export interface SessionTemplate {
  name: string;
  cwd: string;
  prompt?: string;
  permissionMode: PermissionLaunchMode;
}

// ---------- usage ----------

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Re-exported so `@claudia/shared` keeps one entry point; also imported as
// types because the protocol definitions below reference them directly.
export * from './usage.js';
import type { PlanTier, UsageSnapshot } from './usage.js';

// ---------- server → client ----------

export type ServerEvent =
  | {
      type: 'hello';
      sessions: SessionSummary[];
      feeds: Record<string, FeedStep[]>;
      trigger: TriggerStatus;
      platform: HostPlatform;
      usage: UsageSnapshot;
      recentDirectories: string[];
      countdownSec: number;
      stopSessionsWhenClosedSec: number;
      defaultPermissionMode: PermissionLaunchMode;
      templates: SessionTemplate[];
      customCeilings?: { sessionTokens: number; weeklyTokens: number };
    }
  | { type: 'session_upsert'; session: SessionSummary }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'feed_append'; sessionId: string; step: FeedStep }
  | { type: 'feed_update'; sessionId: string; stepId: string; patch: FeedStepPatch }
  /** The reply currently being streamed; null once the complete message lands. */
  | { type: 'draft'; sessionId: string; text: string | null }
  | { type: 'trigger_status'; trigger: TriggerStatus }
  /** Models the CLI offers, fetched per session on demand. */
  | { type: 'models'; sessionId: string; models: ModelChoice[] }
  /** Slash commands this session's CLI knows (from init; includes user skills). */
  | { type: 'session_commands'; sessionId: string; commands: SlashCommandInfo[] }
  /** Full transcript backfill, answering get_transcript. */
  | { type: 'transcript'; sessionId: string; items: TranscriptItem[] }
  /** Incremental transcript growth, broadcast as the session runs. */
  | { type: 'transcript_append'; sessionId: string; item: TranscriptItem }
  | { type: 'saved_sessions'; sessions: SavedSession[] }
  | { type: 'saved_session_detail'; sessionId: string; checkpoints: FileCheckpoint[] }
  | { type: 'usage'; usage: UsageSnapshot }
  | {
      type: 'settings';
      recentDirectories: string[];
      countdownSec: number;
      stopSessionsWhenClosedSec: number;
      defaultPermissionMode: PermissionLaunchMode;
      templates: SessionTemplate[];
      customCeilings?: { sessionTokens: number; weeklyTokens: number };
    }
  /** Result of a browse_folder request; empty when the user cancelled. */
  | { type: 'folders_picked'; paths: string[] }
  | { type: 'server_error'; message: string };

// ---------- client → server ----------

export type ClientCommand =
  | {
      type: 'launch_session';
      cwd: string;
      /** Optional — an empty session opens idle and waits for a prompt. */
      prompt?: string;
      model?: string;
      permissionMode?: PermissionLaunchMode;
      effortLevel?: EffortLevel;
      thinkingMode?: ThinkingMode;
    }
  | { type: 'list_saved_sessions'; cwd?: string }
  | { type: 'get_saved_session_detail'; sessionId: string; cwd?: string }
  | { type: 'resume_saved_session'; sessionId: string; cwd: string; permissionMode?: PermissionLaunchMode }
  /** Resumes into a new Claude conversation branch (file checkpoints are not copied). */
  | { type: 'fork_saved_session'; sessionId: string; cwd: string; permissionMode?: PermissionLaunchMode }
  | { type: 'rename_saved_session'; sessionId: string; cwd?: string; title: string }
  | { type: 'tag_saved_session'; sessionId: string; cwd?: string; tag: string | null }
  | { type: 'rewind_files'; sessionId: string; checkpointId: string }
  | { type: 'send_prompt'; sessionId: string; text: string }
  | { type: 'approve'; sessionId: string; requestId: string }
  | { type: 'deny'; sessionId: string; requestId: string; message?: string }
  /** Answers keyed by question text, as the AskUserQuestion tool expects. */
  | { type: 'answer_question'; sessionId: string; requestId: string; answers: Record<string, string> }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'stop_session'; sessionId: string }
  | { type: 'remove_session'; sessionId: string }
  /** Opens a native folder dialog on the server host; replies with folder_picked. */
  | { type: 'browse_folder' }
  /** Change a live session's permission mode — how you revoke skip-permissions. */
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionLaunchMode }
  /** Put every session back on standard approvals. */
  | { type: 'require_approvals_everywhere' }
  /** Adds the action to the end of the chain, or removes it if already present. */
  | { type: 'toggle_finish_action'; action: FinishActionKey }
  /** Swaps the action with its neighbor; a no-op at either edge. */
  | { type: 'move_finish_action'; action: FinishActionKey; direction: 'up' | 'down' }
  | { type: 'clear_finish_chain' }
  /** `confirmDestructive` must be true to arm shutdown — the server re-checks. */
  | { type: 'arm_trigger'; confirmDestructive?: boolean }
  | { type: 'disarm_trigger' }
  | { type: 'bulk'; op: 'approve_all' | 'interrupt_all' }
  | { type: 'set_plan_tier'; tier: PlanTier }
  /** Ceilings the user has calibrated themselves, used when tier === 'custom'. */
  | { type: 'set_custom_ceilings'; sessionTokens: number; weeklyTokens: number }
  /**
   * Sends `/cost` to a live session and captures its reply as real plan
   * usage. Costs that session tokens and adds two lines to its transcript —
   * user-triggered only, never sent on a timer.
   */
  | { type: 'fetch_real_usage'; sessionId: string }
  | { type: 'set_countdown'; seconds: number }
  /** Empty title reverts to the auto-generated one. */
  | { type: 'rename_session'; sessionId: string; title: string }
  | { type: 'set_model'; sessionId: string; model: string }
  | { type: 'set_effort'; sessionId: string; effortLevel: EffortLevel }
  | { type: 'set_thinking'; sessionId: string; thinkingMode: ThinkingMode }
  /** Sends `/context` and captures its real token-window report. */
  | { type: 'refresh_context'; sessionId: string }
  | { type: 'get_models'; sessionId: string }
  /** Structured commands via supportedCommands(); replies with session_commands. */
  | { type: 'get_commands'; sessionId: string }
  | { type: 'get_transcript'; sessionId: string }
  /** Seconds after the last browser closes before sessions stop; 0 disables. */
  | { type: 'set_stop_on_close'; seconds: number }
  /** Saves (or overwrites, by name) a reusable launch shape. */
  | { type: 'save_template'; template: SessionTemplate }
  | { type: 'delete_template'; name: string }
  /** Liveness beat from a page that is actually running. See CLIENT_PING_MS. */
  | { type: 'ping' };

/**
 * How often a live page announces itself. A socket that stops beating is
 * treated as gone even if TCP still looks connected — which happens for real:
 * Firefox keeps a navigated-away page and its WebSocket alive in the
 * back/forward cache, and a sleeping laptop leaves half-open sockets behind.
 */
export const CLIENT_PING_MS = 5_000;
export const CLIENT_STALE_MS = 20_000;

export const CLAUDIA_PORT = 4317;
