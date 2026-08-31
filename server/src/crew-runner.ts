import type { ClientCommand, CrewStatus, SessionSummary } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TASKS, runCrew, type CrewDeps } from './crew.js';
import type { SessionManager } from './session-manager.js';
import { escalationReason, isRoutineUnattended } from './unattended-approvals.js';
import { ensureWorktree } from './worktree.js';

/**
 * Binds the crew controller to real sessions and real checkouts.
 *
 * The interesting thing this adds over the controller is the checkout: a
 * member is launched into its own git worktree, not into the directory you are
 * looking at. That is not tidiness — several agents editing one working tree
 * at the same time overwrite each other's edits with no error and no way to
 * tell afterwards which change lost. Isolation is what makes running them at
 * once defensible at all.
 */
/** Which session a crew's `blockedBy` warning is about. */
const blockedFor = new Map<string, string>();

export class CrewRunner {
  private readonly crews = new Map<string, CrewStatus>();

  constructor(
    private readonly manager: SessionManager,
    private readonly broadcast: (crew: CrewStatus) => void,
  ) {}

  /** Every run this server has driven, newest first. */
  list(): CrewStatus[] {
    return [...this.crews.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Sessions belonging to a run that is still going.
   *
   * A crew is unattended by definition — you start it and leave — so the rule
   * that stops sessions once the browser closes would otherwise kill members
   * mid-edit and leave half-written files in a worktree nobody is watching.
   */
  activeSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const crew of this.crews.values()) {
      if (crew.state === 'done' || crew.state === 'failed') continue;
      if (crew.plannerSessionId) ids.add(crew.plannerSessionId);
      for (const member of crew.members) if (member.sessionId) ids.add(member.sessionId);
    }
    return ids;
  }

  /** Clears what a run may clear for itself, and records the rest for a human. */
  onSessionUpdate(summary: SessionSummary): void {
    const pending = summary.pendingApproval;
    if (!pending) return;
    const crew = this.owning(summary.id);
    if (!crew || crew.state === 'done' || crew.state === 'failed') return;

    if (isRoutineUnattended(pending.toolName)) {
      this.manager.get(summary.id)?.approve(pending.requestId);
      return;
    }
    const reason = escalationReason(pending.toolName);
    if (crew.blockedBy === reason) return;
    crew.blockedBy = reason;
    blockedFor.set(crew.id, summary.id);
    this.publish(crew);
  }

  private owning(sessionId: string): CrewStatus | undefined {
    for (const crew of this.crews.values()) {
      if (crew.plannerSessionId === sessionId) return crew;
      if (crew.members.some((m) => m.sessionId === sessionId)) return crew;
    }
    return undefined;
  }

  /**
   * Starts a run and returns immediately.
   *
   * Not awaited by the caller: planning alone is a full turn and the members
   * take many more, and a websocket handler that waits that long has stopped
   * serving the rest of the board.
   */
  start(cmd: Extract<ClientCommand, { type: 'start_crew' }>): CrewStatus {
    const id = randomUUID();
    const status: CrewStatus = {
      id,
      objective: cmd.objective,
      state: 'planning',
      planner: cmd.planner,
      startedAt: Date.now(),
      members: [],
    };
    this.crews.set(id, status);
    this.publish(status);

    const deps: CrewDeps = {
      launch: async (opts) => {
        let cwd = opts.cwd;
        let branch: string | undefined;
        if (opts.branch) {
          const tree = await ensureWorktree(opts.cwd, opts.branch);
          // Thrown rather than returned: a member that cannot get its own
          // checkout must not silently fall back to the shared one, which is
          // exactly the collision the worktree exists to prevent. runCrew
          // catches this and marks that one member failed.
          if (!tree.ok) throw new Error(tree.message);
          cwd = tree.path;
          branch = tree.branch;
        }
        // 'auto', like every session Claudia starts for itself: nobody is here
        // to answer the stricter modes' questions, and a member parked on a
        // prompt is a member that spends its whole timeout doing nothing.
        const session = this.manager.launch({ cwd, agent: opts.agent, permissionMode: 'auto' });
        return { sessionId: session.id, cwd, ...(branch ? { branch } : {}) };
      },
      send: (sessionId, text) => this.manager.get(sessionId)?.sendPrompt(text),
      // Every session a crew touches is one it launched, so stopping one can
      // never take down a tile the human is using.
      cancel: (sessionId) => this.manager.get(sessionId)?.stop(),
      awaitSettled: (sessionId, timeoutMs) => this.manager.awaitSettled(sessionId, timeoutMs),
      transcript: (sessionId) => this.manager.get(sessionId)?.transcript.list() ?? [],
      cursor: (sessionId) => this.manager.get(sessionId)?.transcript.cursor() ?? 0,
      since: (sessionId, cursor) => this.manager.get(sessionId)?.transcript.since(cursor) ?? [],
      progress: (update) => {
        // Cleared only by the member it belongs to. A parked session emits its
        // pending approval exactly once and then goes quiet, so any other
        // member finishing used to erase the warning — the panel showed a
        // healthy crew while one member sat parked for its whole timeout.
        const owner = blockedFor.get(status.id);
        const from = update.kind === 'member' ? status.members[update.index]?.sessionId : status.plannerSessionId;
        if (owner === undefined || owner === from) {
          delete status.blockedBy;
          blockedFor.delete(status.id);
        }
        if (update.kind === 'planner') status.plannerSessionId = update.sessionId;
        else if (update.kind === 'planned') {
          status.members = update.members;
          status.state = 'running';
        } else {
          const member = status.members[update.index];
          if (member) Object.assign(member, update.patch);
        }
        this.publish(status);
      },
    };

    void runCrew(
      {
        cwd: cmd.cwd,
        objective: cmd.objective,
        planner: cmd.planner,
        workers: cmd.workers,
        maxTasks: cmd.maxTasks || DEFAULT_TASKS,
        // Short and unique: it only has to separate this run's branches from
        // the ones a previous run on the same objective already created.
        runId: id.slice(0, 6),
      },
      deps,
    )
      .then((result) => {
        status.state = 'done';
        status.plannerSessionId = result.plannerSessionId;
        status.members = result.members;
        if (result.report) status.report = result.report;
        if (result.stoppedBecause) status.stoppedBecause = result.stoppedBecause;
        this.publish(status);
      })
      .catch((err: unknown) => {
        // Never rejects outward: this runs detached from any request, where an
        // unhandled rejection ends the supervisor and every other session with it.
        status.state = 'failed';
        status.error = err instanceof Error ? err.message : String(err);
        this.publish(status);
      });

    return status;
  }

  private publish(status: CrewStatus): void {
    this.broadcast({ ...status, members: status.members.map((m) => ({ ...m })) });
  }
}
