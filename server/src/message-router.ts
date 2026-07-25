import type { FeedStep, ModelUsage, SessionState } from '@claudia/shared';
import { errorStep, infoStep, resultStep, stepFromText, stepFromToolUse } from './feed.js';

/**
 * What one SDK message means for a session: feed steps, state, and — on result
 * messages only — authoritative cumulative usage.
 *
 * Usage deliberately never comes from `assistant` messages. Their
 * `usage.output_tokens` is a placeholder (observed 1 against a real 406), and
 * summing their `cache_read_input_tokens` double-counts the same cache on every
 * call in the turn. `result.modelUsage` is cumulative and correct, so it is
 * ASSIGNED, not added.
 */
export interface RoutedMessage {
  steps: FeedStep[];
  state?: SessionState;
  claudeSessionId?: string;
  model?: string;
  costUsd?: number;
  /** Cumulative session usage per model. Present only on result messages. */
  modelUsage?: ModelUsage[];
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
    return { steps, state: 'working' };
  }

  if (type === 'result') {
    const subtype = String(message['subtype'] ?? '');
    const costUsd = typeof message['total_cost_usd'] === 'number' ? message['total_cost_usd'] : undefined;
    const usage = parseModelUsage(message['modelUsage']);
    const common = {
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(usage ? { modelUsage: usage } : {}),
    };
    if (subtype.startsWith('error')) {
      return { steps: [errorStep('Turn failed', subtype)], state: 'error', errorMessage: subtype, ...common };
    }
    return { steps: [resultStep(costUsd ?? 0, Date.now() - turnStartedAt)], state: 'idle', ...common };
  }

  return EMPTY;
}

/** `modelUsage` is an object keyed by model id; flatten it to a stable array. */
function parseModelUsage(raw: unknown): ModelUsage[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return Object.entries(raw as Record<string, Record<string, unknown>>).map(([model, v]) => ({
    model,
    inputTokens: num(v['inputTokens']),
    outputTokens: num(v['outputTokens']),
    cacheReadTokens: num(v['cacheReadInputTokens']),
    cacheCreationTokens: num(v['cacheCreationInputTokens']),
    costUsd: num(v['costUSD']),
  }));
}
