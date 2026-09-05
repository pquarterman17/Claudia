import type { ClientCommand, ServerEvent } from '@claudia/shared';
import type { SessionManager } from './session-manager.js';

/**
 * Commands that ACT on one session, as opposed to asking it something.
 *
 * Split out of gateway.ts when the mirror commands pushed it against the size
 * ceiling, along the seam its neighbours already use: `session-queries`,
 * `session-settings`, `saved-session` and `settings-command` are each a cluster
 * of the router's cases lifted into a module that answers whether it handled
 * the command. This is the mutating half of the pair `session-queries` split
 * off — every case here changes something about one session, and the two that
 * reply do so because the caller is owed an answer, not because anyone else is
 * watching.
 */

export interface SessionActionDeps {
  manager: SessionManager;
  reply(event: ServerEvent): void;
}

export function handleSessionActionCommand(cmd: ClientCommand, deps: SessionActionDeps): boolean {
  const { manager, reply } = deps;
  switch (cmd.type) {
    case 'send_prompt':
      manager.get(cmd.sessionId)?.sendPrompt(cmd.text, cmd.images);
      return true;
    case 'approve':
      manager.get(cmd.sessionId)?.approve(cmd.requestId);
      return true;
    case 'deny':
      manager.get(cmd.sessionId)?.deny(cmd.requestId, cmd.message);
      return true;
    case 'always_allow_project':
      void manager
        .get(cmd.sessionId)
        ?.alwaysAllowProject(cmd.requestId)
        .then((r) => {
          if (!r.ok) reply({ type: 'server_error', message: r.message });
        });
      return true;
    case 'answer_question':
      manager.get(cmd.sessionId)?.answerQuestion(cmd.requestId, cmd.answers);
      return true;
    case 'interrupt':
      void manager.get(cmd.sessionId)?.interrupt();
      return true;
    case 'get_transcript':
      reply({
        type: 'transcript',
        sessionId: cmd.sessionId,
        items: manager.get(cmd.sessionId)?.transcript.list() ?? [],
      });
      return true;
    case 'stop_session':
      manager.get(cmd.sessionId)?.stop();
      return true;
    case 'remove_session':
      manager.remove(cmd.sessionId);
      return true;
    case 'rename_session':
      manager.get(cmd.sessionId)?.rename(cmd.title);
      return true;
    case 'set_permission_mode':
      void manager.get(cmd.sessionId)?.setPermissionMode(cmd.mode);
      return true;
    case 'refresh_context':
      manager.get(cmd.sessionId)?.refreshContext();
      return true;
    case 'stop_task':
      void manager.get(cmd.sessionId)?.stopTask(cmd.taskId)?.catch(() => undefined);
      return true;
    default:
      return false;
  }
}
