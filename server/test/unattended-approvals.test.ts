import { describe, expect, it } from 'vitest';
import { escalationReason, isRoutineUnattended } from '../src/unattended-approvals.js';

/**
 * The one rule that decides what a run may do while nobody is watching.
 *
 * Pinned rather than trusted because being wrong here is not a bug in a panel:
 * being too narrow deadlocks a run on a Read, and being too wide means Claudia
 * approves writes on somebody's machine while they are out.
 */

describe('isRoutineUnattended', () => {
  it.each(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoRead', 'Codex Read', 'Codex Search'])(
    'clears %s, which cannot damage anything',
    (tool) => {
      expect(isRoutineUnattended(tool)).toBe(true);
    },
  );

  it.each(['Write', 'Edit', 'MultiEdit', 'Bash', 'WebFetch', 'NotebookEdit', 'Codex Shell'])(
    'escalates %s to a human',
    (tool) => {
      expect(isRoutineUnattended(tool)).toBe(false);
    },
  );

  it('escalates a tool this build has never heard of', () => {
    // The list is an allow-list on purpose: a deny-list would pre-approve
    // whatever either CLI adds next, sight unseen.
    expect(isRoutineUnattended('SomeFutureDeployTool')).toBe(false);
  });

  it('is not fooled by a name that merely starts with a safe one', () => {
    expect(isRoutineUnattended('ReadAndDelete')).toBe(false);
  });

  it('tolerates the whitespace a wire format leaves behind', () => {
    expect(isRoutineUnattended('  Read  ')).toBe(true);
  });

  it('is case sensitive, because tool names are', () => {
    expect(isRoutineUnattended('read')).toBe(false);
  });
});

describe('escalationReason', () => {
  it('names the tool it is waiting on', () => {
    // "Waiting for approval" without saying what for is what makes people stop
    // trusting an unattended process.
    expect(escalationReason('Bash')).toContain('Bash');
  });
});
