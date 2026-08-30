import type { ClientCommand } from '@claudia/shared';
import type { SessionManager } from './session-manager.js';

/**
 * Commands that change one setting on one live session.
 *
 * Five cases with the same shape — find the session, tell it, let it announce
 * itself in its own feed — which is a different job from the dispatch around
 * them in gateway.ts, where the interesting cases reach across sessions or
 * touch the filesystem. Returns false for anything it does not own so the
 * caller's switch carries on.
 *
 * A missing session is silently ignored on purpose: every one of these arrives
 * from a tile the user is looking at, and the only way to hit a stale id is a
 * session that was removed between the click and the socket, where there is
 * nothing useful left to say.
 */
export function handleSessionSettingCommand(cmd: ClientCommand, manager: SessionManager): boolean {
  switch (cmd.type) {
    case 'set_model':
      void manager.get(cmd.sessionId)?.switchModel(cmd.model);
      return true;
    case 'set_effort':
      void manager.get(cmd.sessionId)?.setEffort(cmd.effortLevel);
      return true;
    case 'set_thinking':
      void manager.get(cmd.sessionId)?.setThinking(cmd.thinkingMode);
      return true;
    case 'set_output_style':
      void manager.get(cmd.sessionId)?.setOutputStyle(cmd.style);
      return true;
    case 'set_agent':
      // Synchronous, unlike the others: switching agent replaces the driver
      // rather than asking a live one to change its mind.
      manager.get(cmd.sessionId)?.switchAgent(cmd.agent);
      return true;
    default:
      return false;
  }
}
