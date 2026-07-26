import type { ClientCommand, HostPlatform, ServerEvent } from '@claudia/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { isClientLive } from './client-liveness.js';
import { assertUsableDirectory, normalizePath, pickFolder } from './folder-picker.js';
import type { SessionManager } from './session-manager.js';
import type { SettingsStore } from './settings-store.js';
import type { TriggerEngine } from './trigger-engine.js';
import type { UsageService } from './usage-service.js';

/** WS fan-out plus command dispatch. One gateway serves every connected browser. */
export class Gateway {
  private wss: WebSocketServer;
  private manager!: SessionManager;
  private trigger!: TriggerEngine;
  private usage!: UsageService;
  private settings!: SettingsStore;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last time each socket proved a live page was behind it. */
  private lastSeen = new WeakMap<WebSocket, number>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    wss: WebSocketServer,
    private readonly platform: HostPlatform,
  ) {
    this.wss = wss;
  }

  attach(
    manager: SessionManager,
    trigger: TriggerEngine,
    usage: UsageService,
    settings: SettingsStore,
  ): void {
    this.manager = manager;
    this.trigger = trigger;
    this.usage = usage;
    this.settings = settings;
    // Re-evaluate periodically: a socket going stale produces no event of its own.
    this.sweepTimer = setInterval(() => this.onClientCountChanged(), 5_000);
    this.sweepTimer.unref?.();
    this.wss.on('connection', (socket) => {
      this.sendTo(socket, {
        type: 'hello',
        sessions: manager.summaries(),
        feeds: manager.feedSnapshot(),
        trigger: trigger.status(),
        platform: this.platform,
        usage: usage.snapshot(),
        recentDirectories: settings.get().recentDirectories,
        countdownSec: settings.get().countdownSec,
        stopSessionsWhenClosedSec: settings.get().stopSessionsWhenClosedSec,
        defaultPermissionMode: settings.get().defaultPermissionMode,
      });
      this.lastSeen.set(socket, Date.now());
      this.onClientCountChanged();
      socket.on('close', () => this.onClientCountChanged());

      socket.on('message', (raw) => {
        // Any message proves a page is running; ping just says so cheaply.
        this.lastSeen.set(socket, Date.now());
        let cmd: ClientCommand;
        try {
          cmd = JSON.parse(String(raw)) as ClientCommand;
        } catch {
          this.sendTo(socket, { type: 'server_error', message: 'Malformed command JSON' });
          return;
        }
        if (cmd.type === 'ping') return;
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

  private liveClientCount(now = Date.now()): number {
    let live = 0;
    for (const client of this.wss.clients) {
      if (isClientLive(client.readyState, this.lastSeen.get(client), now)) live++;
    }
    return live;
  }

  /**
   * Stops sessions once the last live browser goes away.
   *
   * A session with no window on it is invisible work that still spends tokens,
   * which is precisely what this app exists to prevent. The grace period keeps
   * it safe: a page reload drops the socket for about a second, so reacting
   * instantly would kill sessions on every refresh.
   */
  private onClientCountChanged(): void {
    const connected = this.liveClientCount();

    if (connected > 0) {
      if (this.idleTimer !== undefined) {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        console.log('[claudia] browser reconnected — sessions kept');
      }
      return;
    }

    const graceSec = this.settings.get().stopSessionsWhenClosedSec;
    if (graceSec <= 0) return; // disabled: leave sessions running
    if (this.idleTimer !== undefined) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      const live = this.manager.summaries().filter((s) => s.state !== 'stopped');
      if (live.length === 0) return;
      console.log(`[claudia] no browser for ${graceSec}s — stopping ${live.length} session(s)`);
      for (const summary of live) this.manager.get(summary.id)?.stop();
    }, graceSec * 1000);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private broadcastSettings(): void {
    const s = this.settings.get();
    this.broadcast({
      type: 'settings',
      recentDirectories: s.recentDirectories,
      countdownSec: s.countdownSec,
      stopSessionsWhenClosedSec: s.stopSessionsWhenClosedSec,
      defaultPermissionMode: s.defaultPermissionMode,
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
        this.settings.rememberDirectory(cwd);
        // The launch mode is sticky: most people keep one posture.
        this.settings.update({ defaultPermissionMode: cmd.permissionMode ?? 'default' });
        this.broadcastSettings();
        return;
      }
      case 'browse_folder':
        // Open where they last worked rather than at the drive root.
        pickFolder(this.platform, this.settings.get().recentDirectories[0])
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
      case 'toggle_finish_action':
        this.trigger.toggleAction(cmd.action);
        this.settings.update({ finishChain: this.trigger.actions });
        return;
      case 'clear_finish_chain':
        this.trigger.clearChain();
        this.settings.update({ finishChain: [] });
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
        this.settings.update({ planTier: cmd.tier });
        return;
      case 'set_stop_on_close': {
        // Clamped: a few seconds is not enough to survive a page reload.
        const seconds = cmd.seconds <= 0 ? 0 : Math.max(10, Math.min(3600, Math.round(cmd.seconds)));
        this.settings.update({ stopSessionsWhenClosedSec: seconds });
        this.broadcastSettings();
        return;
      }
      case 'set_countdown':
        this.trigger.setCountdown(cmd.seconds);
        this.settings.update({ countdownSec: this.trigger.countdownLength });
        this.broadcastSettings();
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
