import { describe, expect, it } from 'vitest';
import { deriveAllowRule } from '../src/permission-rules.js';

describe('deriveAllowRule — happy paths', () => {
  it('derives an exact-match Bash rule, no wildcard added', () => {
    expect(deriveAllowRule('Bash', { command: 'npm run build' })).toBe('Bash(npm run build)');
  });

  it('derives an exact-match rule for PowerShell too', () => {
    expect(deriveAllowRule('PowerShell', { command: 'git status' })).toBe('PowerShell(git status)');
  });

  it('derives an exact-match rule for a file edit, keyed on file_path', () => {
    expect(deriveAllowRule('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' })).toBe(
      'Edit(/repo/src/a.ts)',
    );
  });

  it('covers Write, Read and NotebookEdit the same way', () => {
    expect(deriveAllowRule('Write', { file_path: '/repo/a.txt', content: 'hi' })).toBe('Write(/repo/a.txt)');
    expect(deriveAllowRule('Read', { file_path: '/repo/a.txt' })).toBe('Read(/repo/a.txt)');
    expect(deriveAllowRule('NotebookEdit', { file_path: '/repo/nb.ipynb' })).toBe('NotebookEdit(/repo/nb.ipynb)');
  });

  it('escapes a literal close-paren so it cannot break out of the rule', () => {
    expect(deriveAllowRule('Bash', { command: 'echo (hi)' })).toBe('Bash(echo (hi\\))');
  });

  it('trims surrounding whitespace before use', () => {
    expect(deriveAllowRule('Bash', { command: '  npm test  ' })).toBe('Bash(npm test)');
  });
});

describe('deriveAllowRule — never broader than the request that produced it', () => {
  it('never emits a bare tool name or an empty specifier', () => {
    expect(deriveAllowRule('Bash', {})).toBeUndefined();
    expect(deriveAllowRule('Bash', { command: '' })).toBeUndefined();
  });

  it('rejects a whitespace-only command', () => {
    expect(deriveAllowRule('Bash', { command: '   ' })).toBeUndefined();
    expect(deriveAllowRule('Bash', { command: '\t\n' })).toBeUndefined();
  });

  it('rejects a command that is just a wildcard — never a lone Bash(*)', () => {
    expect(deriveAllowRule('Bash', { command: '*' })).toBeUndefined();
    expect(deriveAllowRule('Bash', { command: '**' })).toBeUndefined();
    expect(deriveAllowRule('Bash', { command: '* *' })).toBeUndefined();
  });

  it('rejects when the relevant field is missing entirely', () => {
    expect(deriveAllowRule('Bash', { notCommand: 'ls' })).toBeUndefined();
    expect(deriveAllowRule('Edit', { old_string: 'x', new_string: 'y' })).toBeUndefined();
  });

  it('rejects when the relevant field is the wrong type', () => {
    expect(deriveAllowRule('Bash', { command: 123 })).toBeUndefined();
    expect(deriveAllowRule('Bash', { command: null })).toBeUndefined();
    expect(deriveAllowRule('Edit', { file_path: ['a', 'b'] })).toBeUndefined();
  });

  it('rejects a very long command rather than baking a huge line into settings', () => {
    expect(deriveAllowRule('Bash', { command: 'x'.repeat(501) })).toBeUndefined();
    // Right at the boundary is still fine.
    expect(deriveAllowRule('Bash', { command: 'x'.repeat(500) })).toBe(`Bash(${'x'.repeat(500)})`);
  });

  it('rejects a very long file path the same way', () => {
    expect(deriveAllowRule('Edit', { file_path: '/'.concat('a'.repeat(501)) })).toBeUndefined();
  });

  it('rejects a path containing a parent-traversal segment', () => {
    expect(deriveAllowRule('Read', { file_path: '../../etc/passwd' })).toBeUndefined();
    expect(deriveAllowRule('Read', { file_path: '/repo/../../etc/passwd' })).toBeUndefined();
    expect(deriveAllowRule('Read', { file_path: 'a\\..\\b' })).toBeUndefined(); // backslash form too
  });

  it('rejects a multi-line command, which could hide a second command from the visible rule text', () => {
    expect(deriveAllowRule('Bash', { command: 'echo hi\nrm -rf /' })).toBeUndefined();
  });

  it('never derives anything for a tool it does not recognise', () => {
    expect(deriveAllowRule('WebFetch', { url: 'https://example.com' })).toBeUndefined();
    expect(deriveAllowRule('AskUserQuestion', { questions: [] })).toBeUndefined();
    expect(deriveAllowRule('ExitPlanMode', { plan: 'text', planFilePath: '/x.md' })).toBeUndefined();
  });

  it('never derives a rule for a Codex tool call, even if it happens to carry a file_path — Codex never reads .claude/settings.local.json', () => {
    expect(deriveAllowRule('Codex Command', { command: 'ls' })).toBeUndefined();
    expect(deriveAllowRule('Codex Patch', { file_path: '/repo/a.ts' })).toBeUndefined();
  });

  it('rejects an empty tool name', () => {
    expect(deriveAllowRule('', { command: 'ls' })).toBeUndefined();
  });
});
