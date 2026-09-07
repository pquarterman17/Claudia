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
  CrewStatus,
  DebateStatus,
  EffectiveSettings,
  Escalation,
  FeedStep,
  FeedStepPatch,
  FileCheckpoint,
  FileMatch,
  FleetEvent,
  FleetLimits,
  HostPlatform,
  McpServerInfo,
  Mission,
  ModelChoice,
  ObservedSession,
  PermissionLaunchMode,
  SavedSession,
  SessionSummary,
  SessionTemplate,
  SlashCommandInfo,
  Task,
  ToolkitAction,
  TranscriptItem,
  TriggerStatus,
  WorktreeState,
} from './index.js';
import type { UsageSnapshot } from './usage.js';

// ---------- server → client ----------

/**
 * What one mission has spent, as far as anything can tell.
 *
 * `tokens` is `null` when even one of its runs could not be measured — a run
 * whose session ended before anything read it, or a row written before the
 * column existed. NOT zero: the fleet holds a mission whose spend it cannot
 * read, on the standing bias that an unknown is not permission, and a board
 * that drew that as "0 spent" would show headroom the mission does not have.
 * `null` rather than NaN because this crosses JSON, which has no other word
 * for it.
 */
export interface MissionSpendReport {
  missionId: string;
  elapsedSec: number;
  tokens: number | null;
}

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
      /** Fleet-wide ceilings, so a fresh page knows them before anything changes. */
      fleetLimits: FleetLimits;
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
  /** A cross-agent exchange, pushed on every turn so it can be watched live. */
  | { type: 'debate'; debate: DebateStatus }
  | { type: 'crew'; crew: CrewStatus }
  | {
      type: 'settings';
      recentDirectories: string[];
      countdownSec: number;
      stopSessionsWhenClosedSec: number;
      defaultPermissionMode: PermissionLaunchMode;
      templates: SessionTemplate[];
      toolkit: ToolkitAction[];
      customCeilings?: { sessionTokens: number; weeklyTokens: number };
      /** Fleet-wide ceilings. Always sent, because "unset" is not a limit. */
      fleetLimits: FleetLimits;
    }
  /** Result of a browse_folder request; empty when the user cancelled. */
  | { type: 'folders_picked'; paths: string[] }
  /** Something worth telling the user that is NOT a failure — what was written
   * to their settings, and where the backup went. */
  | { type: 'notice'; message: string }
  | { type: 'missions'; missions: Mission[]; spend: MissionSpendReport[] }
  /**
   * What one mission has spent, as its own pulse just measured it.
   *
   * Pushed rather than polled, and pushed from the pulse rather than on a
   * timer of its own: the pulse is when the number changes AND when it is
   * enforced, so a board fed by it shows what the budget decision was made on.
   * Between pulses the figure is the last one measured, which is also the last
   * one that meant anything.
   */
  | { type: 'mission_spend'; spend: MissionSpendReport }
  | { type: 'tasks'; missionId: string; tasks: Task[] }
  /**
   * A page of history, in reply to `get_fleet_events`.
   *
   * A page, and it says so — which the first version did not. It answered with
   * a bare array capped at the store's default 500, ascending from the oldest,
   * and the client kept the newest 200 of whatever arrived. A mission with
   * 1,200 events therefore rendered events 301–500 as if they were current and
   * said nothing about the 700 after them. `more` and `elided` are how a page
   * admits to being one.
   */
  | {
      type: 'fleet_events';
      missionId: string;
      events: FleetEvent[];
      /** Events BEFORE this batch that were not sent, as `mirror_opened` reports. */
      elided: number;
      /** Events AFTER it. Ask again with `throughSeq`. */
      more: boolean;
      /**
       * The sequence this page is authoritative up to — ask for the next one
       * from HERE, not from the last event received.
       *
       * They are different numbers whenever the window was sparse, and the
       * difference is not cosmetic. A mission's sequences skip every number
       * another mission used, so a 500-wide window can contain none of this
       * mission's events at all. A client continuing from its last event would
       * then advance by one sequence per round trip and need six hundred of
       * them to cross a gap this says nothing is in.
       */
      throughSeq: number;
      /**
       * Set when the client must DISCARD what it holds before applying this.
       *
       * Its cursor could not be replayed — pruned out from under it, or ahead
       * of a log that was rebuilt — so merging would splice a fresh page onto
       * a history that never led to it. The string is why, for the human.
       */
      reset?: string;
    }
  /** The decisions a mission is waiting on, newest first. */
  | { type: 'escalations'; missionId: string; escalations: Escalation[] }
  /**
   * The backlog for a newly mirrored session, tail-first.
   *
   * `elided` is how many steps were dropped off the front. A long transcript is
   * not a payload, and saying nothing about the cut would let a viewer read a
   * partial conversation as a complete one.
   */
  | { type: 'mirror_opened'; sessionId: string; transcript: TranscriptItem[]; feed: FeedStep[]; elided: number }
  /** One step, as it is read. */
  | { type: 'mirror_step'; sessionId: string; step: FeedStep }
  /** A revision to a step already sent, possibly in the backlog. */
  | { type: 'mirror_patch'; sessionId: string; stepId: string; patch: FeedStepPatch }
  | { type: 'mirror_item'; sessionId: string; item: TranscriptItem }
  /**
   * There is nothing to read: no transcript on this machine, or it cannot be
   * opened. A normal answer rather than an error — a session running on another
   * machine, or on the web, has no local log and never will.
   */
  | { type: 'mirror_unavailable'; sessionId: string; reason: string }
  /**
   * One event, as it is appended.
   *
   * Broadcast AFTER its transaction commits, never during: a sequence number
   * announced by a transaction that then rolls back is a number the log will
   * hand to a different event, and a client holding it would never be shown
   * the real one. `onCommit` in the store is what makes that ordering true.
   */
  | { type: 'fleet_event'; event: FleetEvent }
  /**
   * The mission layer is not available this run — the database would not open.
   * Sent instead of failing every command separately, so the UI can say so once
   * rather than a client inferring it from a string of refusals.
   */
  | { type: 'fleet_unavailable'; reason: string }
  /**
   * What a worktree cleanup would do, or what it did.
   *
   * One event for both phases because they carry the same rows and the human
   * reads them the same way: a list of directories with a sentence each. The
   * plan requires cleanup to be previewable and refuses unsafe deletion, so
   * `preview` is the only way to reach `applied` in the UI — and `applied`
   * repeats every entry's verdict rather than only the successes, because the
   * one a person most wants to see is the one that did not go.
   */
  | { type: 'worktree_cleanup'; missionId: string; phase: 'preview' | 'applied'; entries: WorktreeCleanupEntry[] }
  | { type: 'server_error'; message: string };

/** One directory in a cleanup plan, with the reason it is or is not going. */
export interface WorktreeCleanupEntry {
  worktreeId: string;
  path: string;
  branch: string;
  state: WorktreeState;
  /** Whether the rules would let this one go, before anything was attempted. */
  removable: boolean;
  reason: string;
  /** Only in the `applied` phase, and only for the ones that were attempted. */
  removed?: boolean;
  /** Why git or the store refused, when one of them did. */
  error?: string;
}
