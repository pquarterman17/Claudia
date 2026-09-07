import type {
  AgentKind,
  FeedStep,
  FeedStepPatch,
  EffortLevel,
  PermissionLaunchMode,
  SessionSummary,
  SlashCommandInfo,
  TranscriptItem,
  ThinkingMode,
} from '@claudia/shared';

/** How a session reports back to whoever owns it (the manager → gateway → UI). */
export interface SessionCallbacks {
  onUpdate: (summary: SessionSummary) => void;
  onFeed: (sessionId: string, step: FeedStep) => void;
  onFeedPatch: (sessionId: string, stepId: string, patch: FeedStepPatch) => void;
  /** The reply as it streams; null clears it once the full message lands. */
  onDraft: (sessionId: string, text: string | null) => void;
  /** Slash commands the CLI knows for this session, from the init message. */
  onCommands: (sessionId: string, commands: SlashCommandInfo[]) => void;
  /** A new full-transcript entry — the terminal-parity view's growth event. */
  onTranscript: (sessionId: string, item: TranscriptItem) => void;
}

export interface LaunchOptions {
  cwd: string;
  /** Which agent backs this session. Absent means Claude. */
  agent?: AgentKind;
  /** Absent means: open the session and wait for the user to type. */
  prompt?: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
  effortLevel?: EffortLevel;
  thinkingMode?: ThinkingMode;
  resume?: string;
  forkSession?: boolean;
  /**
   * A refusal this session's tool calls are graded against before a human sees
   * them, or nothing for a session nobody has bounded.
   *
   * Server-side only and deliberately a function: it closes over what the
   * caller knows about the session, and the fleet's version closes over the
   * capability grant issued to a run. A launch spec that could carry the
   * allowed capabilities as DATA would be one a client could send.
   */
  toolPolicy?: ToolPolicy;
}

/** Returns a reason to refuse `toolName`, or nothing to let it through. */
export type ToolPolicy = (toolName: string, input: Record<string, unknown>) => string | undefined;
