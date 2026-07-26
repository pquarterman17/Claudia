import type { FeedStep, ModelUsage, NeedsAction, SessionState, SubAgentRun, TranscriptItem } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
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
  /** Tool calls opened by this message, paired to the step representing them. */
  toolStarts?: Array<{ toolUseId: string; stepId: string }>;
  /** Tool results carried by this message, to be matched back by id. */
  toolEnds?: Array<{ toolUseId: string; isError: boolean }>;
  /** Claude ended the turn waiting on the user. `null` clears a previous one. */
  needsAction?: NeedsAction | null;
  /** Live sub-agent state, to be merged into the parent Task step. */
  subAgent?: { toolUseId: string; run: Partial<SubAgentRun> & { taskId: string } };
  /** A streamed text fragment of the reply currently being written. */
  draftDelta?: string;
  /** Full-fidelity transcript entries this message produced, never truncated. */
  transcriptItems?: TranscriptItem[];
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

  // Streaming deltas: the reply as it is being written, so the tile does not
  // sit frozen until the complete message lands.
  if (type === 'stream_event') {
    const event = message['event'] as Record<string, unknown> | undefined;
    if (event?.['type'] === 'content_block_delta') {
      const delta = event['delta'] as Record<string, unknown> | undefined;
      if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        return { steps: [], draftDelta: delta['text'] };
      }
    }
    return EMPTY;
  }

  // Sub-agents report progress on their own channel, tagged with the Task
  // tool_use_id that spawned them — which is what lets them nest.
  if (type === 'system' && message['subtype'] === 'task_progress') {
    const toolUseId = String(message['tool_use_id'] ?? '');
    const taskId = String(message['task_id'] ?? '');
    if (!toolUseId || !taskId) return EMPTY;
    const usage = (message['usage'] ?? {}) as Record<string, unknown>;
    return {
      steps: [],
      subAgent: {
        toolUseId,
        run: {
          taskId,
          agentType: String(message['subagent_type'] ?? 'agent'),
          description: String(message['description'] ?? ''),
          lastTool: typeof message['last_tool_name'] === 'string' ? message['last_tool_name'] : undefined,
          totalTokens: num(usage['total_tokens']),
          toolUses: num(usage['tool_uses']),
          durationMs: num(usage['duration_ms']),
          status: 'running',
        },
      },
    };
  }

  if (type === 'system' && message['subtype'] === 'task_notification') {
    const toolUseId = String(message['tool_use_id'] ?? '');
    const taskId = String(message['task_id'] ?? '');
    if (!toolUseId || !taskId) return EMPTY;
    const status = String(message['status'] ?? '');
    return {
      steps: [],
      subAgent: {
        toolUseId,
        run: {
          taskId,
          status: status === 'completed' ? 'completed' : 'error',
          summary: typeof message['summary'] === 'string' ? message['summary'] : undefined,
        },
      },
    };
  }

  // The SDK reports, per turn, whether it stopped because it needs the user.
  // Structured, so the question does not have to be spotted in the prose.
  if (type === 'system' && message['subtype'] === 'post_turn_summary') {
    const request = message['needs_action'];
    if (typeof request !== 'string' || !request.trim()) return { steps: [], needsAction: null };
    const detail = typeof message['status_detail'] === 'string' ? message['status_detail'] : undefined;
    return {
      steps: [
        {
          id: randomUUID(),
          ts: Date.now(),
          kind: 'approval',
          title: 'Waiting on you',
          meta: request,
        },
      ],
      needsAction: { request, since: Date.now(), ...(detail ? { detail } : {}) },
    };
  }

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
    // Work resuming means the question, if any, has been answered.
    const inner = message['message'] as Record<string, unknown> | undefined;
    const steps: FeedStep[] = [];
    const toolStarts: Array<{ toolUseId: string; stepId: string }> = [];
    const transcriptItems: TranscriptItem[] = [];
    const content = inner?.['content'];
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_use') {
          const name = String(block['name'] ?? 'tool');
          const input = (block['input'] as Record<string, unknown>) ?? {};
          const step = stepFromToolUse(name, input);
          step.status = 'running';
          steps.push(step);
          const id = block['id'];
          if (typeof id === 'string') toolStarts.push({ toolUseId: id, stepId: step.id });
          transcriptItems.push({ ts: Date.now(), kind: 'tool_use', toolName: name, text: JSON.stringify(input, null, 2) });
        } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const step = stepFromText(block['text']);
          if (step) steps.push(step);
          if (block['text'].trim()) transcriptItems.push({ ts: Date.now(), kind: 'assistant', text: block['text'] });
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string' && block['thinking'].trim()) {
          transcriptItems.push({ ts: Date.now(), kind: 'thinking', text: block['thinking'] });
        }
      }
    }
    return {
      steps,
      state: 'working',
      ...(toolStarts.length ? { toolStarts } : {}),
      ...(transcriptItems.length ? { transcriptItems } : {}),
    };
  }

  // User messages carry tool_result blocks — the other half of each tool call.
  if (type === 'user') {
    const inner = message['message'] as Record<string, unknown> | undefined;
    const content = inner?.['content'];
    if (!Array.isArray(content)) return EMPTY;
    const toolEnds: Array<{ toolUseId: string; isError: boolean }> = [];
    const transcriptItems: TranscriptItem[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] !== 'tool_result') continue;
      const id = block['tool_use_id'];
      // is_error is absent on success rather than false, so coerce.
      if (typeof id === 'string') toolEnds.push({ toolUseId: id, isError: block['is_error'] === true });
      const resultContent = block['content'];
      const text = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent, null, 2);
      transcriptItems.push({ ts: Date.now(), kind: 'tool_result', text });
    }
    return toolEnds.length ? { steps: [], toolEnds, transcriptItems } : EMPTY;
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
