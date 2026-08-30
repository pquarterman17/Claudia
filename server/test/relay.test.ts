import { describe, expect, it } from 'vitest';
import { lastAssistantText, rebuttalPrompt, reviewPrompt, verdictPrompt } from '../src/relay.js';

/**
 * These prompts are the feature. Two agents handed "what do you think?"
 * produce agreement theatre — each politely restating the other — and a
 * cross-agent review that always agrees is worse than none, because it reads
 * like corroboration. What is pinned here is the wording that makes a
 * disagreement possible: provenance, permission to agree, and permission to
 * refuse.
 */

const base = { objective: 'Add a retry to the upload path', author: 'claude' as const, round: 1 };

describe('reviewPrompt', () => {
  it('tells the reviewer another agent wrote this, by name', () => {
    // Without provenance an agent assumes the work is its own and defends it.
    const prompt = reviewPrompt({ ...base, subject: 'diff', material: '- a\n+ b' });
    expect(prompt).toContain('a different AI agent (Claude Code)');
    expect(prompt.toLowerCase()).toContain('not by you');
  });

  it('names Codex as the author when Codex did the work', () => {
    const prompt = reviewPrompt({ ...base, author: 'codex', subject: 'diff', material: 'x' });
    expect(prompt).toContain('Codex');
    expect(prompt).not.toContain('Claude Code');
  });

  it('carries the diff in a fenced block, with the task above it', () => {
    const prompt = reviewPrompt({ ...base, subject: 'diff', material: '--- a\n+++ b' });
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('--- a');
    expect(prompt).toContain('Add a retry to the upload path');
  });

  it('permits agreement, so the review is not obliged to invent faults', () => {
    // The failure mode this guards: a reviewer that must find something will,
    // and the human then cannot tell a real objection from a manufactured one.
    for (const subject of ['diff', 'last', 'plan'] as const) {
      const prompt = reviewPrompt({ ...base, subject, material: 'x' });
      expect(prompt, subject).toMatch(/if you agree, say so plainly/i);
      expect(prompt, subject).toMatch(/do not manufacture objections/i);
    }
  });

  it('critiques an answer rather than a diff for the `last` subject', () => {
    const prompt = reviewPrompt({ ...base, subject: 'last', material: 'I would use exponential backoff.' });
    expect(prompt).toContain('exponential backoff');
    expect(prompt).not.toContain('```diff');
  });

  it('asks for an independent answer first for a plain design question', () => {
    // Nothing has been written yet, so there is no work to review — asking it
    // to "review" an empty diff would produce nothing useful.
    const prompt = reviewPrompt({ ...base, subject: 'plan' });
    expect(prompt).toMatch(/independent opinion/i);
    expect(prompt).toContain('Add a retry to the upload path');
    expect(prompt).not.toContain('```diff');
  });

  it('says something sensible when there is nothing to show', () => {
    expect(reviewPrompt({ ...base, subject: 'diff' })).toContain('(no changes)');
    expect(reviewPrompt({ ...base, subject: 'last' })).toContain('(it said nothing)');
  });
});

describe('rebuttalPrompt', () => {
  it('explicitly allows holding the line, rather than demanding compliance', () => {
    // An orchestrator that says "address the feedback" produces capitulation,
    // and two agents agreeing on something wrong is the worst outcome here.
    const prompt = rebuttalPrompt({ ...base, subject: 'diff', author: 'codex', priorCritique: 'This leaks a handle.' });
    expect(prompt).toContain('This leaks a handle.');
    expect(prompt).toMatch(/where it is wrong or has missed context, say so/i);
    expect(prompt).toMatch(/do not change working code just because you were challenged/i);
  });

  it('names the reviewer so the author knows who it is answering', () => {
    expect(rebuttalPrompt({ ...base, subject: 'diff', author: 'codex', priorCritique: 'x' })).toContain('Codex');
  });

  it('asks for a machine-readable stance line', () => {
    const prompt = rebuttalPrompt({ ...base, subject: 'diff', author: 'codex', priorCritique: 'x' });
    expect(prompt).toContain('RESOLVED:');
    expect(prompt).toContain('DISPUTED:');
  });

  it('survives a critique that never arrived', () => {
    expect(rebuttalPrompt({ ...base, subject: 'diff', author: 'codex' })).toContain('(no critique given)');
  });
});

describe('verdictPrompt', () => {
  it('asks for the four things a human needs to decide whether to look', () => {
    const prompt = verdictPrompt(2);
    for (const heading of ['AGREED:', 'CHANGED:', 'DISPUTED:', 'NEEDS YOU:']) {
      expect(prompt).toContain(heading);
    }
  });

  it('counts the rounds it actually ran', () => {
    expect(verdictPrompt(1)).toContain('1 round');
    expect(verdictPrompt(3)).toContain('3 rounds');
  });
});

describe('lastAssistantText', () => {
  it('takes the most recent assistant message', () => {
    const items = [
      { kind: 'assistant', text: 'first' },
      { kind: 'tool_use', text: 'Read' },
      { kind: 'assistant', text: 'second' },
    ];
    expect(lastAssistantText(items)).toBe('second');
  });

  it('skips tool traffic and thinking, which are not an answer', () => {
    const items = [
      { kind: 'assistant', text: 'the answer' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'tool_result', text: 'ok' },
    ];
    expect(lastAssistantText(items)).toBe('the answer');
  });

  it('ignores an empty reply rather than critiquing whitespace', () => {
    expect(lastAssistantText([{ kind: 'assistant', text: '   ' }])).toBeUndefined();
    expect(lastAssistantText([])).toBeUndefined();
  });
});
