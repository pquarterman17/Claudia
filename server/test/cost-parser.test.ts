import { describe, expect, it } from 'vitest';
import { parseCostReply } from '../src/cost-parser.js';

// Captured verbatim from a live session's reply to the literal prompt `/cost`.
// The separator is a middle dot (U+00B7); percentages are plain integers.
const REAL_SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Jul 26, 8:30pm (America/New_York)
Current week (all models): 27% used · resets Jul 29, 10pm (America/New_York)
Current week (Fable): 25% used · resets Jul 29, 10pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 4008 requests · 69 sessions
  90% of your usage was at >150k context
  65% of your usage came from subagent-heavy sessions`;

describe('parseCostReply', () => {
  it('parses the full real reply into session, all-models, and per-model windows', () => {
    const windows = parseCostReply(REAL_SAMPLE);
    expect(windows).toEqual([
      { label: 'Current session', kind: 'session', usedPct: 20, resetsAt: 'Jul 26, 8:30pm (America/New_York)' },
      {
        label: 'Current week (all models)',
        kind: 'week',
        usedPct: 27,
        resetsAt: 'Jul 29, 10pm (America/New_York)',
      },
      {
        label: 'Current week (Fable)',
        kind: 'week-model',
        model: 'Fable',
        usedPct: 25,
        resetsAt: 'Jul 29, 10pm (America/New_York)',
      },
    ]);
  });

  it('ignores the contributing-factors prose and stats block, not just the header', () => {
    // Lines like "90% of your usage was at >150k context" carry a percentage
    // too, but describe a behaviour, not a plan window — must not be mistaken
    // for one just because they contain a number and a "%".
    const windows = parseCostReply(REAL_SAMPLE);
    expect(windows).toHaveLength(3);
    expect(windows.some((w) => w.usedPct === 90 || w.usedPct === 65)).toBe(false);
  });

  it('returns no windows for an account not on a subscription', () => {
    // No documented format for this case, but the one thing we know for sure
    // is that it will not contain "Current session:" / "Current week:" lines
    // with a percentage — it reports dollars instead.
    const apiBilled = `You are using the Claude API to power your Claude Code usage. Costs are billed to your API account, not a subscription plan.

Session cost: $0.42
Total cost today: $3.15`;
    expect(parseCostReply(apiBilled)).toEqual([]);
  });

  it('never throws and returns [] for absent or garbage input', () => {
    expect(parseCostReply('')).toEqual([]);
    expect(parseCostReply('   \n\n  ')).toEqual([]);
    expect(parseCostReply('asdkjasd 123 !!! not a cost reply at all')).toEqual([]);
    // @ts-expect-error — defends the pure module against a bad caller at runtime, not just the type checker.
    expect(parseCostReply(null)).toEqual([]);
    // @ts-expect-error — same, for undefined.
    expect(parseCostReply(undefined)).toEqual([]);
  });

  it('handles a model name containing spaces and digits', () => {
    const line = 'Current week (Claude 3.5 Sonnet): 42% used · resets Jul 30, 5:00pm (UTC)';
    expect(parseCostReply(line)).toEqual([
      { label: 'Current week (Claude 3.5 Sonnet)', kind: 'week-model', model: 'Claude 3.5 Sonnet', usedPct: 42, resetsAt: 'Jul 30, 5:00pm (UTC)' },
    ]);
  });

  it.each([0, 100])('accepts the boundary percentage %i', (pct) => {
    const line = `Current session: ${pct}% used · resets Jul 26, 8:30pm (America/New_York)`;
    expect(parseCostReply(line)).toEqual([
      { label: 'Current session', kind: 'session', usedPct: pct, resetsAt: 'Jul 26, 8:30pm (America/New_York)' },
    ]);
  });

  it('rejects an out-of-range percentage rather than clamping it silently', () => {
    // Not a real case (the CLI would never print this) but a parser that
    // clamped 999 -> 100 would hide a format change instead of dropping the
    // line, which is the wrong failure mode for an estimate fallback.
    const line = 'Current session: 999% used · resets Jul 26, 8:30pm (America/New_York)';
    expect(parseCostReply(line)).toEqual([]);
  });
});
