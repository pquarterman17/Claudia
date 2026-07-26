import type { FeedStep, FeedStepPatch, SessionSummary, TranscriptItem } from '@claudia/shared';
import { ClaudiaSession, type LaunchOptions } from './session.js';

const FEED_CAP = 500;
const MAX_SESSIONS = 12;

export interface ManagerEvents {
  onUpdate: (summary: SessionSummary) => void;
  onFeed: (sessionId: string, step: FeedStep) => void;
  onFeedPatch: (sessionId: string, stepId: string, patch: FeedStepPatch) => void;
  onDraft: (sessionId: string, text: string | null) => void;
  onCommands: (sessionId: string, commands: string[]) => void;
  onTranscript: (sessionId: string, item: TranscriptItem) => void;
  onRemoved: (sessionId: string) => void;
}

/** In-memory registry of live sessions and their feed history. */
export class SessionManager {
  private sessions = new Map<string, ClaudiaSession>();
  private feeds = new Map<string, FeedStep[]>();
  private events: ManagerEvents;

  constructor(events: ManagerEvents) {
    this.events = events;
  }

  launch(opts: LaunchOptions): ClaudiaSession {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Session limit reached (${MAX_SESSIONS}) — stop or remove one first`);
    }
    const session = new ClaudiaSession(opts, {
      onUpdate: (summary) => this.events.onUpdate(summary),
      onFeed: (sessionId, step) => {
        const feed = this.feeds.get(sessionId) ?? [];
        feed.push(step);
        if (feed.length > FEED_CAP) feed.splice(0, feed.length - FEED_CAP);
        this.feeds.set(sessionId, feed);
        this.events.onFeed(sessionId, step);
      },
      onFeedPatch: (sessionId, stepId, patch) => {
        // Patch the stored history too, so a browser connecting later sees
        // finished steps rather than ones stuck at 'running'.
        const feed = this.feeds.get(sessionId);
        const step = feed?.find((s) => s.id === stepId);
        if (step) Object.assign(step, patch);
        this.events.onFeedPatch(sessionId, stepId, patch);
      },
      onDraft: (sessionId, text) => this.events.onDraft(sessionId, text),
      onCommands: (sessionId, commands) => this.events.onCommands(sessionId, commands),
      onTranscript: (sessionId, item) => this.events.onTranscript(sessionId, item),
    });
    this.sessions.set(session.id, session);
    this.feeds.set(session.id, []);
    session.start();
    return session;
  }

  get(id: string): ClaudiaSession | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.stop();
    this.sessions.delete(id);
    this.feeds.delete(id);
    this.events.onRemoved(id);
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  feedSnapshot(): Record<string, FeedStep[]> {
    return Object.fromEntries(this.feeds);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.stop();
  }
}
