import type { ClientCommand, ServerEvent } from '@claudia/shared';
import type { SessionManager } from './session-manager.js';

/**
 * Commands that ask ONE session something and answer the socket that asked.
 *
 * Split out of gateway.ts when it crossed the size ceiling, along the seam its
 * neighbours already use: `session-settings`, `saved-session` and
 * `settings-command` are each a cluster of the router's cases lifted into a
 * module that returns whether it handled the command. This is the next such
 * cluster, and the one with the clearest shared shape — every case here is a
 * question whose answer goes back to one client, never a broadcast, because
 * nobody else asked.
 *
 * The MCP pair mutate and then re-answer with the same status the query case
 * sends. They live here rather than with the mutations for that reason: what a
 * caller gets back is the status reply, and keeping the two spellings of it in
 * one file is what stops them drifting.
 */

export interface SessionQueryDeps {
  manager: SessionManager;
  reply(event: ServerEvent): void;
}

export function handleSessionQueryCommand(cmd: ClientCommand, deps: SessionQueryDeps): boolean {
  const { manager, reply } = deps;
  switch (cmd.type) {
    case 'get_models':
      manager
        .get(cmd.sessionId)
        ?.models()
        .then((models) => reply({ type: 'models', sessionId: cmd.sessionId, models }));
      return true;
    case 'get_commands':
      manager
        .get(cmd.sessionId)
        ?.commands()
        .then((commands) => reply({ type: 'session_commands', sessionId: cmd.sessionId, commands }));
      return true;
    case 'get_mcp_status':
      sendMcpStatus(cmd.sessionId, deps);
      return true;
    case 'reconnect_mcp':
      manager
        .get(cmd.sessionId)
        ?.reconnectMcp(cmd.serverName)
        ?.catch(() => undefined)
        .then(() => sendMcpStatus(cmd.sessionId, deps));
      return true;
    case 'toggle_mcp':
      manager
        .get(cmd.sessionId)
        ?.toggleMcp(cmd.serverName, cmd.enabled)
        ?.catch(() => undefined)
        .then(() => sendMcpStatus(cmd.sessionId, deps));
      return true;
    case 'get_effective_settings':
      void manager
        .get(cmd.sessionId)
        ?.effectiveSettings()
        .then((settings) => {
          // Only when there is something to say: a session that cannot report
          // its settings is not the same as one whose settings are empty, and
          // sending an empty object would make the UI show the second.
          if (settings) reply({ type: 'effective_settings', sessionId: cmd.sessionId, settings });
        });
      return true;
    default:
      return false;
  }
}

function sendMcpStatus(sessionId: string, { manager, reply }: SessionQueryDeps): void {
  manager
    .get(sessionId)
    ?.mcpStatus()
    .then((servers) => reply({ type: 'mcp_status', sessionId, servers }));
}
