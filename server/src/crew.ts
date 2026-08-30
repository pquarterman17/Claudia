import type { AgentKind, CrewMemberStatus } from '@claudia/shared';
import { crewBranch, memberPrompt, parseTasks, reportPrompt, splitPrompt, type CrewTask, type MemberReport } from './crew-plan.js';
import { assistantTextAfter } from './relay.js';

/**
 * One objective, split by an agent and worked by several at once.
 *
 * The debate stopped you carrying messages between two agents. This stops you
 * carrying the WORK: you gave one window a third of a job, another window a
 * different third, and then held all three in your head. Here an agent does
 * the splitting, each piece gets its own agent and its own checkout, and you
 * come back to one report.
 *
 * Bounded the same way the debate is, for the same reason — it spends real
 * quota on several agents with nobody watching. A hard cap on pieces, a
 * per-turn timeout on every wait, and no retries: a member that fails is
 * reported as failed, not attempted again at full price.
 */

/** Ceiling on pieces. Beyond a handful the split stops being a division of
 * labour and becomes an agent per file, each too small to be worth a turn. */
export const MAX_TASKS = 5;
export const DEFAULT_TASKS = 3;

/** The planner only thinks and writes; a member does the actual work. */
const PLAN_TIMEOUT_MS = 10 * 60_000;
const MEMBER_TIMEOUT_MS = 25 * 60_000;

export interface CrewSpec {
  cwd: string;
  objective: string;
  planner: AgentKind;
  /** Dealt round-robin across the pieces. Empty means the planner's agent. */
  workers: AgentKind[];
  maxTasks: number;
  /** Distinguishes this run's branches from an earlier run's. */
  runId: string;
}

export interface LaunchedMember {
  sessionId: string;
  /** Where it actually landed — its worktree, not the repository. */
  cwd: string;
  branch?: string;
}

export type CrewProgress =
  | { kind: 'planner'; sessionId: string }
  | { kind: 'planned'; members: CrewMemberStatus[] }
  | { kind: 'member'; index: number; patch: Partial<CrewMemberStatus> };

export interface CrewDeps {
  /** Starts a session. A `branch` asks for it to run in its own worktree. */
  launch: (opts: { cwd: string; agent: AgentKind; branch?: string }) => Promise<LaunchedMember>;
  send: (sessionId: string, text: string) => void;
  /** Resolves when that session's turn ends, however it ends. */
  awaitSettled: (sessionId: string, timeoutMs: number) => Promise<unknown>;
  transcript: (sessionId: string) => ReadonlyArray<{ kind: string; text: string }>;
  progress: (update: CrewProgress) => void;
  /** Stops a session this run started. Every session here is one of ours. */
  cancel: (sessionId: string) => void;
}

export interface CrewResult {
  plannerSessionId: string;
  members: CrewMemberStatus[];
  report?: string;
  /** Why the run did less than it was asked to, when that happened. */
  stoppedBecause?: string;
}

/**
 * Asks one session something and reads only what it says in reply.
 *
 * Same guard as the debate: a settled session satisfies `awaitSettled` the
 * instant it is asked, so without a mark in the transcript a member that never
 * ran "reports" whatever it last said. On a crew that is worse than on a
 * debate, because the report is what the human reads INSTEAD of the work.
 */
async function ask(sessionId: string, text: string, deps: CrewDeps, timeoutMs: number): Promise<string | undefined> {
  const baseline = deps.transcript(sessionId).length;
  deps.send(sessionId, text);
  await deps.awaitSettled(sessionId, timeoutMs);
  return assistantTextAfter(deps.transcript(sessionId), baseline);
}

export async function runCrew(spec: CrewSpec, deps: CrewDeps): Promise<CrewResult> {
  const cap = Math.max(1, Math.min(MAX_TASKS, Math.round(spec.maxTasks) || DEFAULT_TASKS));
  const agents = spec.workers.length ? spec.workers : [spec.planner];

  const planner = await deps.launch({ cwd: spec.cwd, agent: spec.planner });
  deps.progress({ kind: 'planner', sessionId: planner.sessionId });

  // Every session in a crew is one this run started, so all of them are ours
  // to stop. Collected as they appear rather than at the end: the failure this
  // guards against is a planner turn timing out while members are still
  // editing, and at that moment the members are the ones costing money.
  const launched: string[] = [planner.sessionId];
  // Declared out here so the cleanup below can reach the members even when the
  // failure happened before they were all populated.
  const members: CrewMemberStatus[] = [];
  try {

  const plan = await ask(planner.sessionId, splitPrompt(spec.objective, cap), deps, PLAN_TIMEOUT_MS);

  let stoppedBecause: string | undefined;
  let tasks = plan ? parseTasks(plan, cap) : [];
  if (tasks.length === 0) {
    // Doing nothing because a model answered in prose would be the worst
    // outcome available: the human asked for work, waited for a planning turn,
    // and got an error. One agent on the whole objective is what they would
    // have had anyway.
    tasks = [{ title: shortTitle(spec.objective), brief: spec.objective }];
    stoppedBecause = 'the planner did not return a usable split, so one agent took the whole objective';
  }

  members.push(
    ...tasks.map((task, i): CrewMemberStatus => ({
      title: task.title,
      brief: task.brief,
      agent: agents[i % agents.length] ?? spec.planner,
      branch: crewBranch(spec.runId, i, task.title),
      state: 'planned',
    })),
  );
  deps.progress({ kind: 'planned', members: members.map((m) => ({ ...m })) });

  await openCheckouts(members, spec, deps);
  await Promise.all(members.map((member, i) => work(member, i, tasks, spec, deps)));

  const reports: MemberReport[] = members.map((m) => ({
    title: m.title,
    ...(m.branch ? { branch: m.branch } : {}),
    ...(m.summary ? { summary: m.summary } : {}),
    ...(m.error ? { error: m.error } : {}),
  }));
  const report = await ask(planner.sessionId, reportPrompt(spec.objective, reports), deps, PLAN_TIMEOUT_MS);

    return {
      plannerSessionId: planner.sessionId,
      members,
      ...(report ? { report } : {}),
      ...(stoppedBecause ? { stoppedBecause } : {}),
    };
  } catch (err) {
    // The bookkeeping promise failing is not a reason to leave several agents
    // editing several worktrees with nobody reading the result.
    for (const member of members) if (member.sessionId) launched.push(member.sessionId);
    for (const id of launched) deps.cancel(id);
    throw err;
  }
}

/**
 * Opens every member's checkout, one at a time.
 *
 * Sequential on purpose, and this is the one place in the run that is: `git
 * worktree add` takes the repository lock, so starting five of them at once
 * makes four of them fail on a lock they cannot see. The work itself is
 * parallel — only the doors are opened in single file.
 */
async function openCheckouts(members: CrewMemberStatus[], spec: CrewSpec, deps: CrewDeps): Promise<void> {
  for (const [i, member] of members.entries()) {
    try {
      const started = await deps.launch({
        cwd: spec.cwd,
        agent: member.agent,
        ...(member.branch ? { branch: member.branch } : {}),
      });
      member.sessionId = started.sessionId;
      member.cwd = started.cwd;
      if (started.branch) member.branch = started.branch;
      member.state = 'running';
    } catch (err) {
      member.state = 'failed';
      member.error = describe(err);
    }
    deps.progress({ kind: 'member', index: i, patch: { ...member } });
  }
}

/** One member's turn. Never throws: the others are still running. */
async function work(
  member: CrewMemberStatus,
  index: number,
  tasks: CrewTask[],
  spec: CrewSpec,
  deps: CrewDeps,
): Promise<void> {
  if (!member.sessionId) return;
  const task = tasks[index];
  if (!task) return;
  try {
    const summary = await ask(
      member.sessionId,
      memberPrompt(spec.objective, task, member.branch ?? '(this branch)', tasks.map((t) => t.title)),
      deps,
      MEMBER_TIMEOUT_MS,
    );
    member.state = 'done';
    if (summary) member.summary = summary;
  } catch (err) {
    member.state = 'failed';
    member.error = describe(err);
  }
  deps.progress({ kind: 'member', index, patch: { ...member } });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A readable stand-in title when there was no plan to take one from. */
function shortTitle(objective: string): string {
  const first = objective.trim().split('\n')[0] ?? objective;
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || 'the objective';
}
