import type { ContextUsage } from '@claudia/shared';

function tokens(value: string): number | null {
  const match = value.trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const scale = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'b' ? 1_000_000_000 : 1;
  return Number.isFinite(amount) ? Math.round(amount * scale) : null;
}

/** Parses the stable headline of Claude Code's `/context` reply. */
export function parseContextReply(text: string, fetchedAt = Date.now()): ContextUsage | null {
  const usage = text.match(/\*\*Tokens:\*\*\s*([\d.,]+\s*[kmb]?)\s*\/\s*([\d.,]+\s*[kmb]?)\s*\((\d+(?:\.\d+)?)%\)/i);
  if (!usage) return null;
  const usedTokens = tokens(usage[1] ?? '');
  const maxTokens = tokens(usage[2] ?? '');
  if (usedTokens === null || maxTokens === null || maxTokens <= 0) return null;
  const model = text.match(/\*\*Model:\*\*\s*([^\r\n]+)/i)?.[1]?.trim();
  const free = text.match(/\|\s*Free space\s*\|\s*([\d.,]+\s*[kmb]?)\s*\|/i)?.[1];
  const freeTokens = free ? tokens(free) ?? undefined : undefined;
  return { model, usedTokens, maxTokens, usedPct: Number(usage[3]), freeTokens, fetchedAt };
}
