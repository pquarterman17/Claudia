import type { ClientCommand, HostPlatform, ServerEvent } from '@claudia/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { runBulkOp } from './bulk-ops.js';
import { parseCommand } from './command-schema.js';
import { buildHello, ownedSessionIds } from './hello-event.js';
import { handleFleetCommand, isFleetCommand } from './fleet/commands.js';
import { handleWorktreeCommand, isWorktreeCommand } from './fleet/worktree-commands.js';
import { MirrorService } from './mirror.js';
import { handleSessionActionCommand } from './session-actions.js';
import { handleSessionQueryCommand } from './session-queries.js';
import type { FleetStore } from './store/index.js';
import type { Orchestrators } from './orchestrators.js';
import { setHookMonitor } from './hook-commands.js';
import { handleSavedSessionCommand } from './saved-session-commands.js';
import { handleSessionSettingCommand } from './session-setting-commands.js';
import { handleSettingsCommand } from './settings-commands.js';
import type { HookMonitor } from './hook-monitor.js';
import { isClientLive } from './client-liveness.js';
import { SessionReaper } from './session-reaper.js';
import { pickFolders } from './folder-picker.js';
import { launchSession } from './launch-session.js';
import { decideRewind, describeRewind } from './rewind-flow.js';
import type { SessionManager } from './session-manager.js';
import { buildSettingsEvent } from './settings-event.js';
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
  /** The hook monitor, and whether its global hook is currently installed. */
  private monitor!: HookMonitor;
  private monitoring = false;
  private orchestrators!: Orchestrators;
  private fleet: FleetStore | undefined;
  /** Last time each socket proved a live page was behind it. */
  private lastSeen = new WeakMap<WebSocket, number>();
  /** Built in `attach`, which is where its dependencies arrive. */
  private reaper!: SessionReaper;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    wss: WebSocketServer,
    private readonly platform: HostPlatform,
    /** The port actually bound, which is the URL the installed hook posts to. */
    private port = 4317,
  ) {
    this.wss = wss;
  }

  attach(
    manager: SessionManager,
    trigger: TriggerEngine,
    usage: UsageService,
    settings: SettingsStore,
    monitor: HookMonitor,
    orchestrators: Orchestrators,
  ): void {
    this.manager = manager;
    this.trigger = trigger;
    this.usage = usage;
    this.settings = settings;
    this.monitor = monitor;
    this.orchestrators = orchestrators;
    // Built here rather than in the constructor: every dependency it reads
    // arrives with `attach`, and the accessors keep them read fresh — the
    // grace is settable while the server runs, and `fleet` arrives later still.
    this.reaper = new SessionReaper({
      liveClients: () => this.liveClientCount(),
      graceSec: () => this.settings.get().stopSessionsWhenClosedSec,
      orchestrated: () => this.orchestrators.activeSessionIds(),
      fleet: () => this.fleet,
      summaries: () => this.manager.summaries(),
      remove: (id) => this.manager.remove(id),
    });
    // Re-evaluate periodically: a socket going stale produces no event of its own.
    this.sweepTimer = setInterval(() => this.reaper.check(), 5_000);
    this.sweepTimer.unref?.();
    this.wss.on('connection', (socket) => {
      // .catch is not optional here: an unhandled rejection ends the process
      // on modern Node, and this fires on every browser connect.
      void buildHello({
        manager,
        trigger,
        usage,
        settings,
        monitor: this.monitor,
        platform: this.platform,
        port: this.port,
      })
        .then((hello) => {
          this.sendTo(socket, hello);
          // After hello, never before: a run's status references sessions the
          // board has to already know about.
          this.orchestrators.replay((event) => this.sendTo(socket, event));
        })
        .catch(() => undefined);
      this.lastSeen.set(socket, Date.now());
      this.reaper.check();
      socket.on('close', () => this.reaper.check());

      socket.on('message', (raw) => {
        // Any message proves a page is running; ping just says so cheaply.
        this.lastSeen.set(socket, Date.now());
        let cmd: ClientCommand;
        try {
          // parseCommand is pure and never throws — this catch is solely for
          // JSON.parse's SyntaxError on genuinely malformed text.
          const parsed = parseCommand(JSON.parse(String(raw)));
          if (!parsed.ok) return this.sendTo(socket, { type: 'server_error', message: parsed.reason });
          cmd = parsed.cmd;
        } catch {
          this.sendTo(socket, { type: 'server_error', message: 'Malformed command JSON' });
          return;
        }
        if (cmd.type === 'ping') return;
        if (cmd.type === 'closing') return this.reaper.announceClosing();
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

  stop(): void {
    this.mirror.closeAll();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.reaper.stop();
  }

  private broadcastSettings(): void {
    this.broadcast(buildSettingsEvent(this.settings.get()));
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  /** The bound port, known only once the server is listening — with
   * CLAUDIA_PORT=0 the requested one is meaningless, and the hook URL written
   * into the owner's settings has to be the port that actually answers. */
  setPort(port: number): void {
    this.port = port;
  }

  /** Terminal sessions, minus the ones Claudia owns a tile for already. */
  broadcastObserved(monitoring = this.monitoring): void {
    this.monitoring = monitoring;
    this.broadcast({ type: 'observed_sessions', sessions: this.monitor.list(ownedSessionIds(this.manager)), monitoring });
  }

  /**
   * Installs or removes the global hook, then says exactly what happened.
   *
   * The account goes to the one socket that asked rather than to everyone:
   * this writes the owner's global settings, and the person who clicked is the
   * person who needs to read the backup path.
   */
  private async setHookMonitor(enabled: boolean, socket: WebSocket): Promise<void> {
    const outcome = await setHookMonitor(enabled, this.port);
    if (outcome.error) this.sendTo(socket, { type: 'server_error', message: outcome.error });
    if (outcome.notice) this.sendTo(socket, { type: 'notice', message: outcome.notice });
    this.broadcastObserved(outcome.monitoring);
  }

  private sendTo(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  /**
   * The mission store, when this run has one.
   *
   * Set separately from `attach` rather than added as a seventh positional
   * argument, because it is the one dependency that is legitimately absent:
   * the database may fail to open and the server carries on without it.
   */
  /**
   * Following a session Claudia does not own, for whoever asked.
   *
   * Keyed by session rather than by socket: two viewers of one terminal
   * session read the same transcript, and opening it twice would double every
   * step. The service is closed when the last watcher goes, which
   * `onClientCountChanged` already tracks for the board.
   */
  private readonly mirror = new MirrorService({
    opened: (sessionId, backlog) => this.broadcast({ type: 'mirror_opened', sessionId, ...backlog }),
    step: (sessionId, step) => this.broadcast({ type: 'mirror_step', sessionId, step }),
    item: (sessionId, item) => this.broadcast({ type: 'mirror_item', sessionId, item }),
    patch: (sessionId, stepId, patch) => this.broadcast({ type: 'mirror_patch', sessionId, stepId, patch }),
    unavailable: (sessionId, reason) => this.broadcast({ type: 'mirror_unavailable', sessionId, reason }),
  });

  /** Reads whatever the mirrored transcripts have gained. Driven by the server's timer. */
  pollMirrors(): Promise<void> {
    return this.mirror.poll();
  }

  attachFleet(store: FleetStore | undefined): void {
    this.fleet = store;
  }

  private dispatch(cmd: ClientCommand, socket: WebSocket): void {
    // Answered to the asking socket, not broadcast: these are replies to a
    // question one client asked. The live `fleet_event` stream is the part
    // everyone hears, and that is published from the store's commit hook.
    //
    // The worktree pair comes first and is handled separately because it is
    // the only asynchronous one: it reads git, so it answers later, and an
    // unhandled rejection here would end the process rather than the command.
    if (isWorktreeCommand(cmd)) {
      void handleWorktreeCommand(cmd, this.fleet)
        .then((events) => { for (const event of events) this.sendTo(socket, event); })
        .catch((err) => this.sendTo(socket, { type: 'server_error', message: `worktree cleanup failed: ${String(err)}` }));
      return;
    }
    if (isFleetCommand(cmd)) {
      for (const event of handleFleetCommand(cmd, this.fleet)) this.sendTo(socket, event);
      return;
    }
    // One-session setting changes and preference writes each share one shape,
    // and each lives in its own module.
    if (handleSessionSettingCommand(cmd, this.manager)) return;
    const reply = (event: ServerEvent): void => this.sendTo(socket, event);
    if (handleSessionQueryCommand(cmd, { manager: this.manager, reply })) return;
    if (handleSessionActionCommand(cmd, { manager: this.manager, reply })) return;
    if (cmd.type === 'mirror_session') {
      void this.mirror.open(cmd.sessionId);
      return;
    }
    if (cmd.type === 'close_mirror') {
      this.mirror.close(cmd.sessionId);
      return;
    }
    if (handleSavedSessionCommand(cmd, { manager: this.manager, settings: this.settings, reply: (e) => this.sendTo(socket, e) })) return;
    if (this.orchestrators.handle(cmd)) return;
    if (
      handleSettingsCommand(cmd, {
        settings: this.settings,
        trigger: this.trigger,
        usage: this.usage,
        broadcast: () => this.broadcastSettings(),
      })
    ) {
      return;
    }

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
      case 'set_hook_monitor':
        void this.setHookMonitor(cmd.enabled, socket);
        return;
      case 'bulk':
        runBulkOp(this.manager, cmd.op);
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
      case 'search_files':
        // searchFiles itself never rejects, but sendTo can: the socket may
        // have closed during the walk. An unhandled rejection ends the whole
        // process, and a completion nobody is waiting for is not worth that.
        void this.manager
          .searchFiles(cmd.sessionId, cmd.query)
          .then((matches) => this.sendTo(socket, { type: 'file_matches', sessionId: cmd.sessionId, query: cmd.query, matches }))
          .catch(() => undefined);
        return;
    }
  }
}
