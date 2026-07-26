import type { ModelChoice, SlashCommandInfo } from '@claudia/shared';

/** One entry as the SDK's supportedCommands() reports it, before flattening. */
interface RawSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  /** e.g. "/cost" and "/stats" both resolve to "/usage" — see flattenCommands. */
  aliases?: string[];
}

/**
 * The SDK query methods the terminal-parity controls use. Narrowed here so the
 * session can pass its query without leaking the whole SDK surface.
 */
export interface ParityQuery {
  setModel?: (model?: string) => Promise<void>;
  supportedModels?: () => Promise<
    Array<{ value: string; displayName?: string; description?: string; resolvedModel?: string }>
  >;
  supportedCommands?: () => Promise<RawSlashCommand[]>;
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
 *
 * This is a fallback only, for when supportedCommands() itself is unavailable
 * (see listCommands below). The live call turns out to genuinely cover both
 * names already: `context` is a real top-level command, and `cost` is a real
 * alias of `usage` — confirmed by probing a live session, which matched the
 * SDK's own doc comment on SlashCommand.aliases almost verbatim.
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
 * Splits each command into one selectable entry per name it actually answers
 * to. Without this, an alias-only command like `/cost` would never appear —
 * supportedCommands() reports it folded under `usage.aliases`, not as its own
 * entry with `name: 'cost'`.
 */
function flattenCommands(commands: RawSlashCommand[]): SlashCommandInfo[] {
  const out: SlashCommandInfo[] = [];
  for (const c of commands) {
    out.push({ name: c.name, description: c.description || undefined, argumentHint: c.argumentHint || undefined });
    for (const alias of c.aliases ?? []) {
      out.push({
        name: alias,
        description: c.description ? `${c.description} (alias for /${c.name})` : `Alias for /${c.name}`,
        argumentHint: c.argumentHint || undefined,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The composer's preferred source of slash commands: structured entries with
 * descriptions and argument hints, where the bare `slash_commands` array on
 * the init message has none. Returns `[]` on any failure — including an
 * SDK version too old to have the method — so the caller can keep whatever
 * the init-message fallback already gave it rather than showing nothing.
 */
export async function listCommands(q: ParityQuery | null): Promise<SlashCommandInfo[]> {
  if (!q?.supportedCommands) return [];
  try {
    return flattenCommands(await q.supportedCommands());
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
