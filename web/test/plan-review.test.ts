import { describe, expect, it } from 'vitest';
import { planFeedbackMessage } from '../src/plan-review';

describe('planFeedbackMessage', () => {
  it('trims surrounding whitespace', () => {
    expect(planFeedbackMessage('  please add error handling  ')).toBe('please add error handling');
  });

  it('returns undefined for an empty box', () => {
    expect(planFeedbackMessage('')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only box', () => {
    expect(planFeedbackMessage('   \n\t  ')).toBeUndefined();
  });
});
