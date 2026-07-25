import {
  CLAUDIA_PORT,
  type ClientCommand,
  type FeedStep,
  type HostPlatform,
  type ServerEvent,
  type SessionSummary,
  type TriggerStatus,
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
  lastError?: string;
}

type Listener = () => void;

/**
 * Minimal external store: one WS connection, immutable snapshots, no deps.
 * Snapshots are replaced (never mutated) so useSyncExternalStore stays stable.
 */
class Store {
  private state: ClaudiaState = { connected: false, sessions: [], feeds: {} };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retryMs = 500;

  getSnapshot = (): ClaudiaState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): void {
    if (this.ws) return;
    const ws = new WebSocket(serverUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.set({ connected: true });
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data as string) as ServerEvent);
    ws.onclose = () => {
      this.ws = null;
      this.set({ connected: false });
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 8000);
    };
  }

  send(cmd: ClientCommand): void {
    this.ws?.send(JSON.stringify(cmd));
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'hello':
        this.set({
          sessions: event.sessions,
          feeds: event.feeds,
          trigger: event.trigger,
          platform: event.platform,
          lastError: undefined,
        });
        return;
      case 'trigger_status':
        this.set({ trigger: event.trigger });
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
