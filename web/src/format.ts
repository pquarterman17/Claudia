/** Small display formatters shared across components. */

export function elapsed(since: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  if (m > 59) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function fmtDur(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  return `${Math.round(s / 60)}m`;
}

/**
 * Short, readable model name. Raw ids look like
 * "claude-opus-4-5-20251101" or "claude-opus-5[1m]"; splitting on the first
 * dash gave "claude", which told you nothing about which model was running.
 */
export function fmtModel(model: string | undefined): string {
  if (!model) return 'model?';
  const longContext = /\[1m\]/.test(model);
  const core = model
    .replace(/\[1m\]/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
  const parts = core.split('-');
  const family = parts[0] ?? core;
  const version = parts.slice(1).filter((p) => /^[\d.]+$/.test(p)).join('.');
  const name = version ? `${cap(family)} ${version}` : cap(family);
  return longContext ? `${name} 1M` : name;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
