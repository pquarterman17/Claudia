import type { AgentKind } from './index.js';

/**
 * Runs where Claudia drives several agents itself, instead of you doing it.
 *
 * Two shapes live here because they answer the same complaint from opposite
 * ends. A DEBATE is one problem given to two agents so the answer has to
 * survive both; a CREW is one objective split into pieces given to several
 * agents at once so the work happens in parallel. In each case the human used
 * to be the message bus — copying a diff into another model, or holding four
 * half-finished threads in their head — and in each case they are now the
 * person who reads the result.
 *
 * Both are streamed while they run rather than delivered at the end. These
 * take minutes and spend real quota on several agents; a human who cannot see
 * one progressing cannot tell it from a hang, and will kill it.
 */

/** What two agents are arguing about. */
export type DebateSubject = 'diff' | 'plan' | 'last';

/** One turn in a cross-agent exchange. */
export interface DebateEntry {
  round: number;
  speaker: AgentKind;
  role: 'opening' | 'review' | 'rebuttal' | 'verdict';
  text: string;
}

/** A running or finished exchange between two agents. */
export interface DebateStatus {
  id: string;
  objective: string;
  subject: DebateSubject;
  state: 'running' | 'done' | 'failed';
  authorSessionId: string;
  reviewerSessionId?: string;
  author: AgentKind;
  reviewer: AgentKind;
  startedAt: number;
  /** Rounds actually run, once it has finished. */
  rounds?: number;
  entries: DebateEntry[];
  verdict?: string;
  /** Why it ended early, when it did. */
  stoppedBecause?: string;
  /** What the exchange is stuck on, when it needs a human to unblock it. */
  blockedBy?: string;
  error?: string;
}

/**
 * One piece of a split objective, and the agent carrying it.
 *
 * Carries its own `cwd` and `branch` because the pieces do not share a
 * checkout: several agents editing one working tree at the same time overwrite
 * each other silently, so each gets a worktree. `branch` is what the human
 * needs afterwards — the work is on it, not in front of them.
 */
export interface CrewMemberStatus {
  title: string;
  brief: string;
  agent: AgentKind;
  sessionId?: string;
  cwd?: string;
  branch?: string;
  state: 'planned' | 'running' | 'done' | 'failed';
  /** What that member said it did, once its turn ended. */
  summary?: string;
  error?: string;
}

/** An objective one agent split up and several worked in parallel. */
export interface CrewStatus {
  id: string;
  objective: string;
  /** `planning` is its own state because the split takes a full turn on its
   * own, before anything visible happens — without it the panel looks hung. */
  state: 'planning' | 'running' | 'done' | 'failed';
  planner: AgentKind;
  plannerSessionId?: string;
  startedAt: number;
  members: CrewMemberStatus[];
  /** The planner's read of what came back, written for a human. */
  report?: string;
  /** Why it ended without doing what was asked, when that happened. */
  stoppedBecause?: string;
  /** What it is stuck on, when it needs a human to unblock it. */
  blockedBy?: string;
  error?: string;
}
