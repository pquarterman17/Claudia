import { describe, expect, it } from 'vitest';
import { fmtModel } from '../src/format';

describe('fmtModel', () => {
  it('names the model, not just the vendor', () => {
    // Splitting the raw id on the first dash produced "claude" for everything,
    // which told you nothing about which model a session was running.
    expect(fmtModel('claude-opus-5')).toBe('Opus 5');
    expect(fmtModel('claude-sonnet-5')).toBe('Sonnet 5');
  });

  it('drops the date suffix real ids carry', () => {
    expect(fmtModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(fmtModel('claude-opus-4-5-20251101')).toBe('Opus 4.5');
  });

  it('marks the long-context variant, since it bills differently', () => {
    expect(fmtModel('claude-opus-5[1m]')).toBe('Opus 5 1M');
  });

  it('handles an unknown model without throwing', () => {
    expect(fmtModel(undefined)).toBe('model?');
    expect(fmtModel('something-odd')).toBe('Something');
  });
});
