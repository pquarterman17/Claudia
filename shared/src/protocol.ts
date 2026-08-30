/**
 * The websocket wire protocol: every event the server pushes and every command
 * the client sends. This IS the server/UI contract — if a field is not here,
 * the two halves cannot agree on it.
 *
 * Split out of index.ts rather than raising the module-size ceiling. index.ts
 * describes the domain (sessions, feed steps, triggers); this file describes
 * how those cross the wire. Re-exported from index.ts, so `@claudia/shared`
 * consumers import from one place as before.
 */
import type {
  AgentKind,
  ChainStep, ContextUsage, EffectiveSettings, EffortLevel, FeedStep, FeedStepPatch,
  FileCheckpoint, FinishActionKey, HostPlatform, McpServerInfo, ModelChoice,
  PermissionLaunchMode, PromptImage, SavedSession, SessionSummary, SessionTemplate,
  FileMatch,
  ObservedSession,
  SlashCommandInfo,
  ToolkitAction, ThinkingMode, TranscriptItem, TriggerStatus,
} from './index.js';
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
      toolkit: ToolkitAction[];
      customCeilings?: { sessionTokens: number; weeklyTokens: number };
      mcp: Record<string, McpServerInfo[]>;
      observed: ObservedSession[];
      /** Whether the global hook that feeds `observed` is currently installed. */
      monitoring: boolean;
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
  | { type: 'file_matches'; sessionId: string; query: string; matches: FileMatch[] }
  | { type: 'mcp_status'; sessionId: string; servers: McpServerInfo[] }
  | { type: 'effective_settings'; sessionId: string; settings: EffectiveSettings }
  /** Full transcript backfill, answering get_transcript. */
  | { type: 'transcript'; sessionId: string; items: TranscriptItem[] }
  /** Incremental transcript growth, broadcast as the session runs. */
  | { type: 'transcript_append'; sessionId: string; item: TranscriptItem }
  | { type: 'saved_sessions'; sessions: SavedSession[] }
  | { type: 'saved_session_detail'; sessionId: string; checkpoints: FileCheckpoint[] }
  | { type: 'usage'; usage: UsageSnapshot }
  /** Terminal sessions Claudia did not launch, seen through global hooks. */
  | { type: 'observed_sessions'; sessions: ObservedSession[]; monitoring: boolean }
  | {
      type: 'settings';
      recentDirectories: string[];
      countdownSec: number;
      stopSessionsWhenClosedSec: number;
      defaultPermissionMode: PermissionLaunchMode;
      templates: SessionTemplate[];
      toolkit: ToolkitAction[];
      customCeilings?: { sessionTokens: number; weeklyTokens: number };
    }
  /** Result of a browse_folder request; empty when the user cancelled. */
  | { type: 'folders_picked'; paths: string[] }
  /** Something worth telling the user that is NOT a failure — what was written
   * to their settings, and where the backup went. */
  | { type: 'notice'; message: string }
  | { type: 'server_error'; message: string };

// ---------- client → server ----------

export type ClientCommand =
  | {
      type: 'launch_session';
      cwd: string;
      /** Which agent to run. Defaults to Claude when absent. */
      agent?: AgentKind;
      /**
       * Create (or reuse) a git worktree for this branch and run the session
       * there, leaving the checkout you are looking at untouched.
       */
      worktreeBranch?: string;
      /** Optional — an empty session opens idle and waits for a prompt. */
      prompt?: string;
      model?: string;
      permissionMode?: PermissionLaunchMode;
      effortLevel?: EffortLevel;
      thinkingMode?: ThinkingMode;
    }
  | { type: 'list_saved_sessions'; cwd?: string }
  | { type: 'get_saved_session_detail'; sessionId: string; cwd?: string }
  | { type: 'resume_saved_session'; sessionId: string; cwd: string; agent?: AgentKind; permissionMode?: PermissionLaunchMode }
  /** Resumes into a new Claude conversation branch (file checkpoints are not copied). */
  | { type: 'fork_saved_session'; sessionId: string; cwd: string; agent?: AgentKind; permissionMode?: PermissionLaunchMode }
  | { type: 'rename_saved_session'; sessionId: string; cwd?: string; title: string }
  | { type: 'tag_saved_session'; sessionId: string; cwd?: string; tag: string | null }
  | { type: 'rewind_files'; sessionId: string; checkpointId: string }
  | { type: 'send_prompt'; sessionId: string; text: string; images?: import('./prompt-image.js').PromptImage[] }
  | { type: 'approve'; sessionId: string; requestId: string }
  | { type: 'deny'; sessionId: string; requestId: string; message?: string }
  /**
   * Writes the pending call's exact-match allow rule into the project's
   * .claude/settings.local.json, then approves that call. The server
   * re-derives the rule from its own stored input rather than trusting
   * whatever the client echoes back — see gate-actions.ts.
   */
  | { type: 'always_allow_project'; sessionId: string; requestId: string }
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
  | { type: 'get_mcp_status'; sessionId: string }
  | { type: 'reconnect_mcp'; sessionId: string; serverName: string }
  | { type: 'toggle_mcp'; sessionId: string; serverName: string; enabled: boolean }
  | { type: 'get_effective_settings'; sessionId: string }
  | { type: 'stop_task'; sessionId: string; taskId: string }
  | { type: 'get_transcript'; sessionId: string }
  /** Seconds after the last browser closes before sessions stop; 0 disables. */
  | { type: 'set_stop_on_close'; seconds: number }
  /** Saves (or overwrites, by name) a reusable launch shape. */
  | { type: 'save_template'; template: SessionTemplate }
  /** Fuzzy file search under a session's directory, for @-mention completion. */
  /** Install or remove the global hook that reveals terminal sessions.
   * Writes the owner's ~/.claude/settings.json, so it is never implicit. */
  | { type: 'set_hook_monitor'; enabled: boolean }
  | { type: 'search_files'; sessionId: string; query: string }
  /** Switch the output style; takes effect on the next turn, like the model does. */
  | { type: 'set_output_style'; sessionId: string; style: string }
  /** Point one session at a different agent. Always starts a fresh
   * conversation — the two agents cannot resume each other's history. */
  | { type: 'set_agent'; sessionId: string; agent: AgentKind }
  | { type: 'save_toolkit_action'; action: ToolkitAction }
  | { type: 'delete_toolkit_action'; id: string }
  | { type: 'delete_template'; name: string }
  /** Liveness beat from a page that is actually running. See CLIENT_PING_MS. */
  | { type: 'ping' };

/**
 * How often a live page announces itself. A socket that stops beating is
 * treated as gone even if TCP still looks connected — which happens for real:
 * Firefox keeps a navigated-away page and its WebSocket alive in the
 * back/forward cache, and a sleeping laptop leaves half-open sockets behind.
 */
