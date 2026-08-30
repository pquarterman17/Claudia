import type { RepoWork } from './commit-action.js';
import { GitCache } from './git-info.js';
import type { FeedStep, FeedStepPatch, FileMatch, McpServerInfo, SessionSummary, SlashCommandInfo, TranscriptItem } from '@claudia/shared';
import { searchFiles as searchWorkingDir } from './file-search.js';
import { ClaudiaSession, type LaunchOptions } from './session.js';

const FEED_CAP = 500;
const MAX_SESSIONS = 12;

export interface ManagerEvents {
  onUpdate: (summary: SessionSummary) => void;
  onFeed: (sessionId: string, step: FeedStep) => void;
  onFeedPatch: (sessionId: string, stepId: string, patch: FeedStepPatch) => void;
  onDraft: (sessionId: string, text: string | null) => void;
  onCommands: (sessionId: string, commands: SlashCommandInfo[]) => void;
  onTranscript: (sessionId: string, item: TranscriptItem) => void;
  onRemoved: (sessionId: string) => void;
}

/** A session that has stopped moving on its own, whatever the reason. */
function isSettled(summary: SessionSummary): boolean {
  return summary.state === 'idle' || summary.state === 'error' || summary.state === 'stopped';
}

/** In-memory registry of live sessions and their feed history. */
export class SessionManager {
  private sessions = new Map<string, ClaudiaSession>();
  private feeds = new Map<string, FeedStep[]>();
  private readonly git = new GitCache();
  /** Who is waiting for a session to finish its turn. See awaitSettled. */
  private readonly settleWaiters = new Map<string, Array<(s: SessionSummary) => void>>();
  private events: ManagerEvents;

  constructor(events: ManagerEvents) {
    this.events = events;
  }

  launch(opts: LaunchOptions): ClaudiaSession {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Session limit reached (${MAX_SESSIONS}) — stop or remove one first`);
    }
    const session = new ClaudiaSession(opts, {
      onUpdate: (summary) => {
        this.releaseSettleWaiters(summary);
        this.events.onUpdate(summary);
      },
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

  /** Fuzzy file lookup for @-mention completion, scoped to one session's own directory. */
  searchFiles(id: string, query: string): Promise<FileMatch[]> {
    const session = this.get(id);
    return session ? searchWorkingDir(session.cwd, query) : Promise.resolve([]);
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.stop();
    this.sessions.delete(id);
    this.feeds.delete(id);
    this.events.onRemoved(id);
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => {
      const summary = s.summary();
      const git = this.git.get(summary.cwd);
      return git ? { ...summary, git } : summary;
    });
  }

  /**
   * Re-reads branch and dirty state for every live session's directory, and
   * pushes an update when anything changed. Driven on a timer rather than per
   * summary: the summary is rebuilt on every state change and must not wait on
   * a subprocess.
   */
  async refreshGit(): Promise<void> {
    const before = JSON.stringify([...this.sessions.values()].map((s) => this.git.get(s.summary().cwd)));
    await this.git.refresh([...this.sessions.values()].map((s) => s.summary().cwd));
    const after = JSON.stringify([...this.sessions.values()].map((s) => this.git.get(s.summary().cwd)));
    if (before === after) return;
    for (const summary of this.summaries()) this.events.onUpdate(summary);
  }

  /**
   * What each working directory has to offer a commit: the files its sessions
   * wrote, and what those sessions were called.
   *
   * Grouped by directory because that is the unit git works in — the owner
   * routinely runs several sessions in one repository, and they belong in one
   * commit rather than one each. Sessions that wrote nothing are left out
   * entirely, so a read-only session cannot put its title on someone else's
   * commit or drag a repository into the branch check for no reason.
   */
  touchedByDirectory(): RepoWork[] {
    const byDir = new Map<string, { files: Set<string>; titles: Set<string> }>();
    for (const session of this.sessions.values()) {
      const files = session.touchedFiles;
      if (files.length === 0) continue;
      const entry = byDir.get(session.cwd) ?? { files: new Set<string>(), titles: new Set<string>() };
      for (const file of files) entry.files.add(file);
      const { title } = session.summary();
      if (title) entry.titles.add(title);
      byDir.set(session.cwd, entry);
    }
    return [...byDir].map(([cwd, e]) => ({ cwd, files: [...e.files], titles: [...e.titles] }));
  }

  /**
   * Resolves when a session next finishes what it is doing.
   *
   * The orchestrator needs this because it drives sessions with no human
   * watching: it has to know a turn ENDED before it can read the reply and
   * hand it to the other agent. `idle` is the ordinary end of a turn; `error`
   * and `stopped` are ends too, and resolving on them rather than hanging is
   * what stops one dead session wedging a whole exchange.
   *
   * A session waiting on the human (`needsAction`) counts as settled as well —
   * it has stopped and will not move again on its own, and pretending
   * otherwise would wait forever.
   */
  awaitSettled(id: string, timeoutMs = 10 * 60_000): Promise<SessionSummary> {
    const current = this.get(id)?.summary();
    if (!current) return Promise.reject(new Error('That session is no longer on the board'));
    if (isSettled(current)) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
      const waiters = this.settleWaiters.get(id) ?? [];
      // Bounded: an agent that never answers must not hold the exchange open
      // for the rest of the process's life.
      const timer = setTimeout(() => {
        this.settleWaiters.set(id, (this.settleWaiters.get(id) ?? []).filter((w) => w !== waiter));
        reject(new Error(`That session did not finish within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      const waiter = (summary: SessionSummary): void => {
        clearTimeout(timer);
        resolve(summary);
      };
      waiters.push(waiter);
      this.settleWaiters.set(id, waiters);
    });
  }

  private releaseSettleWaiters(summary: SessionSummary): void {
    if (!isSettled(summary)) return;
    const waiters = this.settleWaiters.get(summary.id);
    if (!waiters?.length) return;
    this.settleWaiters.delete(summary.id);
    for (const waiter of waiters) waiter(summary);
  }

  feedSnapshot(): Record<string, FeedStep[]> {
    return Object.fromEntries(this.feeds);
  }

  async mcpSnapshot(): Promise<Record<string, McpServerInfo[]>> {
    return Object.fromEntries(await Promise.all([...this.sessions].map(async ([id, session]) => [id, await session.mcpStatus()])));
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.stop();
  }
}
