import { describe, expect, it } from 'vitest';
import { approvalChange } from '../src/approval-change.js';

describe('approvalChange', () => {
  it('exposes only bounded Edit fields', () => {
    expect(approvalChange('Edit', {
      file_path: '/repo/a.ts', old_string: 'old', new_string: 'new', command: 'secret command', token: 'nope',
    })).toEqual({ kind: 'edit', path: '/repo/a.ts', before: 'old', after: 'new', truncated: false });
  });

  it('bounds large Write content', () => {
    const change = approvalChange('Write', { file_path: '/repo/a.ts', content: 'x'.repeat(1_001) });
    expect(change?.kind).toBe('write');
    // Narrowed rather than reached through: `after` is on the file arm of
    // ApprovalChange and not on the plan arm.
    if (change?.kind !== 'write') throw new Error('expected a write preview');
    expect(change.after).toHaveLength(1_002);
    expect(change.truncated).toBe(true);
  });

  it('does not make a preview from unrecognised tools or malformed fields', () => {
    expect(approvalChange('Bash', { command: 'rm -rf /', file_path: '/tmp/no' })).toBeUndefined();
    expect(approvalChange('Edit', { file_path: '/a', old_string: 'x' })).toBeUndefined();
  });

  it('builds a plan preview from ExitPlanMode input, which has no file_path', () => {
    // Real shape captured from a live SDK session: exactly these two keys,
    // no file_path — this must not fall through to the file_path bail-out.
    const input = { plan: '# Plan\n\nDo the thing.', planFilePath: '/home/user/.claude/plans/do-the-thing.md' };
    expect(approvalChange('ExitPlanMode', input)).toEqual({
      kind: 'plan',
      plan: '# Plan\n\nDo the thing.',
      planFilePath: '/home/user/.claude/plans/do-the-thing.md',
      truncated: false,
    });
  });

  it('bounds a large plan at its own, much larger limit', () => {
    const plan = 'x'.repeat(20_001);
    const change = approvalChange('ExitPlanMode', { plan, planFilePath: '/plans/big.md' });
    expect(change?.kind).toBe('plan');
    expect(change).toMatchObject({ truncated: true });
    if (change?.kind === 'plan') expect(change.plan).toHaveLength(20_002); // 20,000 chars + '\n…'
  });

  it('does not truncate a plan under the limit — the 1140-char plan that motivated this must pass untouched', () => {
    const plan = 'x'.repeat(1_140);
    const change = approvalChange('ExitPlanMode', { plan, planFilePath: '/plans/small.md' });
    expect(change).toEqual({ kind: 'plan', plan, planFilePath: '/plans/small.md', truncated: false });
  });

  it('gives no plan preview when a required field is missing or malformed', () => {
    expect(approvalChange('ExitPlanMode', { plan: 'text only' })).toBeUndefined();
    expect(approvalChange('ExitPlanMode', { planFilePath: '/plans/x.md' })).toBeUndefined();
  });
});
