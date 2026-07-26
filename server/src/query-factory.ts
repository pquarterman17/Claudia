import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionLaunchMode } from '@claudia/shared';

export interface QuerySpec {
  cwd: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
  /** Claude session to resume, for relaunches that must keep the conversation. */
  resume?: string;
  input: AsyncIterable<unknown>;
  onPermission: (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The one place a session query is constructed, so launch and relaunch cannot
 * drift apart. Partial messages are always on — the streamed draft is how the
 * tile stays visibly alive during a long first reply.
 */
export function createSessionQuery(spec: QuerySpec): ReturnType<typeof query> {
  return query({
    prompt: spec.input as AsyncIterable<never>,
    options: {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.resume ? { resume: spec.resume } : {}),
      permissionMode: spec.permissionMode,
      includePartialMessages: true,
      canUseTool: spec.onPermission as never,
    },
  });
}

/** The SDK's streaming-input envelope for one user prompt. */
export function userMessage(text: string, sessionId: string | undefined): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  };
}
