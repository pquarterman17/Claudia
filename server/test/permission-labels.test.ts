import type { PermissionLaunchMode } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { describeMode } from '../src/permission-labels.js';

describe('describeMode', () => {
  it('describes plan mode as research-only — no edits, no commands', () => {
    const text = describeMode('plan');
    expect(text).toMatch(/plan/i);
    expect(text).toMatch(/no edits|no commands/i);
  });

  it('describes every mode distinctly, so the feed never shows the same text twice', () => {
    const modes: PermissionLaunchMode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];
    const texts = modes.map(describeMode);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('leaves the existing modes worded exactly as before', () => {
    expect(describeMode('bypassPermissions')).toBe('permissions skipped — tools run without asking');
    expect(describeMode('acceptEdits')).toBe('edits auto-accepted; commands still ask');
    expect(describeMode('auto')).toBe('auto — Claude decides what needs asking');
    expect(describeMode('default')).toBe('approvals required');
  });
});
