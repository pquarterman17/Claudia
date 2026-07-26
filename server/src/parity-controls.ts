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

/**
 * Built-ins the CLI accepts but leaves out of the `slash_commands` it advertises
 * at init, so the composer would never offer them.
 *
 * Only commands verified to actually run through an SDK session belong here:
 * `/todos` answers "Unknown command", and `/status` and `/help` reply that they
 * are not available in this environment, so none of them are listed. Advertising
 * a command that does nothing is worse than not advertising it.
 */
export const UNADVERTISED_COMMANDS = ['cost', 'context'] as const;

/** The advertised list plus the working built-ins it omits, deduped and sorted. */
export function mergeCommands(advertised: readonly string[]): string[] {
  return [...new Set([...advertised, ...UNADVERTISED_COMMANDS])].sort();
}

/**
 * Whether a model the user picked is the one a turn actually ran on.
 *
 * The picker deals in short names ("haiku", "opus[1m]") while a finished turn
 * reports a full identifier ("claude-haiku-4-5-20251001"), so this is a prefix
 * question rather than an equality one. "default" means "whatever the CLI
 * chooses", which any reported model satisfies.
 */
export function modelMatches(choice: string | undefined, reported: string | undefined): boolean {
  if (!choice || !reported) return false;
  if (choice === 'default') return true;
  // "opus[1m]" selects Opus with a larger context window; the family is the part
  // a reported model name can carry.
  const family = choice.replace(/\[.*\]$/, '').toLowerCase();
  return reported.toLowerCase().includes(family);
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
