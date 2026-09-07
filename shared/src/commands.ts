/**
 * Client → server: every command the UI can send.
 *
 * Split from `protocol.ts` at that file's own divider when it reached the
 * module-size ceiling. The two halves were always separate contracts — one is
 * what the server announces, the other is what it will be asked, and only the
 * first is broadcast to everybody. Re-exported from the package index, so no
 * consumer changes.
 */
import type {
  AgentKind,
  DebateSubject,
  EffortLevel,
  EscalationResolution,
  FinishActionKey,
  HumanResolution,
  MissionWatch,
  PermissionLaunchMode,
  SessionTemplate,
  TaskStatus,
  ThinkingMode,
  ToolkitAction,
} from './index.js';
import type { PlanTier } from './usage.js';

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
  /** Fleet-wide child and attempt ceilings. Clamped server-side; a value out
   * of range is corrected rather than refused, and the reply says what stuck. */
  | { type: 'set_fleet_limits'; maxChildren: number; maxAttempts: number }
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
  /** Hand one problem to two agents and let them argue it out. Spends turns on
   * both with nobody watching, so the server bounds the rounds. */
  | {
      type: 'start_debate';
      cwd: string;
      objective: string;
      subject: DebateSubject;
      /** Reuse this tile as the author; absent launches a fresh one. */
      authorSessionId?: string;
      author: AgentKind;
      reviewer: AgentKind;
      rounds: number;
    }
  /** Split one objective into pieces and work them at the same time. Each
   * member gets its own worktree, so parallel edits cannot overwrite one
   * another; `maxTasks` is the human's cap on how much quota this may spend. */
  | {
      type: 'start_crew';
      cwd: string;
      objective: string;
      /** Splits the objective and writes the closing report. */
      planner: AgentKind;
      /** Dealt round-robin to the pieces; one entry means one agent does all. */
      workers: AgentKind[];
      maxTasks: number;
    }
  | { type: 'save_toolkit_action'; action: ToolkitAction }
  | { type: 'delete_toolkit_action'; id: string }
  | { type: 'delete_template'; name: string }
  /** Liveness beat from a page that is actually running. See CLIENT_PING_MS. */
  /**
   * The mission layer's commands.
   *
   * Deliberately small: create, read, and the watch switch. Everything that
   * SPENDS anything — dispatching a run, retrying, accepting work — belongs to
   * the dispatcher and the watchdog, which decide by policy rather than by a
   * socket asking. A client can describe work and ask what happened; it cannot
   * reach past that and start something.
   */
  /** `agent` chooses the harness the mission's children run on; absent means Claude. */
  | { type: 'create_mission'; name: string; body: string; cwd: string; agent?: AgentKind; verify?: string }
  | { type: 'list_missions' }
  | { type: 'set_mission_watch'; missionId: string; watch: MissionWatch }
  /** The empty string clears it, which is how a mission stops being checked. */
  | { type: 'set_mission_verify'; missionId: string; verify: string }
  /**
   * A mission's own ceilings. `null` clears one — which is the only way back to
   * unlimited, and the reason both fields are required rather than optional:
   * "absent" would otherwise mean both "leave it alone" and "remove it".
   */
  | { type: 'set_mission_budget'; missionId: string; budgetSec: number | null; budgetTokens: number | null }
  | {
      type: 'create_task';
      missionId: string;
      title: string;
      description: string;
      cwd: string;
      dependsOn?: string[];
      /** Human-authored definition of done, passed to the child and shown at review. */
      acceptance?: string;
    }
  | { type: 'list_tasks'; missionId: string }
  /**
   * Move a task through its lifecycle — chiefly `proposed -> ready`, which is
   * how a human says a described task may actually be worked on.
   *
   * Found by running the fleet end to end rather than in tests: `create_task`
   * lands in `proposed`, the reconciler only dispatches `ready`, and there was
   * no command between the two. Every test moved the row directly, which no
   * client can do, so the whole mission layer was unreachable from the wire.
   * The store still decides which transitions are legal; this only asks.
   */
  | { type: 'set_task_status'; missionId: string; taskId: string; status: TaskStatus }
  /**
   * Acceptance, which is not a status change: the server reads the verdict the
   * pulse recorded before it agrees. `override` is a reason, required to
   * accept over a rejection or over incomplete evidence, and recorded with it.
   */
  | { type: 'accept_task'; missionId: string; taskId: string; override?: string }
  /** `afterSeq` is the client's high-water mark; 0 asks for the whole log. */
  | { type: 'get_fleet_events'; missionId: string; afterSeq?: number }
  /** Pending by default; pass a resolution to read what was already decided. */
  | { type: 'list_escalations'; missionId: string; resolution?: EscalationResolution }
  /**
   * Answer one. `approved` and `denied` are the human's; `withdrawn` says the
   * question stopped mattering. `expired` is the clock's and is not offered,
   * and `pending` is not a resolution — the store refuses both.
   */
  | { type: 'resolve_escalation'; missionId: string; escalationId: string; resolution: HumanResolution; note?: string }
  /**
   * What a worktree cleanup would do. Reads git, writes nothing, and is the
   * only way to reach `remove_worktrees` — the plan requires managed cleanup
   * to preview branches and worktrees before it refuses or removes anything.
   */
  | { type: 'preview_worktree_cleanup'; missionId: string }
  /**
   * Remove the directories a person picked out of a preview.
   *
   * `worktreeIds` is what they chose, not a filter: a plan recomputed a minute
   * later is not the list they read, and a record that appeared in between is
   * one nobody agreed to. `confirmedUnmerged` is per worktree for the same
   * reason it is in `CleanupOptions` — approving one unmerged removal in a
   * preview must not authorise every unmerged one beside it.
   */
  | { type: 'remove_worktrees'; missionId: string; worktreeIds: string[]; confirmedUnmerged?: string[] }
  /**
   * Follow a session Claudia does not own, by reading its transcript.
   *
   * On demand rather than always: the usage reader already sweeps every log on
   * the machine for totals, but reconstructing a conversation is per-session
   * work and only worth doing for the one somebody is looking at.
   */
  | { type: 'mirror_session'; sessionId: string }
  | { type: 'close_mirror'; sessionId: string }
  /**
   * This page is unloading for good — a closed tab, or a reload about to
   * happen. Sent on `pagehide`, best effort.
   *
   * The server cannot otherwise tell a closed tab from a frozen one: a sleeping
   * laptop and a bfcached page both leave a socket that looks alive with nobody
   * behind it, which is why sessions get a grace period at all. This says the
   * page is genuinely going away, so the only thing left to wait for is a
   * reload coming back — a much shorter question than "is anyone still there".
   */
  | { type: 'closing' }
  | { type: 'ping' };

/**
 * How often a live page announces itself. A socket that stops beating is
 * treated as gone even if TCP still looks connected — which happens for real:
 * Firefox keeps a navigated-away page and its WebSocket alive in the
 * back/forward cache, and a sleeping laptop leaves half-open sockets behind.
 */
