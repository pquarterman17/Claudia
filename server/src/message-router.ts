import type { FeedStep, SessionState } from '@claudia/shared';
import { errorStep, infoStep, resultStep, stepFromText, stepFromToolUse } from './feed.js';

/** What one SDK message means for a session: feed steps + state/usage deltas. */
export interface RoutedMessage {
  steps: FeedStep[];
  state?: SessionState;
  claudeSessionId?: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
}

const EMPTY: RoutedMessage = { steps: [] };

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * Pure mapping from an Agent SDK message to session effects. Pure on purpose:
 * every state transition in Claudia is testable without spawning a session.
 */
export function routeMessage(message: Record<string, unknown>, turnStartedAt: number): RoutedMessage {
  const type = message['type'];

  if (type === 'system' && message['subtype'] === 'init') {
    const model = typeof message['model'] === 'string' ? message['model'] : undefined;
    const sessionId = typeof message['session_id'] === 'string' ? message['session_id'] : undefined;
    return {
      steps: [infoStep('Session started', [model, message['cwd']].filter(Boolean).join(' · '))],
      state: 'working',
      ...(model ? { model } : {}),
      ...(sessionId ? { claudeSessionId: sessionId } : {}),
    };
  }

  if (type === 'assistant') {
    const inner = message['message'] as Record<string, unknown> | undefined;
    const usage = inner?.['usage'] as Record<string, unknown> | undefined;
    const steps: FeedStep[] = [];
    const content = inner?.['content'];
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_use') {
          steps.push(stepFromToolUse(String(block['name'] ?? 'tool'), (block['input'] as Record<string, unknown>) ?? {}));
        } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const step = stepFromText(block['text']);
          if (step) steps.push(step);
        }
      }
    }
    return {
      steps,
      state: 'working',
      inputTokens: num(usage?.['input_tokens']) + num(usage?.['cache_read_input_tokens']),
      outputTokens: num(usage?.['output_tokens']),
    };
  }

  if (type === 'result') {
    const subtype = String(message['subtype'] ?? '');
    const costUsd = typeof message['total_cost_usd'] === 'number' ? message['total_cost_usd'] : undefined;
    if (subtype.startsWith('error')) {
      return {
        steps: [errorStep('Turn failed', subtype)],
        state: 'error',
        errorMessage: subtype,
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }
    return {
      steps: [resultStep(costUsd ?? 0, Date.now() - turnStartedAt)],
      state: 'idle',
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }

  return EMPTY;
}
