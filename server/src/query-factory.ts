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

/**
 * The images that will actually reach the model, after type, per-image size,
 * and total-payload limits.
 *
 * Exported because the caller has to label the transcript with what was really
 * sent. Deriving the label from the raw client list instead made the record
 * lie: three 4 MB photos each pass the 5 MB per-image rule, but the third
 * exceeds the 10 MB total, so the transcript claimed three images while the
 * model received two.
 */
export function acceptedImages(images: PromptImage[]): PromptImage[] {
  let remaining = MAX_TOTAL_IMAGE_BYTES;
  return images.slice(0, 4).filter((image) => {
    if (!IMAGE_MEDIA_TYPES.has(image.mediaType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return false;
    const bytes = Math.floor((image.data.length * 3) / 4) - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES || bytes > remaining) return false;
    remaining -= bytes;
    return true;
  });
}

/** Builds the SDK's multimodal user envelope, with server-side input limits. */
export function userMessage(text: string, sessionId: string | undefined, images: PromptImage[] = []): unknown {
  const accepted = acceptedImages(images).map((image) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
  }));
  const content = accepted.length ? [{ type: 'text' as const, text }, ...accepted] : text;
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  };
}
