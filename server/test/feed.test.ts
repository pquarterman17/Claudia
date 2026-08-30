import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from '../src/feed.js';

describe('summarizeToolInput', () => {
  it('gives ExitPlanMode a readable one-liner instead of dumping its input as JSON', () => {
    // Without this branch the plan text (no command/file_path/prompt field)
    // falls through to JSON.stringify(input), which is what notifications
    // and the activity digest would otherwise show verbatim.
    expect(summarizeToolInput('ExitPlanMode', { plan: '# Plan\n\nDo it.', planFilePath: '/plans/x.md' })).toBe(
      'Plan ready for review',
    );
  });

  it('still summarizes an ordinary Bash command', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test' })).toBe('npm test');
  });
});
