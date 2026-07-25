import {
  CLAUDIA_PORT,
  CLIENT_PING_MS,
  type ClientCommand,
  type FeedStep,
  type HostPlatform,
  type ServerEvent,
  type SessionSummary,
  type TriggerStatus,
  type UsageSnapshot,
} from '@claudia/shared';
import { useSyncExternalStore } from 'react';

/**
 * Talk to the server directly on its own port rather than through Vite's dev
 * proxy. The proxy silently stops forwarding the WS upgrade once the upstream
 * has restarted a few times, which looks exactly like a dead server; going
 * direct removes that failure mode and behaves identically in a built app.
 */
function serverUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname}:${CLAUDIA_PORT}/ws`;
}

export interface ClaudiaState {
  connected: boolean;
  sessions: SessionSummary[];
  feeds: Record<string, FeedStep[]>;
  trigger?: TriggerStatus;
  platform?: HostPlatform;
  usage?: UsageSnapshot;
  recentDirectories: string[];
  countdownSec: number;
  stopSessionsWhenClosedSec: number;
  lastError?: string;
}

type Listener = () => void;

/**
 * Minimal external store: one WS connection, immutable snapshots, no deps.
 * Snapshots are replaced (never mutated) so useSyncExternalStore stays stable.
 */
class Store {
  private state: ClaudiaState = {
    connected: false,
    sessions: [],
    feeds: {},
    recentDirectories: [],
    countdownSec: 30,
    stopSessionsWhenClosedSec: 30,
  };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retryMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** One-off replies (folder picker) that aren't part of the rendered snapshot. */
  private folderListeners = new Set<(path: string | null) => void>();

  onFolderPicked = (fn: (path: string | null) => void): (() => void) => {
    this.folderListeners.add(fn);
    return () => this.folderListeners.delete(fn);
  };

  getSnapshot = (): ClaudiaState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Opens the socket, replacing any previous one.
   *
   * Every handler checks it is still the live socket first. Without that, a
   * server restart can leave an orphaned socket whose handlers keep firing
   * while sends go to a different one — the UI reads "connected" but silently
   * stops reflecting reality until a reload. Observed after a dev-server
   * restart, and worth guarding for real restarts too.
   */
  connect(): void {
    const live = this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING;
    if (live) return;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
    }

    const ws = new WebSocket(serverUrl());
    this.ws = ws;
    const isCurrent = (): boolean => this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      this.retryMs = 500;
      this.set({ connected: true });
      // Beat while this page is genuinely running. A frozen or bfcached page
      // stops its timers, which is precisely how the server tells it has gone
      // even though the socket still looks open.
      if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
      }, CLIENT_PING_MS);
    };
    ws.onmessage = (ev) => {
      if (!isCurrent()) return;
      this.handle(JSON.parse(ev.data as string) as ServerEvent);
    };
    ws.onclose = () => {
      if (!isCurrent()) return;
      if (this.pingTimer !== undefined) {
        clearInterval(this.pingTimer);
        this.pingTimer = undefined;
      }
      this.ws = null;
      this.set({ connected: false });
      this.reconnectTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 8000);
    };
  }

  clearError = (): void => {
    if (this.state.lastError !== undefined) this.set({ lastError: undefined });
  };

  /** Reports rather than silently swallowing a command sent while offline. */
  send(cmd: ClientCommand): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.set({ lastError: 'Not connected to the server — that action was not sent.' });
      this.connect();
      return;
    }
    this.clearError();
    this.ws.send(JSON.stringify(cmd));
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'hello':
        this.set({
          sessions: event.sessions,
          feeds: event.feeds,
          trigger: event.trigger,
          platform: event.platform,
          usage: event.usage,
          recentDirectories: event.recentDirectories,
          countdownSec: event.countdownSec,
          stopSessionsWhenClosedSec: event.stopSessionsWhenClosedSec,
          lastError: undefined,
        });
        return;
      case 'settings':
        this.set({
          recentDirectories: event.recentDirectories,
          countdownSec: event.countdownSec,
          stopSessionsWhenClosedSec: event.stopSessionsWhenClosedSec,
        });
        return;
      case 'trigger_status':
        this.set({ trigger: event.trigger });
        return;
      case 'usage':
        this.set({ usage: event.usage });
        return;
      case 'folder_picked':
        for (const listener of this.folderListeners) listener(event.path);
        return;
      case 'session_upsert': {
        const rest = this.state.sessions.filter((s) => s.id !== event.session.id);
        const existing = this.state.sessions.find((s) => s.id === event.session.id);
        const sessions = existing
          ? this.state.sessions.map((s) => (s.id === event.session.id ? event.session : s))
          : [...rest, event.session];
        this.set({ sessions });
        return;
      }
      case 'session_removed':
        this.set({
          sessions: this.state.sessions.filter((s) => s.id !== event.sessionId),
          feeds: Object.fromEntries(Object.entries(this.state.feeds).filter(([k]) => k !== event.sessionId)),
        });
        return;
      case 'feed_append': {
        const feed = [...(this.state.feeds[event.sessionId] ?? []), event.step].slice(-500);
        this.set({ feeds: { ...this.state.feeds, [event.sessionId]: feed } });
        return;
      }
      case 'feed_update': {
        const existing = this.state.feeds[event.sessionId];
        if (!existing) return;
        const feed = existing.map((s) => (s.id === event.stepId ? { ...s, ...event.patch } : s));
        this.set({ feeds: { ...this.state.feeds, [event.sessionId]: feed } });
        return;
      }
      case 'server_error':
        this.set({ lastError: event.message });
        return;
    }
  }

  private set(partial: Partial<ClaudiaState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export const store = new Store();

export function useClaudia(): ClaudiaState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export const send = (cmd: ClientCommand): void => store.send(cmd);
export const onFolderPicked = store.onFolderPicked;
