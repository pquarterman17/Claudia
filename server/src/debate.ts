import type { AgentKind, SessionSummary } from '@claudia/shared';
import { assistantTextAfter, lastAssistantText, rebuttalPrompt, reviewPrompt, verdictPrompt, type DebateSubject } from './relay.js';

/**
 * Two agents working the same problem until the answer survives both.
 *
 * The point is to stop the human being the message bus. Until now a second
 * opinion meant copying a diff out of one tile, pasting it into another
 * agent, carrying the reply back, and doing it again — which is why nobody
 * does it twice. This drives the exchange itself and hands back a verdict.
 *
 * Bounded on purpose, in three separate ways, because it spends real quota on
 * two agents with nobody watching: a hard round ceiling, a per-turn timeout on
 * every wait, and an early stop the moment the reviewer says it is satisfied.
 * An unbounded "argue until you agree" can cost an afternoon and still not
 * converge, since neither agent is obliged to yield.
 */

/** Round ceiling. Two is where the useful disagreement is: one critique, one
 * answer. Beyond four, exchanges observed in practice restate rather than
 * refine, at full price each time. */
export const MAX_ROUNDS = 4;
export const DEFAULT_ROUNDS = 2;

/** How long any single turn may take before the exchange gives up on it. */
const TURN_TIMEOUT_MS = 10 * 60_000;

export interface DebateSpec {
  cwd: string;
  objective: string;
  subject: DebateSubject;
  /** The session doing the work. Absent means launch one. */
  authorSessionId?: string;
  /** Agent for the author, when one is being launched. */
  author: AgentKind;
  /** Agent that reviews. Usually the other one — that is the entire point. */
  reviewer: AgentKind;
  rounds: number;
}

export interface DebateDeps {
  /** Starts a session and returns its id. */
  launch: (opts: { cwd: string; agent: AgentKind }) => string;
  send: (sessionId: string, text: string) => void;
  /** Resolves when that session's turn ends, however it ends. */
  awaitSettled: (sessionId: string, timeoutMs: number) => Promise<SessionSummary>;
  /** The session's transcript, for reading what it just said. */
  transcript: (sessionId: string) => ReadonlyArray<{ kind: string; text: string }>;
  readDiff: (cwd: string) => Promise<string | null>;
  /** Progress, for the record the human reads afterwards. */
  note: (entry: DebateEntry) => void;
  /** Stops a session this exchange started. See the cleanup in runDebate. */
  cancel: (sessionId: string) => void;
  /** A session's current state, so a dead or busy author is refused up front. */
  stateOf: (sessionId: string) => string | undefined;
}

export interface DebateEntry {
  round: number;
  speaker: AgentKind;
  role: 'opening' | 'review' | 'rebuttal' | 'verdict';
  text: string;
}

export interface DebateResult {
  authorSessionId: string;
  reviewerSessionId: string;
  rounds: number;
  entries: DebateEntry[];
  verdict?: string;
  /** Why it ended, when that was not simply running out of rounds. */
  stoppedBecause?: string;
}

/**
 * A reviewer that has nothing left to say, read from its own words rather than
 * by paying a third model to judge.
 *
 * Two rules keep it wrong only in the safe direction — a missed match costs one
 * more round, a false match DROPS A REAL OBJECTION. Agreement counts only in
 * the opening sentence, and any contrast word nearby vetoes it outright:
 * "I agree with the approach, but the retry never backs off" is an objection
 * wearing an agreement as a hat, and searching the whole text for "i agree"
 * would have swallowed it.
 */
export function reviewerIsSatisfied(critique: string): boolean {
  const text = critique.trim().toLowerCase();
  if (/\b(but|however|although|though|except|caveat|concerns?|issues?|wrong|missing)\b/.test(text.slice(0, 400))) {
    return false;
  }
  const opening = text.split(/[.!?\n]/)[0] ?? '';
  return /\b(i agree|agreed|no objections?|nothing to add|looks correct|no concerns|this is fine|lgtm)\b/.test(opening);
}

/**
 * Asks one session something and reads only what it says in reply.
 *
 * The baseline is the whole point. `awaitSettled` is satisfied instantly by a
 * session that is already settled, so without a mark in the transcript a
 * stopped author "answers" every question with whatever it last said.
 */
async function ask(
  sessionId: string,
  text: string,
  deps: DebateDeps,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<string | undefined> {
  const baseline = deps.transcript(sessionId).length;
  deps.send(sessionId, text);
  await deps.awaitSettled(sessionId, timeoutMs);
  return assistantTextAfter(deps.transcript(sessionId), baseline);
}

/**
 * States a session must not be in to take part.
 *
 * `idle` is the only state where a prompt gets a turn of its own. A stopped or
 * errored session never answers; a working one answers the question it was
 * already busy with, and the exchange reads that reply as though it were the
 * critique it asked for.
 */
export function canTakePart(state: string | undefined): boolean {
  return state === 'idle';
}

export async function runDebate(spec: DebateSpec, deps: DebateDeps): Promise<DebateResult> {
  const rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(spec.rounds)));

  // A tile the human picked may have died, or be mid-turn, between the click
  // and this call. Refusing up front costs nothing; proceeding spends two
  // agents' turns on an exchange whose author cannot answer.
  if (spec.authorSessionId && !canTakePart(deps.stateOf(spec.authorSessionId))) {
    return {
      authorSessionId: spec.authorSessionId,
      reviewerSessionId: '',
      rounds: 0,
      entries: [],
      stoppedBecause: `that session is ${deps.stateOf(spec.authorSessionId) ?? 'gone'}, so it cannot answer`,
    };
  }

  // Only what this exchange started is ours to stop. The human's own tile
  // keeps running whatever happens here.
  const launched: string[] = [];
  const launch = (agent: AgentKind): string => {
    const id = deps.launch({ cwd: spec.cwd, agent });
    launched.push(id);
    return id;
  };

  const authorSessionId = spec.authorSessionId ?? launch(spec.author);
  const reviewerSessionId = launch(spec.reviewer);

  const entries: DebateEntry[] = [];
  const record = (entry: DebateEntry): void => {
    entries.push(entry);
    deps.note(entry);
  };

  try {
    // A design question has nothing written yet, so the author answers first and
    // that answer becomes the material. The other two subjects already have
    // their material: a diff on disk, or the reply the session just gave.
    let material: string | undefined;
    if (spec.subject === 'plan') {
      material = await ask(authorSessionId, spec.objective, deps);
      if (material) record({ round: 0, speaker: spec.author, role: 'opening', text: material });
    } else if (spec.subject === 'diff') {
      material = (await deps.readDiff(spec.cwd)) ?? undefined;
    } else {
      material = lastAssistantText(deps.transcript(authorSessionId));
    }

    let stoppedBecause: string | undefined;
    let ran = 0;

    for (let round = 1; round <= rounds; round++) {
      ran = round;
      const critique = await ask(
        reviewerSessionId,
        reviewPrompt({
          subject: spec.subject,
          objective: spec.objective,
          ...(material ? { material } : {}),
          author: spec.author,
          round,
        }),
        deps,
      );
      if (!critique) {
        stoppedBecause = 'the reviewer said nothing';
        break;
      }
      record({ round, speaker: spec.reviewer, role: 'review', text: critique });

      if (reviewerIsSatisfied(critique)) {
        stoppedBecause = 'the reviewer had no objections';
        break;
      }

      const rebuttal = await ask(
        authorSessionId,
        rebuttalPrompt({
          subject: spec.subject,
          objective: spec.objective,
          ...(material ? { material } : {}),
          author: spec.reviewer,
          round,
          priorCritique: critique,
          // Only the first contact needs orienting, and only when the author was
          // started for this exchange rather than having done the work.
          needsContext: round === 1 && !spec.authorSessionId && spec.subject !== 'plan',
        }),
        deps,
      );
      if (!rebuttal) {
        stoppedBecause = 'the author said nothing';
        break;
      }
      record({ round, speaker: spec.author, role: 'rebuttal', text: rebuttal });

      // Later rounds argue about the answer as it now stands, not the original.
      material = spec.subject === 'diff' ? ((await deps.readDiff(spec.cwd)) ?? material) : rebuttal;
    }

    const verdict = await ask(authorSessionId, verdictPrompt(ran), deps);
    if (verdict) record({ round: ran, speaker: spec.author, role: 'verdict', text: verdict });

    return {
      authorSessionId,
      reviewerSessionId,
      rounds: ran,
      entries,
      ...(verdict ? { verdict } : {}),
      ...(stoppedBecause ? { stoppedBecause } : {}),
    };
  } catch (err) {
    // A turn timing out rejects this promise, but the agent behind it is still
    // running and still spending money on a question nobody will read. The
    // bookkeeping failing is not a reason to leave that going.
    for (const id of launched) deps.cancel(id);
    throw err;
  }
}
