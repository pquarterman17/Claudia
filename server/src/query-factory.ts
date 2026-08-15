import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, PermissionLaunchMode, PromptImage, ThinkingMode } from '@claudia/shared';

export interface QuerySpec {
  cwd: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
  effortLevel: EffortLevel;
  thinkingMode: ThinkingMode;
  /** Claude session to resume, for relaunches that must keep the conversation. */
  resume?: string;
  forkSession?: boolean;
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
      ...(spec.forkSession ? { forkSession: true } : {}),
      enableFileCheckpointing: true,
      permissionMode: spec.permissionMode,
      effort: spec.effortLevel,
      thinking: spec.thinkingMode === 'disabled' ? { type: 'disabled' } : { type: 'adaptive' },
      includePartialMessages: true,
      canUseTool: spec.onPermission as never,
    },
  });
}

/** The SDK's streaming-input envelope for one user prompt. */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

/** Builds the SDK's multimodal user envelope, with server-side input limits. */
export function userMessage(text: string, sessionId: string | undefined, images: PromptImage[] = []): unknown {
  let remaining = MAX_TOTAL_IMAGE_BYTES;
  const accepted = images.slice(0, 4).flatMap((image) => {
    if (!IMAGE_MEDIA_TYPES.has(image.mediaType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return [];
    const bytes = Math.floor((image.data.length * 3) / 4) - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES || bytes > remaining) return [];
    remaining -= bytes;
    return [{ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } }];
  });
  const content = accepted.length ? [{ type: 'text' as const, text }, ...accepted] : text;
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  };
}
