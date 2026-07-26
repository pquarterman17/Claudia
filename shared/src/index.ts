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
 * already allowlisted.
 */
export type PermissionLaunchMode = 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions';

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
  cwd: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
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

/** 'auto' derives a reference from the user's own history; the rest are estimates. */
export type PlanTier = 'auto' | 'pro' | 'max5x' | 'max20x' | 'custom';

export interface UsageWindow {
  label: string;
  hours: number;
  tokens: TokenCounts;
  /** Pricing-weighted total — cache reads counted at 10%, as billing does. */
  billableTokens: number;
  /** What the bar is measured against. Null when there's too little history. */
  referenceTokens: number | null;
  /** Where the reference came from, e.g. "typical for you". */
  referenceLabel: string;
  remainingPct: number | null;
  level: 'ok' | 'low' | 'critical';
}

export interface ProjectUsage {
  project: string;
  billableTokens: number;
  outputTokens: number;
}

export interface UsageSnapshot {
  tier: PlanTier;
  windows: UsageWindow[];
  byProject: ProjectUsage[];
  byModel: Array<{ model: string; billableTokens: number }>;
  /** When the local logs were last scanned. */
  scannedAt: number;
  /** True while the first (potentially slow) scan is still running. */
  scanning: boolean;
}

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
    }
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
  | { type: 'set_countdown'; seconds: number }
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
