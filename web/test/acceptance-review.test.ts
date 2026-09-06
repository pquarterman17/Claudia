import { describe, expect, it } from 'vitest';
import { summary } from '../src/components/AcceptanceReview';

describe('acceptance review summary', () => {
  it('distinguishes waiting, rejected, incomplete, and decision-ready claims', () => {
    expect(summary(undefined)).toBe('Checking completion claim');
    expect(summary({ verdict: 'reject', reason: 'tests failed', missing: [] })).toBe('Evidence needs work');
    expect(summary({ verdict: 'needs_human', reason: '', missing: ['tests'] })).toBe('1 evidence gap');
    expect(summary({ verdict: 'needs_human', reason: '', missing: ['tests', 'branch'] })).toBe('2 evidence gaps');
    expect(summary({ verdict: 'needs_human', reason: 'green', missing: [] })).toBe('Ready for your decision');
  });
});
