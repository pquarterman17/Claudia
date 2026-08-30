import type { AgentKind } from '@claudia/shared';
import { agentLabel } from './agent-labels.js';

/**
 * What one agent hands another.
 *
 * Claudia's sessions could not talk to each other at all: every message
 * between them went through the human, retyped or pasted. That is the whole
 * reason two agents on one problem is exhausting rather than useful, and this
 * module is the missing channel.
 *
 * The prompts are here, pure and tested, because they decide whether a
 * cross-agent exchange is worth anything. Two agents given "what do you think?"
 * produce agreement theatre — each politely restating the other. What makes a
 * critique load-bearing is telling the reviewer what it is looking at, that it
 * did not write it, and that saying "this is fine" is a permitted answer.
 */

/** What the agents are arguing about. */
export type DebateSubject = 'diff' | 'plan' | 'last';

export interface HandoffInput {
  subject: DebateSubject;
  /** The task, question or plan under discussion. */
  objective: string;
  /** The material itself: a diff, or the reply being critiqued. Absent for a
   * plain design question, where the objective IS the material. */
  material?: string;
  /** Who wrote the material, so the reviewer knows it is not its own work. */
  author: AgentKind;
  /** Which round this is, 1-based; later rounds are answering a critique. */
  round: number;
  /** The critique being answered, when this is a reply rather than an opening. */
  priorCritique?: string;
  /** True when the author was started for this exchange and has never seen the
   * work it is being asked to defend. */
  needsContext?: boolean;
}

const HONEST_DISAGREEMENT =
  'Be specific and concrete. If you agree, say so plainly and stop — do not manufacture objections to look useful. If you disagree, say exactly what is wrong and what you would do instead.';

/**
 * The opening ask to the reviewing agent.
 *
 * Names the author explicitly. An agent shown a diff with no provenance tends
 * to assume it wrote it and defends it; told another model wrote it, it
 * actually reviews.
 */
export function reviewPrompt(input: HandoffInput): string {
  const author = agentLabel(input.author);
  const head = `You are reviewing work done by a different AI agent (${author}), not by you. Do not assume it is correct.`;

  if (input.subject === 'diff') {
    return [
      head,
      '',
      `The task it was given:`,
      input.objective,
      '',
      'Its actual changes to the working tree:',
      '```diff',
      input.material ?? '(no changes)',
      '```',
      '',
      `Review this change. Does it do the task? Is it correct? What would you have done differently, and why does that matter?`,
      HONEST_DISAGREEMENT,
    ].join('\n');
  }

  if (input.subject === 'last') {
    return [
      head,
      '',
      'The question it was answering:',
      input.objective,
      '',
      'What it said:',
      input.material ?? '(it said nothing)',
      '',
      'Assess that answer. Is it right? Is it complete? What is it missing or getting wrong?',
      HONEST_DISAGREEMENT,
    ].join('\n');
  }

  return [
    `Another AI agent (${author}) is about to work on this, and you are being asked for an independent opinion first.`,
    '',
    'The question:',
    input.objective,
    '',
    'Give your own answer, then say what you think the main risk or wrong turn would be.',
    HONEST_DISAGREEMENT,
  ].join('\n');
}

/**
 * Handing a critique back to the agent that produced the work.
 *
 * Deliberately does NOT tell it to comply. An orchestrator that instructs the
 * author to "address the feedback" produces capitulation, not a debate, and
 * the human ends up with two agents who agree on something wrong. Standing
 * your ground with a reason has to be an allowed and named outcome.
 */
export function rebuttalPrompt(input: HandoffInput): string {
  const reviewer = agentLabel(input.author);
  // A session that did the work has the context already. One started FOR the
  // exchange does not: handed a bare critique it goes exploring the repository
  // to work out what it is accused of, which was observed taking longer than
  // the whole rest of the exchange. Orienting it costs a paragraph, not a turn.
  const brief = input.needsContext
    ? [
        'You are answering for the current state of this working tree.',
        '',
        'The task it was meant to do:',
        input.objective,
        ...(input.material ? ['', 'The change under discussion:', '```diff', input.material, '```'] : []),
        '',
      ]
    : [];
  return [
    ...brief,
    `A different AI agent (${reviewer}) reviewed your work. Its critique:`,
    '',
    input.priorCritique ?? '(no critique given)',
    '',
    'Respond to it point by point. Where it is right, say so and fix the problem. Where it is wrong or has missed context, say so and explain why — do not change working code just because you were challenged.',
    'Finish with one line starting "RESOLVED:" or "DISPUTED:" saying where things now stand.',
  ].join('\n');
}

/**
 * The closing ask, once the rounds are spent.
 *
 * Asked of the agent that did the work, because it is the one that can say
 * what actually changed. The human is reading this to find out whether they
 * need to look, so the shape is fixed rather than free prose.
 */
export function verdictPrompt(rounds: number): string {
  return [
    `That is the end of the review (${rounds} round${rounds === 1 ? '' : 's'}). Summarise for a human who has not been following, in this exact shape and nothing else:`,
    '',
    'AGREED: what you and the reviewer ended up agreeing on.',
    'CHANGED: what you actually changed as a result, or "nothing".',
    'DISPUTED: what you still disagree about, and the reason. Write "nothing" if there is none.',
    'NEEDS YOU: any decision a human has to make. Write "nothing" if there is none.',
    '',
    'Be brief. Do not restate the whole conversation.',
  ].join('\n');
}

/** The last thing an agent actually said, which is what gets critiqued. */
export function lastAssistantText(items: ReadonlyArray<{ kind: string; text: string }>): string | undefined {
  return assistantTextAfter(items, 0);
}

/**
 * The last thing an agent said AFTER a given point in its transcript.
 *
 * The point being guarded is that a settled session answers instantly. A
 * session that was stopped, errored, or was already idle satisfies "wait for
 * the turn to end" the moment it is asked, and reading "the last thing it
 * said" then returns a reply to some EARLIER question — which the exchange
 * presents as an answer to this one. Nothing about that failure looks wrong:
 * the text is real, fluent, and about the right repository.
 *
 * So every ask records where the transcript stood first, and anything at or
 * before that mark is somebody else's answer. Silence is the honest result,
 * and the callers already know how to report it.
 */
export function assistantTextAfter(
  items: ReadonlyArray<{ kind: string; text: string }>,
  sinceIndex: number,
): string | undefined {
  for (let i = items.length - 1; i >= Math.max(0, sinceIndex); i--) {
    const item = items[i];
    if (item && item.kind === 'assistant' && item.text.trim()) return item.text;
  }
  return undefined;
}
