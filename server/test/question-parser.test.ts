import { describe, expect, it } from 'vitest';
import { parseQuestions, withAnswers } from '../src/question-parser.js';

const real = {
  questions: [
    {
      question: 'Which config file format should this use?',
      header: 'Format',
      multiSelect: false,
      options: [
        { label: 'JSON', description: 'Widely supported' },
        { label: 'TOML', description: 'Comments allowed' },
      ],
    },
  ],
};

describe('parseQuestions', () => {
  it('reads a real AskUserQuestion payload', () => {
    const q = parseQuestions(real);
    expect(q).toHaveLength(1);
    expect(q?.[0]).toMatchObject({ header: 'Format', multiSelect: false });
    expect(q?.[0]?.options.map((o) => o.label)).toEqual(['JSON', 'TOML']);
  });

  it('returns null for tools that are not questions', () => {
    expect(parseQuestions({ command: 'ls' })).toBeNull();
    expect(parseQuestions({})).toBeNull();
    expect(parseQuestions({ questions: [] })).toBeNull();
  });

  it('drops malformed entries rather than rendering an unanswerable picker', () => {
    expect(parseQuestions({ questions: [{ question: 'no options here', options: [] }] })).toBeNull();
    expect(parseQuestions({ questions: [{ options: [{ label: 'x', description: '' }] }] })).toBeNull();
  });

  it('keeps the good question when one of several is malformed', () => {
    const q = parseQuestions({ questions: [{ question: 'bad' }, ...real.questions] });
    expect(q).toHaveLength(1);
    expect(q?.[0]?.question).toBe('Which config file format should this use?');
  });

  it('carries multiSelect through', () => {
    const q = parseQuestions({
      questions: [{ ...real.questions[0], multiSelect: true }],
    });
    expect(q?.[0]?.multiSelect).toBe(true);
  });
});

describe('withAnswers', () => {
  it('adds answers keyed by question text, preserving the original input', () => {
    // Keyed by text, not index — that is what the tool expects back.
    const out = withAnswers(real, { 'Which config file format should this use?': 'TOML' });
    expect(out['answers']).toEqual({ 'Which config file format should this use?': 'TOML' });
    expect(out['questions']).toBe(real.questions);
  });
});
