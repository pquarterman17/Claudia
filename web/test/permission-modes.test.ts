import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, permissionModeLabel } from '../src/permission-modes';

describe('PERMISSION_MODES', () => {
  it('includes plan, between accept edits and skip all — the CLI Shift+Tab order', () => {
    const keys = PERMISSION_MODES.map((m) => m.key);
    expect(keys).toContain('plan');
    expect(keys.indexOf('plan')).toBeGreaterThan(keys.indexOf('acceptEdits'));
    expect(keys.indexOf('plan')).toBeLessThan(keys.indexOf('bypassPermissions'));
  });

  it('does not mark plan as dangerous — it is the most restrictive mode, not the least', () => {
    const plan = PERMISSION_MODES.find((m) => m.key === 'plan');
    expect(plan?.danger).toBeFalsy();
  });

  it('keeps the other modes exactly as before — same keys, same labels', () => {
    const byKey = Object.fromEntries(PERMISSION_MODES.map((m) => [m.key, m]));
    expect(byKey.auto?.label).toBe('Auto');
    expect(byKey.default?.label).toBe('Ask each time');
    expect(byKey.acceptEdits?.label).toBe('Accept edits');
    expect(byKey.bypassPermissions?.label).toBe('Skip all');
    expect(byKey.bypassPermissions?.danger).toBe(true);
  });

  it('has exactly one entry per mode — no duplicates', () => {
    const keys = PERMISSION_MODES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('permissionModeLabel', () => {
  it('labels plan mode', () => {
    expect(permissionModeLabel('plan')).toBe('Plan');
  });

  it('falls back to the raw mode string for an unrecognized value', () => {
    // Defensive: a mode the SDK adds before this table catches up should
    // still render as something, not blow up the template it sits inside.
    expect(permissionModeLabel('dontAsk' as never)).toBe('dontAsk');
  });
});
