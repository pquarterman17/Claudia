import type { ModelChoice } from '@claudia/shared';

/**
 * The SDK query methods the terminal-parity controls use. Narrowed here so the
 * session can pass its query without leaking the whole SDK surface.
 */
export interface ParityQuery {
  setModel?: (model?: string) => Promise<void>;
  supportedModels?: () => Promise<
    Array<{ value: string; displayName?: string; description?: string; resolvedModel?: string }>
  >;
  generateSessionTitle?: (description: string, opts?: { persist?: boolean }) => Promise<string>;
}

/** Maps the SDK's rich model entries to what the picker needs. */
export async function listModels(q: ParityQuery | null): Promise<ModelChoice[]> {
  if (!q?.supportedModels) return [];
  try {
    const models = await q.supportedModels();
    return models.map((m) => ({
      value: m.value,
      displayName: m.displayName ?? m.resolvedModel ?? m.value,
      description: m.description ?? '',
    }));
  } catch {
    return [];
  }
}

/**
 * Asks the CLI to name the session from its first task, exactly as terminal
 * tab titles are generated. Failure means "keep the folder name" — a title is
 * never worth surfacing an error for.
 */
export async function autoTitle(q: ParityQuery | null, description: string): Promise<string | null> {
  if (!q?.generateSessionTitle || !description.trim()) return null;
  try {
    const title = await q.generateSessionTitle(description.slice(0, 200));
    return title?.trim() || null;
  } catch {
    return null;
  }
}
