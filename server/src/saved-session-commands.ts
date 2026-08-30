import type { ClientCommand, ServerEvent } from '@claudia/shared';
import { allSavedSessions, retagSavedSession, retitleSavedSession, savedSessionDetail } from './saved-sessions.js';
import { resumeSavedSession } from './launch-session.js';
import type { SessionManager } from './session-manager.js';
import type { SettingsStore } from './settings-store.js';

export interface SavedSessionCtx {
  manager: SessionManager;
  settings: SettingsStore;
  /** Answers the one socket that asked; a history listing is not board state. */
  reply: (event: ServerEvent) => void;
}

/**
 * Commands about conversations on disk, rather than sessions on the board.
 *
 * A separate domain from everything else the gateway dispatches: these read
 * and retitle history written by another process, and none of them touches a
 * live session except by starting a new one from an old conversation. Pulled
 * out because gateway.ts sits permanently against the size ceiling — it has
 * hit it four times in one day — and "the resume picker's commands" is a real
 * seam rather than an arbitrary slice.
 *
 * Every one of these reads files another process wrote, so each already
 * degrades to "nothing to show" rather than rejecting; the `void` calls here
 * cannot produce an unhandled rejection that would end the supervisor.
 *
 * Returns false for anything it does not own, so the caller's switch carries on.
 */
export function handleSavedSessionCommand(cmd: ClientCommand, ctx: SavedSessionCtx): boolean {
  switch (cmd.type) {
    case 'list_saved_sessions':
      void allSavedSessions(cmd.cwd).then((sessions) => ctx.reply({ type: 'saved_sessions', sessions }));
      return true;
    case 'get_saved_session_detail':
      void savedSessionDetail(cmd.sessionId, cmd.cwd).then((checkpoints) =>
        ctx.reply({ type: 'saved_session_detail', sessionId: cmd.sessionId, checkpoints }),
      );
      return true;
    case 'resume_saved_session':
    case 'fork_saved_session':
      resumeSavedSession(cmd, ctx.manager, ctx.settings);
      return true;
    case 'rename_saved_session':
      void retitleSavedSession(cmd.sessionId, cmd.title, cmd.cwd).then(() => relist(cmd.cwd, ctx));
      return true;
    case 'tag_saved_session':
      void retagSavedSession(cmd.sessionId, cmd.tag, cmd.cwd).then(() => relist(cmd.cwd, ctx));
      return true;
    default:
      return false;
  }
}

/** Re-reads the listing after an edit, so the picker shows the new title or
 * tag without the user having to reopen it. */
function relist(cwd: string | undefined, ctx: SavedSessionCtx): void {
  void allSavedSessions(cwd).then((sessions) => ctx.reply({ type: 'saved_sessions', sessions }));
}
