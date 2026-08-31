import { describe, expect, it } from 'vitest';
import { crewBranch, memberPrompt, parseTasks, reportPrompt, splitPrompt } from '../src/crew-plan.js';

/**
 * The parser is the load-bearing part: everything downstream launches agents
 * and creates branches from whatever it returns. Both directions of being
 * wrong are pinned here — refusing a good plan over markdown decoration, and
 * inventing tasks out of a model's prose.
 */

describe('parseTasks', () => {
  it('reads the plain shape it asked for', () => {
    const tasks = parseTasks(
      ['TASK: rate limiting', 'DO: add a token bucket to the API layer.', 'TASK: health endpoint', 'DO: expose /healthz.'].join('\n'),
      5,
    );
    expect(tasks).toEqual([
      { title: 'rate limiting', brief: 'add a token bucket to the API layer.' },
      { title: 'health endpoint', brief: 'expose /healthz.' },
    ]);
  });

  it.each([
    ['- **TASK:** retries', '- **DO:** wrap the client.'],
    ['1. TASK - retries', '   DO - wrap the client.'],
    ['* TASK : retries', '* DO : wrap the client.'],
    ['task: retries', 'do: wrap the client.'],
  ])('survives decoration: %s', (taskLine, doLine) => {
    // A model asked for a plain line will bullet and bold it anyway. Throwing
    // away a usable plan over asterisks would be the dumbest possible failure.
    const tasks = parseTasks([taskLine, doLine].join('\n'), 5);
    expect(tasks).toEqual([{ title: 'retries', brief: 'wrap the client.' }]);
  });

  it('treats loose prose under a task as more of its brief, never as a task', () => {
    const tasks = parseTasks(
      ['TASK: caching', 'DO: add an LRU.', 'It should be bounded.', 'Do not touch the router.'].join('\n'),
      5,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.brief).toBe('add an LRU. It should be bounded. Do not touch the router.');
  });

  it('ignores prose before the first task line', () => {
    const tasks = parseTasks(
      ['Sure! I looked at the repo and I think this splits into two pieces.', '', 'TASK: one', 'DO: do one.'].join('\n'),
      5,
    );
    expect(tasks).toEqual([{ title: 'one', brief: 'do one.' }]);
  });

  it('finds nothing in an answer that is only prose', () => {
    // The caller falls back to one agent on the whole objective. Guessing
    // tasks out of sentences would launch agents at work nobody described.
    expect(parseTasks('I do not think this should be split up at all.', 5)).toEqual([]);
  });

  it('stops at the cap however many the planner returned', () => {
    const plan = Array.from({ length: 9 }, (_, i) => `TASK: piece ${i}\nDO: do piece ${i}.`).join('\n');
    expect(parseTasks(plan, 3)).toHaveLength(3);
  });

  it('drops a repeated title', () => {
    // Two members with one title means two members in one worktree, editing
    // each other's work — the exact collision the branches exist to prevent.
    const tasks = parseTasks(['TASK: api', 'DO: first.', 'TASK: API', 'DO: second.'].join('\n'), 5);
    expect(tasks).toEqual([{ title: 'api', brief: 'first.' }]);
  });

  it('drops a task with no title at all', () => {
    expect(parseTasks(['TASK:', 'DO: something.'].join('\n'), 5)).toEqual([]);
  });

  it('keeps a task whose brief the planner forgot', () => {
    // A titled piece with no brief is still work; the member gets the whole
    // objective for context regardless.
    expect(parseTasks('TASK: docs', 5)).toEqual([{ title: 'docs', brief: '' }]);
  });
});

describe('crewBranch', () => {
  it('makes a git-legal branch out of an arbitrary title', () => {
    const branch = crewBranch('ab12cd', 0, 'Rate limiting: the API layer!');
    expect(branch).toBe('claudia/crew-ab12cd-1-rate-limiting-the-api-layer');
    // ensureWorktree rejects these outright, so a title containing one must
    // not survive into the name.
    expect(branch).not.toMatch(/[\s~^:?*[\\]/);
  });

  it("separates runs, so a second crew cannot land in an earlier one's checkouts", () => {
    // Worktrees are reused when the directory exists. Without the run token a
    // repeat of the same objective would open inside the earlier run's work.
    expect(crewBranch('aaaaaa', 0, 'caching')).not.toBe(crewBranch('bbbbbb', 0, 'caching'));
  });

  it('separates pieces within one run', () => {
    expect(crewBranch('aaaaaa', 0, 'x')).not.toBe(crewBranch('aaaaaa', 1, 'x'));
  });

  it('still produces a name when the title has nothing usable in it', () => {
    expect(crewBranch('aaaaaa', 0, '!!! ***')).toBe('claudia/crew-aaaaaa-1-task');
  });

  it('does not leave a trailing dash after truncating a long title', () => {
    const branch = crewBranch('aaaaaa', 0, `${'a'.repeat(31)} tail`);
    expect(branch.endsWith('-')).toBe(false);
  });
});

describe('the prompts', () => {
  it('states the cap and permits fewer pieces', () => {
    const prompt = splitPrompt('do the thing', 4);
    expect(prompt).toContain('At most 4 pieces');
    expect(prompt).toContain('Fewer is better');
  });

  it('tells a member the whole objective as well as its own piece', () => {
    // A member that only knows its fragment makes choices that contradict the
    // other members, and the report then reads as a pile of conflicts.
    const prompt = memberPrompt('build the API', { title: 'retries', brief: 'wrap the client.' }, 'claudia/crew-x-1-retries', [
      'retries',
      'caching',
    ]);
    expect(prompt).toContain('build the API');
    expect(prompt).toContain('wrap the client.');
    expect(prompt).toContain('claudia/crew-x-1-retries');
  });

  it('names the siblings so a member does not do their work too', () => {
    const prompt = memberPrompt('o', { title: 'retries', brief: 'b' }, 'br', ['retries', 'caching']);
    expect(prompt).toContain('caching');
    expect(prompt).not.toMatch(/right now: [^\n]*retries/);
  });

  it('says nothing about siblings when a member is working alone', () => {
    const prompt = memberPrompt('o', { title: 'only', brief: 'b' }, 'br', ['only']);
    expect(prompt).not.toContain('Other agents are doing');
  });

  it('tells the member to leave the work uncommitted', () => {
    // The panel promises this. A member that commits by itself would make the
    // promise a lie on the one surface the human trusts.
    expect(memberPrompt('o', { title: 't', brief: 'b' }, 'br', ['t'])).toContain('uncommitted');
  });

  it('shows the planner a failed member as failed, not as silence', () => {
    const prompt = reportPrompt('o', [
      { title: 'a', branch: 'br-a', summary: 'did a' },
      { title: 'b', branch: 'br-b', error: 'no worktree' },
    ]);
    expect(prompt).toContain('FAILED: no worktree');
    expect(prompt).toContain('did a');
  });

  it('marks a member that said nothing rather than leaving a blank', () => {
    expect(reportPrompt('o', [{ title: 'a' }])).toContain('(said nothing)');
  });

  it('forbids re-reading the repository for the report', () => {
    // Otherwise the closing turn is another full exploration, at full price,
    // to re-derive what it has just been handed.
    expect(reportPrompt('o', [{ title: 'a', summary: 's' }])).toContain('Do not re-read the repository');
  });

  it('asks for the four things a human actually needs', () => {
    const prompt = reportPrompt('o', [{ title: 'a', summary: 's' }]);
    for (const key of ['DONE:', 'CONFLICTS:', 'LEFT:', 'NEEDS YOU:']) expect(prompt).toContain(key);
  });
});
