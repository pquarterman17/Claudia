import type { ClientCommand, HostPlatform, ServerEvent } from '@claudia/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { assertUsableDirectory, normalizePath, pickFolder } from './folder-picker.js';
import type { SessionManager } from './session-manager.js';
import type { TriggerEngine } from './trigger-engine.js';
import type { UsageService } from './usage-service.js';

/** WS fan-out plus command dispatch. One gateway serves every connected browser. */
export class Gateway {
  private wss: WebSocketServer;
  private manager!: SessionManager;
  private trigger!: TriggerEngine;
  private usage!: UsageService;

  constructor(
    wss: WebSocketServer,
    private readonly platform: HostPlatform,
  ) {
    this.wss = wss;
  }

  attach(manager: SessionManager, trigger: TriggerEngine, usage: UsageService): void {
    this.manager = manager;
    this.trigger = trigger;
    this.usage = usage;
    this.wss.on('connection', (socket) => {
      this.sendTo(socket, {
        type: 'hello',
        sessions: manager.summaries(),
        feeds: manager.feedSnapshot(),
        trigger: trigger.status(),
        platform: this.platform,
        usage: usage.snapshot(),
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
          this.dispatch(cmd, socket);
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

  private dispatch(cmd: ClientCommand, socket: WebSocket): void {
    switch (cmd.type) {
      case 'launch_session': {
        const cwd = normalizePath(cmd.cwd);
        assertUsableDirectory(cwd);
        this.manager.launch({
          cwd,
          prompt: cmd.prompt,
          model: cmd.model,
          permissionMode: cmd.permissionMode ?? 'default',
        });
        return;
      }
      case 'browse_folder':
        pickFolder(this.platform)
          .then((path) => this.sendTo(socket, { type: 'folder_picked', path }))
          .catch((err: unknown) =>
            this.sendTo(socket, {
              type: 'server_error',
              message: `Folder picker failed: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
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
      case 'set_permission_mode':
        void this.manager.get(cmd.sessionId)?.setPermissionMode(cmd.mode);
        return;
      case 'require_approvals_everywhere':
        for (const s of this.manager.summaries()) {
          if (s.permissionMode !== 'default') void this.manager.get(s.id)?.setPermissionMode('default');
        }
        return;
      case 'select_finish_action':
        this.trigger.selectAction(cmd.action);
        return;
      case 'arm_trigger':
        this.trigger.arm(cmd.confirmDestructive);
        return;
      case 'disarm_trigger':
        this.trigger.disarm();
        return;
      case 'bulk':
        this.runBulk(cmd.op);
        return;
      case 'set_plan_tier':
        this.usage.setTier(cmd.tier);
        return;
    }
  }

  private runBulk(op: 'approve_all' | 'interrupt_all'): void {
    for (const summary of this.manager.summaries()) {
      const session = this.manager.get(summary.id);
      if (!session) continue;
      if (op === 'approve_all') {
        if (summary.pendingApproval) session.approve(summary.pendingApproval.requestId);
      } else if (summary.state === 'working' || summary.state === 'starting') {
        void session.interrupt();
      }
    }
  }
}
