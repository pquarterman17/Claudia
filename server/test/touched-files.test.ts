import { describe, expect, it } from 'vitest';
import { TouchedFiles } from '../src/touched-files.js';

describe('TouchedFiles', () => {
  it('counts a write only once its result confirms it', () => {
    const touched = new TouchedFiles();
    touched.record({ toolUseId: 'a', path: '/repo/one.ts' });
    // Still in flight: a commit fired right now must not claim this file.
    expect(touched.paths).toEqual([]);
    touched.settle('a', false);
    expect(touched.paths).toEqual(['/repo/one.ts']);
  });

  it('drops a write whose tool call failed', () => {
    // A denied approval and a failed edit both come back as an error result,
    // and neither one wrote anything.
    const touched = new TouchedFiles();
    touched.record({ toolUseId: 'a', path: '/repo/denied.ts' });
    touched.settle('a', true);
    expect(touched.paths).toEqual([]);
  });

  it('takes an already-applied write with no id to confirm', () => {
    // Codex reports its file changes as done, with no result to match against.
    const touched = new TouchedFiles();
    touched.record({ path: '/repo/codex.ts' });
    expect(touched.paths).toEqual(['/repo/codex.ts']);
  });

  it('ignores results for calls that wrote nothing', () => {
    const touched = new TouchedFiles();
    touched.record({ toolUseId: 'write', path: '/repo/one.ts' });
    touched.settle('read', false); // a Read finishing, which is most of them
    touched.settle('write', false);
    expect(touched.paths).toEqual(['/repo/one.ts']);
  });

  it('reports a file written twice only once', () => {
    const touched = new TouchedFiles();
    touched.record({ toolUseId: 'a', path: '/repo/one.ts' });
    touched.settle('a', false);
    touched.record({ toolUseId: 'b', path: '/repo/one.ts' });
    touched.settle('b', false);
    expect(touched.paths).toEqual(['/repo/one.ts']);
  });

  it('ignores an empty path', () => {
    const touched = new TouchedFiles();
    touched.record({ path: '' });
    expect(touched.paths).toEqual([]);
  });
});
