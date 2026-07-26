import { describe, expect, it } from 'vitest';
import { accentFor } from '../src/accent';

describe('accentFor', () => {
  it('is deterministic — same id always returns the same color', () => {
    const id = 'session-abc123';
    expect(accentFor(id)).toBe(accentFor(id));
  });

  it('matches the expected hsl format', () => {
    expect(accentFor('any-id')).toMatch(/^hsl\(\d+, 42%, 58%\)$/);
  });

  it('spreads a couple dozen random ids across at least a dozen distinct hues', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `session-${i}-${Math.random().toString(36).slice(2)}`);
    const hues = new Set(ids.map((id) => accentFor(id)));
    expect(hues.size).toBeGreaterThanOrEqual(12);
  });
});
