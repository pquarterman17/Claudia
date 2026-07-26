/**
 * Stable per-session accent color, so tiles named by folder basename (common
 * when several sessions share a repo) are still visually distinguishable at
 * a glance.
 */

/**
 * FNV-1a 32-bit hash. Cheap, deterministic, and — unlike summing
 * `charCodeAt`, which collides badly on short/similar strings — spreads
 * nearby ids (e.g. sequential session ids) across very different hues.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Same id always returns the same color. */
export function accentFor(id: string): string {
  const hue = fnv1a(id) % 360;
  return `hsl(${hue}, 42%, 58%)`;
}
