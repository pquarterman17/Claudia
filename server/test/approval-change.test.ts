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
    expect(change?.after).toHaveLength(1_002);
    expect(change?.truncated).toBe(true);
  });

  it('does not make a preview from unrecognised tools or malformed fields', () => {
    expect(approvalChange('Bash', { command: 'rm -rf /', file_path: '/tmp/no' })).toBeUndefined();
    expect(approvalChange('Edit', { file_path: '/a', old_string: 'x' })).toBeUndefined();
  });
});
