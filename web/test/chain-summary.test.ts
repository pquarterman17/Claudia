import { describe, expect, it } from 'vitest';
import { chainSentence, formatSeconds } from '../src/chain-summary';

describe('chainSentence', () => {
  it('says nothing when the chain is empty', () => {
    expect(chainSentence({ labels: [], keys: [] })).toBeNull();
  });

  it('describes a single step without inventing a sequence', () => {
    expect(chainSentence({ labels: ['Notify me'], keys: ['notify'] })).toBe(
      'When every session settles, Claudia will notify me.',
    );
  });

  it('orders multiple steps with "then", so the sequence is unambiguous', () => {
    // "and" would read as a set; the whole question being answered is order.
    const s = chainSentence({
      labels: ['Notify me', 'Save learnings', 'Sleep displays'],
      keys: ['notify', 'memory', 'sleep'],
    });
    expect(s).toContain('notify me, then save learnings, then sleep displays');
  });

  it('spells out the grace period, because that is the escape hatch', () => {
    const s = chainSentence({ labels: ['Shut down host'], keys: ['shutdown'], countdownSec: 300 });
    expect(s).toContain('You get 5 minutes to cancel first.');
  });

  it('omits the grace clause when there is no countdown', () => {
    const s = chainSentence({ labels: ['Notify me'], keys: ['notify'], countdownSec: 0 });
    expect(s).not.toContain('cancel');
  });

  it('names the irreversible consequence in plain words', () => {
    const s = chainSentence({ labels: ['Notify me', 'Shut down host'], keys: ['notify', 'shutdown'] });
    expect(s).toContain('The last step means this machine powers off.');
  });

  it('reports the LAST irreversible step when several are chained', () => {
    // Sleeping then shutting down ends powered off, not asleep.
    const s = chainSentence({
      labels: ['Sleep displays', 'Shut down host'],
      keys: ['sleep', 'shutdown'],
    });
    expect(s).toContain('this machine powers off');
    expect(s).not.toContain('your displays turn off');
  });

  it('says what a commit step will and will not do, before it is armed', () => {
    // The branch rule is worth knowing while deciding whether to arm, not at
    // 3am from a failed step.
    const s = chainSentence({ labels: ['Commit + push', 'Shut down host'], keys: ['commit', 'shutdown'] });
    expect(s).toContain('only stages what each session wrote');
    expect(s).toContain('refuses on main or master');
  });

  it('stays silent about consequences for a harmless chain', () => {
    const s = chainSentence({ labels: ['Notify me'], keys: ['notify'] });
    expect(s).not.toContain('The last step means');
  });
});

describe('formatSeconds', () => {
  it('reads seconds below a minute', () => {
    expect(formatSeconds(30)).toBe('30 seconds');
  });

  it('reads whole minutes without a stray zero', () => {
    expect(formatSeconds(300)).toBe('5 minutes');
    expect(formatSeconds(60)).toBe('1 minute');
  });

  it('keeps the remainder when it is not a whole minute', () => {
    expect(formatSeconds(90)).toBe('1 minute 30s');
  });
});
