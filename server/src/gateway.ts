import type { ClientCommand, ServerEvent } from '@claudia/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionManager } from './session-manager.js';

/** WS fan-out plus command dispatch. One gateway serves every connected browser. */
export class Gateway {
  private wss: WebSocketServer;
  private manager!: SessionManager;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  attach(manager: SessionManager): void {
    this.manager = manager;
    this.wss.on('connection', (socket) => {
      this.sendTo(socket, {
        type: 'hello',
        sessions: manager.summaries(),
        feeds: manager.feedSnapshot(),
      });
      socket.on('message', (raw) => {
        let cmd: ClientCommand;
        try {
          cmd = JSON.parse(String(raw)) as ClientCommand;
        } catch {
          this.sendTo(socket, { type: 'server_error', message: 'Malformed command JSON' });
          return;
        }
        try {
          this.dispatch(cmd);
        } catch (err) {
          this.sendTo(socket, {
            type: 'server_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  private sendTo(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  private dispatch(cmd: ClientCommand): void {
    switch (cmd.type) {
      case 'launch_session':
        this.manager.launch({
          cwd: cmd.cwd,
          prompt: cmd.prompt,
          model: cmd.model,
          permissionMode: cmd.permissionMode ?? 'default',
        });
        return;
      case 'send_prompt':
        this.manager.get(cmd.sessionId)?.sendPrompt(cmd.text);
        return;
      case 'approve':
        this.manager.get(cmd.sessionId)?.approve(cmd.requestId);
        return;
      case 'deny':
        this.manager.get(cmd.sessionId)?.deny(cmd.requestId, cmd.message);
        return;
      case 'interrupt':
        void this.manager.get(cmd.sessionId)?.interrupt();
        return;
      case 'stop_session':
        this.manager.get(cmd.sessionId)?.stop();
        return;
      case 'remove_session':
        this.manager.remove(cmd.sessionId);
        return;
    }
  }
}
