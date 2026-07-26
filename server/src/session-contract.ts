import type {
  FeedStep,
  FeedStepPatch,
  PermissionLaunchMode,
  SessionSummary,
  SlashCommandInfo,
  TranscriptItem,
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
  /** Absent means: open the session and wait for the user to type. */
  prompt?: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
}
