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
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingMode = 'adaptive' | 'disabled';
export interface ContextUsage {
  model?: string;
  usedTokens: number;
  maxTokens: number;
  usedPct: number;
  freeTokens?: number;
  fetchedAt: number;
}

/** A local image attached to one prompt. The browser sends bytes, never a file path. */
export type { PromptImage } from './prompt-image.js';

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

export type { ApprovalChange, SessionTodo } from './session-review.js';
import type { ApprovalChange, SessionTodo } from './session-review.js';
/** Claude finished its turn but is waiting on the user — it asked a question, or
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
  /** A bounded, typed preview for file mutations. Never contains raw tool input. */
  change?: ApprovalChange;
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

/**
 * Which coding agent backs a session.
 *
 * Claudia was built around Claude Code, but the machinery below it -- the state
 * machine, feed, approval gate, transcript -- never depended on that. A Codex
 * session is driven through `codex app-server`, whose approval requests park
 * exactly like a Claude `canUseTool` call, which is what lets one board hold
 * both kinds of tile.
 */
export type AgentKind = 'claude' | 'codex';

export interface SessionSummary {
  id: string;
  /** Which agent backs this session. Absent means Claude, for older clients. */
  agent?: AgentKind;
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
  /** Latest structured TodoWrite list, when the active session uses that tool. */
  todos: SessionTodo[];
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

export * from './operations.js';
import type { EffectiveSettings, McpServerInfo } from './operations.js';

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Re-exported so `@claudia/shared` keeps one entry point; also imported as
// types because the protocol definitions below reference them directly.
export * from './usage.js';
export * from './protocol.js';
import type { PlanTier, UsageSnapshot } from './usage.js';

export const CLIENT_PING_MS = 5_000;
export const CLIENT_STALE_MS = 20_000;

export const CLAUDIA_PORT = 4317;
