import type { FeedStep, ModelUsage, TranscriptItem } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { RoutedMessage } from './message-router.js';

/**
 * Pure mapping from a `codex app-server` notification to the same
 * `RoutedMessage` the Claude router produces.
 *
 * Deliberately targets the existing shape rather than inventing a second one:
 * the session state machine, feed, transcript, tool tracker and every UI
 * component downstream are already agent-agnostic, so translating at this one
 * point is what lets a Codex tile behave like any other tile.
 *
 * The vocabularies differ in ways worth naming:
 *  - Codex reports token usage on its own `thread/tokenUsage/updated`
 *    notification rather than at turn completion, and reports no dollar cost.
 *  - Its per-item lifecycle is always `item/started` then zero or more deltas
 *    then `item/completed`, so a finished call patches the step its start
 *    created instead of appending a second one.
 *  - Sub-agents are separate threads surfaced as `subAgentActivity` items, not
 *    nested inside the parent call the way a Claude Task step nests its children.
 */

const EMPTY: RoutedMessage = { steps: [] };

function step(kind: FeedStep['kind'], title: string, meta?: string, status?: FeedStep['status']): FeedStep {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind,
    title,
    ...(meta ? { meta } : {}),
    ...(status ? { status } : {}),
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Codex item status mapped onto the feed's running/ok/error. */
function statusOf(raw: unknown): FeedStep['status'] {
  if (raw === 'completed') return 'ok';
  if (raw === 'failed' || raw === 'declined') return 'error';
  return 'running';
}

interface MappedItem {
  step: FeedStep;
  transcript?: TranscriptItem;
}

/** One Codex thread item becomes one feed step, and sometimes a transcript entry. */
function stepForItem(item: Record<string, unknown>): MappedItem | null {
  const type = item['type'];
  const status = statusOf(item['status']);

  if (type === 'agentMessage') {
    const text = str(item['text']);
    if (!text) return null;
    return {
      step: step('text', text.replace(/\s+/g, ' ').slice(0, 200)),
      transcript: { ts: Date.now(), kind: 'assistant', text },
    };
  }

  if (type === 'reasoning') {
    const text = str(item['summary']) ?? str(item['content']);
    if (!text) return null;
    return {
      step: step('info', 'Thinking', text.slice(0, 160)),
      transcript: { ts: Date.now(), kind: 'thinking', text },
    };
  }

  if (type === 'commandExecution') {
    const command = Array.isArray(item['command'])
      ? (item['command'] as unknown[]).filter((c): c is string => typeof c === 'string').join(' ')
      : str(item['command']);
    const built = step('bash', 'Command', command, status);
    if (typeof item['durationMs'] === 'number') built.durMs = item['durationMs'];
    return {
      step: built,
      transcript: { ts: Date.now(), kind: 'tool_use', toolName: 'Command', text: command ?? '' },
    };
  }

  if (type === 'fileChange') {
    const changes = Array.isArray(item['changes']) ? (item['changes'] as Array<Record<string, unknown>>) : [];
    const paths = changes.map((c) => str(c['path'])).filter((p): p is string => Boolean(p));
    const meta = paths.length > 1 ? `${paths.length} files: ${paths.slice(0, 2).join(', ')}` : paths[0];
    return { step: step('edit', 'Edit', meta, status) };
  }

  if (type === 'mcpToolCall') {
    const label = `${str(item['server']) ?? 'mcp'} - ${str(item['tool']) ?? 'tool'}`;
    return { step: step('tool', label, undefined, status) };
  }

  if (type === 'webSearch') {
    return { step: step('read', 'Web search', str(item['query']), status) };
  }

  if (type === 'subAgentActivity') {
    return {
      step: step('tool', `Sub-agent ${str(item['kind']) ?? 'activity'}`, str(item['agentPath']), status),
    };
  }

  if (type === 'plan') {
    const text = str(item['text']);
    return text ? { step: step('info', 'Plan', text.slice(0, 160)) } : null;
  }

  return null;
}

/**
 * Token usage in Claudia's per-model shape.
 *
 * Codex reports no dollar cost anywhere, so cost stays zero for these tiles
 * rather than being invented — an estimated number in a column that is exact
 * for every other tile would be worse than an empty one.
 */
function usageFrom(params: Record<string, unknown>, model: string): ModelUsage[] {
  const raw = (params['usage'] ?? params) as Record<string, unknown>;
  const inputTokens = num(raw['input_tokens'] ?? raw['inputTokens']);
  const cacheReadTokens = num(raw['cached_input_tokens'] ?? raw['cachedInputTokens']);
  const outputTokens = num(raw['output_tokens'] ?? raw['outputTokens']);
  if (inputTokens + cacheReadTokens + outputTokens === 0) return [];
  return [
    {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: num(raw['cache_write_input_tokens'] ?? raw['cacheWriteInputTokens']),
      // Zero because Codex reports no dollar figure, not because the turn was
      // free. Tokens above are real; the cost column stays empty for these
      // tiles rather than showing an invented number beside exact ones.
      costUsd: 0,
    },
  ];
}

/**
 * Routes one app-server notification.
 *
 * Unknown methods return no effect, which the protocol explicitly asks clients
 * to do — a newer Codex adding notifications must not break a running tile.
 */
export function routeCodexMessage(
  method: string,
  params: Record<string, unknown>,
  model = 'codex',
): RoutedMessage {
  if (method === 'thread/started') {
    const id = str(params['threadId']) ?? str(params['thread_id']);
    return {
      steps: [step('info', 'Session started', id ? `codex - ${id.slice(0, 8)}` : 'codex')],
      state: 'working',
      ...(id ? { claudeSessionId: id } : {}),
    };
  }

  if (method === 'turn/started') return { steps: [], state: 'working' };

  if (method === 'turn/completed') {
    const turn = (params['turn'] ?? {}) as Record<string, unknown>;
    const status = turn['status'];
    if (status === 'failed') {
      const error = (turn['error'] ?? {}) as Record<string, unknown>;
      const message = str(error['message']) ?? 'The turn failed.';
      return { steps: [step('error', 'Turn failed', message)], state: 'error', errorMessage: message };
    }
    return {
      steps: [step('result', status === 'interrupted' ? 'Turn interrupted' : 'Turn complete')],
      state: 'idle',
    };
  }

  if (method === 'thread/tokenUsage/updated') {
    // Already cumulative, like the Claude SDK's modelUsage — assign, never add.
    const usage = usageFrom(params, model);
    return usage.length > 0 ? { steps: [], modelUsage: usage } : EMPTY;
  }

  if (method === 'item/agentMessage/delta') {
    const delta = str(params['delta']) ?? str(params['text']);
    return delta ? { steps: [], draftDelta: delta } : EMPTY;
  }

  if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
    const item = (params['item'] ?? {}) as Record<string, unknown>;
    const mapped = stepForItem(item);
    if (!mapped) return EMPTY;
    const id = str(item['id']);

    if (method === 'item/started' && id) {
      return {
        steps: [mapped.step],
        toolStarts: [{ toolUseId: id, stepId: mapped.step.id }],
        state: 'working',
      };
    }

    if (method === 'item/completed' && id && mapped.step.status !== undefined) {
      // Closes the step that item/started opened, so the call is not shown twice.
      return {
        steps: [],
        toolEnds: [{ toolUseId: id, isError: mapped.step.status === 'error' }],
        ...(mapped.transcript ? { transcriptItems: [mapped.transcript] } : {}),
      };
    }

    if (method === 'item/completed') {
      return {
        steps: [mapped.step],
        ...(mapped.transcript ? { transcriptItems: [mapped.transcript] } : {}),
      };
    }

    return EMPTY;
  }

  if (method === 'warning') {
    const message = str(params['message']);
    return message ? { steps: [step('info', 'Warning', message)] } : EMPTY;
  }

  if (method === 'error') {
    const message = str(params['message']) ?? 'Codex reported an error.';
    return { steps: [step('error', 'Error', message)], state: 'error', errorMessage: message };
  }

  return EMPTY;
}
