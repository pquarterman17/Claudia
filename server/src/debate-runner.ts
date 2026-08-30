import type { ClientCommand, DebateStatus, SessionSummary } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import { escalationReason, isRoutineUnattended } from './unattended-approvals.js';
import { runDebate, DEFAULT_ROUNDS, type DebateDeps } from './debate.js';
import { readDiff } from './git-info.js';
import type { SessionManager } from './session-manager.js';

/**
 * Binds the debate controller to real sessions, and keeps the record a human
 * reads while it runs.
 *
 * Separate from debate.ts so the exchange logic stays testable without
 * spawning anything, and separate from gateway.ts because an exchange outlives
 * the socket that asked for it — the browser can reload, or close, and the two
 * agents carry on. The status lives here for whoever connects next.
 */
export class DebateRunner {
  private readonly debates = new Map<string, DebateStatus>();

  constructor(
    private readonly manager: SessionManager,
    private readonly broadcast: (debate: DebateStatus) => void,
  ) {}

  /**
   * Sessions belonging to an exchange that is still going.
   *
   * A debate runs for minutes with nobody watching — that is the entire point
   * of it — so the rule that stops sessions when the browser closes would
   * otherwise kill one mid-argument. Observed live: both sessions were stopped
   * between the review and the rebuttal, and the exchange reported that the
   * author "said nothing". Bounded rounds and per-turn timeouts are what make
   * keeping these alive safe; they cannot run forever.
   */
  activeSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const debate of this.debates.values()) {
      if (debate.state !== 'running') continue;
      if (debate.authorSessionId) ids.add(debate.authorSessionId);
      if (debate.reviewerSessionId) ids.add(debate.reviewerSessionId);
    }
    return ids;
  }

  /**
   * Clears the approvals an exchange can clear for itself, and escalates the
   * rest.
   *
   * Called on every session update because a parked `canUseTool` produces no
   * other signal. Without it a debate does not run slowly, it DEADLOCKS: the
   * session waits for a human who is not watching, which is the entire premise
   * of having started an exchange in the first place.
   */
  onSessionUpdate(summary: SessionSummary): void {
    const pending = summary.pendingApproval;
    if (!pending) return;
    const debate = this.owning(summary.id);
    if (!debate || debate.state !== 'running') return;

    if (isRoutineUnattended(pending.toolName)) {
      this.manager.get(summary.id)?.approve(pending.requestId);
      return;
    }
    // Not routine: the human decides. Recorded rather than denied, so the
    // session stays parked and they can still approve it themselves.
    const reason = escalationReason(pending.toolName);
    if (debate.blockedBy === reason) return;
    debate.blockedBy = reason;
    this.publish(debate);
  }

  private owning(sessionId: string): DebateStatus | undefined {
    for (const debate of this.debates.values()) {
      if (debate.authorSessionId === sessionId || debate.reviewerSessionId === sessionId) return debate;
    }
    return undefined;
  }

  /** Every exchange this server has run, newest first. */
  list(): DebateStatus[] {
    return [...this.debates.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Starts an exchange and returns immediately.
   *
   * Deliberately not awaited by the caller: it takes minutes, and a websocket
   * command handler that waits that long is a command handler that has stopped
   * serving everything else.
   */
  start(cmd: Extract<ClientCommand, { type: 'start_debate' }>): DebateStatus {
    const status: DebateStatus = {
      id: randomUUID(),
      objective: cmd.objective,
      subject: cmd.subject,
      state: 'running',
      authorSessionId: cmd.authorSessionId ?? '',
      author: cmd.author,
      reviewer: cmd.reviewer,
      startedAt: Date.now(),
      entries: [],
    };
    this.debates.set(status.id, status);
    this.publish(status);

    const deps: DebateDeps = {
      launch: (opts) => {
        // Sessions Claudia starts FOR an exchange run in 'auto', whatever the
        // asking tile uses. An exchange is unattended by definition, and the
        // stricter modes park on things an agent does constantly just to read a
        // repository — observed live, the author stopped dead on a `Bash` it
        // wanted for inspection. 'auto' is the mode that asks only about what
        // genuinely warrants asking, which is the same judgement a human would
        // apply if they were sitting here. Tiles the USER made keep their own
        // mode; this only governs the ones Claudia launches.
        const session = this.manager.launch({ cwd: opts.cwd, agent: opts.agent, permissionMode: 'auto' });
        // Recorded the moment it exists, not when the exchange finishes: the
        // idle-stop consults these ids while the debate is still running, and
        // an id that only appears at the end protects nothing.
        if (!status.authorSessionId) status.authorSessionId = session.id;
        else if (!status.reviewerSessionId) status.reviewerSessionId = session.id;
        this.publish(status);
        return session.id;
      },
      send: (sessionId, text) => this.manager.get(sessionId)?.sendPrompt(text),
      awaitSettled: (sessionId, timeoutMs) => this.manager.awaitSettled(sessionId, timeoutMs),
      transcript: (sessionId) => this.manager.get(sessionId)?.transcript.list() ?? [],
      readDiff: (cwd) => readDiff(cwd),
      note: (entry) => {
        delete status.blockedBy;
        status.entries.push(entry);
        this.publish(status);
      },
    };

    void runDebate(
      {
        cwd: cmd.cwd,
        objective: cmd.objective,
        subject: cmd.subject,
        ...(cmd.authorSessionId ? { authorSessionId: cmd.authorSessionId } : {}),
        author: cmd.author,
        reviewer: cmd.reviewer,
        rounds: cmd.rounds || DEFAULT_ROUNDS,
      },
      deps,
    )
      .then((result) => {
        status.state = 'done';
        status.authorSessionId = result.authorSessionId;
        status.reviewerSessionId = result.reviewerSessionId;
        status.rounds = result.rounds;
        if (result.verdict) status.verdict = result.verdict;
        if (result.stoppedBecause) status.stoppedBecause = result.stoppedBecause;
        this.publish(status);
      })
      .catch((err: unknown) => {
        // Never rejects outward: this runs detached from any request, where an
        // unhandled rejection ends the supervisor and takes every other
        // session with it. The failure belongs on the record instead.
        status.state = 'failed';
        status.error = err instanceof Error ? err.message : String(err);
        this.publish(status);
      });

    return status;
  }

  private publish(status: DebateStatus): void {
    this.broadcast({ ...status, entries: [...status.entries] });
  }
}
