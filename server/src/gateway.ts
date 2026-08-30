import type { ClientCommand, HostPlatform, ServerEvent } from '@claudia/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { runBulk } from './bulk-actions.js';
import { isClientLive } from './client-liveness.js';
import { pickFolders } from './folder-picker.js';
import { launchSession, resumeSavedSession } from './launch-session.js';
import { decideRewind, describeRewind } from './rewind-flow.js';
import { allSavedSessions, retagSavedSession, retitleSavedSession, savedSessionDetail } from './saved-sessions.js';
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
      // .catch is not optional here: an unhandled rejection ends the process
      // on modern Node, and this fires on every browser connect.
      void manager.mcpSnapshot().catch(() => ({})).then((mcp) => this.sendTo(socket, {
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
        templates: settings.get().templates,
        toolkit: settings.get().toolkit,
        customCeilings: settings.get().customCeilings,
        mcp,
      }));
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
      toolkit: s.toolkit,
      countdownSec: s.countdownSec,
      stopSessionsWhenClosedSec: s.stopSessionsWhenClosedSec,
      defaultPermissionMode: s.defaultPermissionMode,
      templates: s.templates,
      customCeilings: s.customCeilings,
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
      case 'launch_session':
        // Creating a worktree is the only async part; a failure there must
        // reach the user rather than vanish, and must never reject unhandled.
        void launchSession(cmd, this.manager, this.settings)
          .then((result) => {
            if (!result.ok) this.sendTo(socket, { type: 'server_error', message: result.message });
            this.broadcastSettings();
          })
          .catch((err: unknown) => {
            this.sendTo(socket, {
              type: 'server_error',
              message: err instanceof Error ? err.message : 'The session could not be launched.',
            });
          });
        return;
      case 'list_saved_sessions':
        void allSavedSessions(cmd.cwd).then((sessions) => this.sendTo(socket, { type: 'saved_sessions', sessions }));
        return;
      case 'get_saved_session_detail':
        void savedSessionDetail(cmd.sessionId, cmd.cwd).then((checkpoints) =>
          this.sendTo(socket, { type: 'saved_session_detail', sessionId: cmd.sessionId, checkpoints }),
        );
        return;
      case 'resume_saved_session':
      case 'fork_saved_session':
        resumeSavedSession(cmd, this.manager, this.settings);
        return;
      case 'rename_saved_session':
        void retitleSavedSession(cmd.sessionId, cmd.title, cmd.cwd).then(() => this.dispatch({ type: 'list_saved_sessions', cwd: cmd.cwd }, socket));
        return;
      case 'tag_saved_session':
        void retagSavedSession(cmd.sessionId, cmd.tag, cmd.cwd).then(() => this.dispatch({ type: 'list_saved_sessions', cwd: cmd.cwd }, socket));
        return;
      case 'rewind_files': {
        const session = this.manager.get(cmd.sessionId);
        if (!session) throw new Error('Live session not found. File rewind requires the original live session.');
        const decision = decideRewind(session.isBusy());
        if (!decision.ok) {
          this.sendTo(socket, { type: 'server_error', message: decision.message });
          return;
        }
        void session.rewindFiles(cmd.checkpointId).then((result) => {
          const outcome = describeRewind(result);
          if (outcome.failed) this.sendTo(socket, { type: 'server_error', message: outcome.message });
          else session.noteRewind(outcome.message);
        });
        return;
      }
      case 'browse_folder':
        // Open where they last worked rather than at the drive root.
        pickFolders(this.platform, this.settings.get().recentDirectories[0])
          .then((paths) => this.sendTo(socket, { type: 'folders_picked', paths }))
          .catch((err: unknown) =>
            this.sendTo(socket, {
              type: 'server_error',
              message: `Folder picker failed: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        return;
      case 'send_prompt':
        this.manager.get(cmd.sessionId)?.sendPrompt(cmd.text, cmd.images);
        return;
      case 'approve':
        this.manager.get(cmd.sessionId)?.approve(cmd.requestId);
        return;
      case 'deny':
        this.manager.get(cmd.sessionId)?.deny(cmd.requestId, cmd.message);
        return;
      case 'answer_question':
        this.manager.get(cmd.sessionId)?.answerQuestion(cmd.requestId, cmd.answers);
        return;
      case 'interrupt':
        void this.manager.get(cmd.sessionId)?.interrupt();
        return;
      case 'get_transcript':
        this.sendTo(socket, {
          type: 'transcript',
          sessionId: cmd.sessionId,
          items: this.manager.get(cmd.sessionId)?.transcript.list() ?? [],
        });
        return;
      case 'stop_session':
        this.manager.get(cmd.sessionId)?.stop();
        return;
      case 'remove_session':
        this.manager.remove(cmd.sessionId);
        return;
      case 'rename_session':
        this.manager.get(cmd.sessionId)?.rename(cmd.title);
        return;
      case 'set_permission_mode':
        void this.manager.get(cmd.sessionId)?.setPermissionMode(cmd.mode);
        return;
      case 'set_model':
        void this.manager.get(cmd.sessionId)?.switchModel(cmd.model);
        return;
      case 'set_effort':
        void this.manager.get(cmd.sessionId)?.setEffort(cmd.effortLevel);
        return;
      case 'set_thinking':
        void this.manager.get(cmd.sessionId)?.setThinking(cmd.thinkingMode);
        return;
      case 'set_output_style':
        void this.manager.get(cmd.sessionId)?.setOutputStyle(cmd.style);
        return;
      case 'refresh_context':
        this.manager.get(cmd.sessionId)?.refreshContext();
        return;
      case 'get_models':
        this.manager
          .get(cmd.sessionId)
          ?.models()
          .then((models) => this.sendTo(socket, { type: 'models', sessionId: cmd.sessionId, models }));
        return;
      case 'get_commands':
        this.manager
          .get(cmd.sessionId)
          ?.commands()
          .then((commands) => this.sendTo(socket, { type: 'session_commands', sessionId: cmd.sessionId, commands }));
        return;
      case 'get_mcp_status':
        this.manager.get(cmd.sessionId)?.mcpStatus().then((servers) => this.sendTo(socket, { type: 'mcp_status', sessionId: cmd.sessionId, servers }));
        return;
      case 'reconnect_mcp':
        this.manager.get(cmd.sessionId)?.reconnectMcp(cmd.serverName)?.catch(() => undefined).then(() => this.dispatch({ type: 'get_mcp_status', sessionId: cmd.sessionId }, socket));
        return;
      case 'toggle_mcp':
        this.manager.get(cmd.sessionId)?.toggleMcp(cmd.serverName, cmd.enabled)?.catch(() => undefined).then(() => this.dispatch({ type: 'get_mcp_status', sessionId: cmd.sessionId }, socket));
        return;
      case 'get_effective_settings':
        void this.manager
          .get(cmd.sessionId)
          ?.effectiveSettings()
          .then((settings) => {
            if (settings) this.sendTo(socket, { type: 'effective_settings', sessionId: cmd.sessionId, settings });
          });
        return;
      case 'stop_task':
        void this.manager.get(cmd.sessionId)?.stopTask(cmd.taskId)?.catch(() => undefined);
        return;
      case 'require_approvals_everywhere':
        for (const s of this.manager.summaries()) {
          if (s.permissionMode === 'bypassPermissions') {
            void this.manager.get(s.id)?.setPermissionMode('default');
          }
        }
        return;
      case 'toggle_finish_action':
        this.trigger.toggleAction(cmd.action);
        this.settings.update({ finishChain: this.trigger.actions });
        return;
      case 'move_finish_action':
        this.trigger.moveAction(cmd.action, cmd.direction);
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
        runBulk(cmd.op, this.manager);
        return;
      case 'set_plan_tier':
        this.usage.setTier(cmd.tier);
        this.settings.update({ planTier: cmd.tier });
        return;
      case 'fetch_real_usage': {
        const session = this.manager.get(cmd.sessionId);
        if (!session) return;
        // requestReal arms capture first so the reply cannot race ahead of it.
        // An unstarted session has no query: asking it for /cost would spawn
        // one and spend a turn, which a usage refresh must never do.
        if (!session.canSendControlPrompt()) return;
        this.usage.requestReal(cmd.sessionId, () => session.sendControlPrompt('/cost'));
        return;
      }
      case 'set_custom_ceilings': {
        // A zero or negative ceiling is meaningless, so floor it above zero.
        const customCeilings = {
          sessionTokens: Math.max(1000, Math.round(cmd.sessionTokens)),
          weeklyTokens: Math.max(1000, Math.round(cmd.weeklyTokens)),
        };
        this.settings.update({ customCeilings });
        this.usage.setCustomCeilings(customCeilings);
        this.broadcastSettings();
        return;
      }
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
      case 'save_toolkit_action':
        this.settings.saveToolkitAction(cmd.action);
        this.broadcastSettings();
        return;
      case 'delete_toolkit_action':
        this.settings.deleteToolkitAction(cmd.id);
        this.broadcastSettings();
        return;
      case 'save_template':
        this.settings.saveTemplate(cmd.template);
        this.broadcastSettings();
        return;
      case 'delete_template':
        this.settings.deleteTemplate(cmd.name);
        this.broadcastSettings();
        return;
    }
  }
}
