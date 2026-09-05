import {
  CLAUDIA_PORT,
  CLIENT_PING_MS,
  type ClientCommand,
  type FeedStep,
  type FileMatch,
  type HostPlatform,
  type EffectiveSettings,
  type McpServerInfo,
  type ModelChoice,
  type CrewStatus,
  type DebateStatus,
  type ObservedSession,
  type PermissionLaunchMode,
  type ServerEvent,
  type SessionSummary,
  type SavedSession,
  type FileCheckpoint,
  type SessionTemplate,
  type SlashCommandInfo,
  type TranscriptItem,
  type TriggerStatus,
  type UsageSnapshot,
  type ToolkitAction,
} from '@claudia/shared';
import { foldMirror, type Mirrors } from './mirror-state';
import { isSafeKey } from './safe-key';
import { useSyncExternalStore } from 'react';

/**
 * Talk to the server directly on its own port rather than through Vite's dev
 * proxy. The proxy silently stops forwarding the WS upgrade once the upstream
 * has restarted a few times, which looks exactly like a dead server; going
 * direct removes that failure mode and behaves identically in a built app.
 */
function serverUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // In production the server serves the UI too, so it is simply this origin.
  // In dev the UI comes from Vite on another port, so aim at the server's.
  const host = import.meta.env.DEV ? `${location.hostname}:${CLAUDIA_PORT}` : location.host;
  return `${scheme}://${host}/ws`;
}

export interface ClaudiaState {
  connected: boolean;
  sessions: SessionSummary[];
  feeds: Record<string, FeedStep[]>;
  /** In-progress streamed replies, keyed by session. */
  drafts: Record<string, string>;
  /** Models the CLI offers, fetched per session on demand via get_models. */
  models: Record<string, ModelChoice[]>;
  /** Slash commands each session's CLI knows — richer once get_commands resolves. */
  commands: Record<string, SlashCommandInfo[]>;
  /** Latest @-mention file search results, keyed by session. Paired with the
   * query they answer so a slow reply for an old keystroke can never render
   * over a newer one. */
  fileMatches: Record<string, { query: string; matches: FileMatch[] }>;
  /** Full conversation transcript per session — the terminal-parity view. */
  transcripts: Record<string, TranscriptItem[]>;
  savedSessions: SavedSession[];
  checkpoints: Record<string, FileCheckpoint[]>;
  mcp: Record<string, McpServerInfo[]>;
  effectiveSettings: Record<string, EffectiveSettings>;
  trigger?: TriggerStatus;
  platform?: HostPlatform;
  usage?: UsageSnapshot;
  recentDirectories: string[];
  countdownSec: number;
  stopSessionsWhenClosedSec: number;
  defaultPermissionMode: PermissionLaunchMode;
  templates: SessionTemplate[];
  toolkit: ToolkitAction[];
  customCeilings?: { sessionTokens: number; weeklyTokens: number };
  lastError?: string;
  /** Something that happened and worked, as distinct from lastError. */
  lastNotice?: string;
  /** Cross-agent exchanges, newest first. */
  debates: DebateStatus[];
  crews: CrewStatus[];
  /** Terminal sessions Claudia did not launch, seen through the global hook. */
  observed: ObservedSession[];
  /** Sessions Claudia is only watching. See `mirror-state.ts`. */
  mirrors: Mirrors;
  /** Whether that hook is installed in the owner's global settings. */
  monitoring: boolean;
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
    drafts: {},
    models: {},
    commands: {},
    fileMatches: {},
    transcripts: {},
    savedSessions: [],
    checkpoints: {},
    mcp: {},
    effectiveSettings: {},
    recentDirectories: [],
    countdownSec: 30,
    stopSessionsWhenClosedSec: 30,
    defaultPermissionMode: 'auto',
    templates: [],
    toolkit: [],
    observed: [],
    mirrors: {},
    monitoring: false,
    debates: [],
    crews: [],
  };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retryMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** One-off replies (folder picker) that aren't part of the rendered snapshot. */
  private folderListeners = new Set<(paths: string[]) => void>();

  onFoldersPicked = (fn: (paths: string[]) => void): (() => void) => {
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
    if (this.state.lastNotice !== undefined) this.set({ lastNotice: undefined });
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
    // Session ids arrive over the wire and are used as object keys throughout
    // this file. They are server-generated UUIDs in practice, but "in practice"
    // is not a guarantee worth resting prototype safety on: a key of
    // `__proto__` or `constructor` would poison every object it touched.
    // Rejecting once here covers every use below.
    if ('sessionId' in event && !isSafeKey((event as { sessionId?: unknown }).sessionId)) return;

    // Mirror events first, and as a group: they all revise one map and none of
    // them touch anything else, so folding them here keeps the switch below
    // about sessions Claudia owns.
    const mirrors = foldMirror(this.state.mirrors, event);
    if (mirrors !== undefined) {
      this.set({ mirrors });
      return;
    }

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
          defaultPermissionMode: event.defaultPermissionMode,
          templates: event.templates,
          toolkit: event.toolkit,
          customCeilings: event.customCeilings,
          mcp: event.mcp,
          observed: event.observed,
          monitoring: event.monitoring,
          lastError: undefined,
        });
        return;
      case 'debate': {
        // Replace in place so a running exchange updates rather than stacking.
        const rest = this.state.debates.filter((d) => d.id !== event.debate.id);
        this.set({ debates: [event.debate, ...rest].sort((a, b) => b.startedAt - a.startedAt) });
        return;
      }
      case 'crew': {
        const rest = this.state.crews.filter((c) => c.id !== event.crew.id);
        this.set({ crews: [event.crew, ...rest].sort((a, b) => b.startedAt - a.startedAt) });
        return;
      }
      case 'observed_sessions':
        this.set({ observed: event.sessions, monitoring: event.monitoring });
        return;
      case 'transcript':
        this.set({ transcripts: { ...this.state.transcripts, [event.sessionId]: event.items } });
        return;
      case 'transcript_append': {
        const items = [...(this.state.transcripts[event.sessionId] ?? []), event.item].slice(-500);
        this.set({ transcripts: { ...this.state.transcripts, [event.sessionId]: items } });
        return;
      }
      case 'saved_sessions':
        this.set({ savedSessions: event.sessions });
        return;
      case 'saved_session_detail':
        this.set({ checkpoints: { ...this.state.checkpoints, [event.sessionId]: event.checkpoints } });
        return;
      case 'feed_append': {
        const feed = [...(this.state.feeds[event.sessionId] ?? []), event.step].slice(-500);
        this.set({ feeds: { ...this.state.feeds, [event.sessionId]: feed } });
        return;
      }
      case 'draft': {
        const drafts = { ...this.state.drafts };
        if (event.text === null) delete drafts[event.sessionId];
        else drafts[event.sessionId] = event.text;
        this.set({ drafts });
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
      case 'models':
        this.set({ models: { ...this.state.models, [event.sessionId]: event.models } });
        return;
      case 'mcp_status':
        this.set({ mcp: { ...this.state.mcp, [event.sessionId]: event.servers } });
        return;
      case 'effective_settings':
        this.set({ effectiveSettings: { ...this.state.effectiveSettings, [event.sessionId]: event.settings } });
        return;
      case 'file_matches':
        this.set({
          fileMatches: { ...this.state.fileMatches, [event.sessionId]: { query: event.query, matches: event.matches } },
        });
        return;
      case 'session_commands': {
        // An empty reply means the live supportedCommands() fetch failed or
        // isn't ready yet — keep whatever the init-message fallback already
        // gave the composer rather than blanking its autocomplete.
        const known = this.state.commands[event.sessionId];
        if (event.commands.length === 0 && known && known.length > 0) return;
        this.set({ commands: { ...this.state.commands, [event.sessionId]: event.commands } });
        return;
      }
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
export const onFoldersPicked = store.onFoldersPicked;
