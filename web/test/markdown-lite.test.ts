import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown-lite';

describe('renderMarkdown', () => {
  it('renders a fenced code block with a language', () => {
    const segments = renderMarkdown('```ts\nconst x = 1;\nconsole.log(x);\n```');
    expect(segments).toEqual([{ type: 'code-block', lang: 'ts', text: 'const x = 1;\nconsole.log(x);' }]);
  });

  it('renders a fenced code block with no language', () => {
    const segments = renderMarkdown('```\nplain block\n```');
    expect(segments).toEqual([{ type: 'code-block', text: 'plain block' }]);
  });

  it('renders inline code inside bold text', () => {
    const segments = renderMarkdown('**call `foo()` now**');
    expect(segments).toEqual([
      {
        type: 'paragraph',
        spans: [
          { text: 'call ', bold: true },
          { text: 'foo()', bold: true, code: true },
          { text: ' now', bold: true },
        ],
      },
    ]);
  });

  it('renders plain inline code without bold', () => {
    const segments = renderMarkdown('run `npm test` first');
    expect(segments).toEqual([
      {
        type: 'paragraph',
        spans: [{ text: 'run ' }, { text: 'npm test', code: true }, { text: ' first' }],
      },
    ]);
  });

  it('renders headings at levels 1 through 3', () => {
    const segments = renderMarkdown('# Title\n## Subtitle\n### Detail');
    expect(segments).toEqual([
      { type: 'heading', level: 1, spans: [{ text: 'Title' }] },
      { type: 'heading', level: 2, spans: [{ text: 'Subtitle' }] },
      { type: 'heading', level: 3, spans: [{ text: 'Detail' }] },
    ]);
  });

  it('renders "- " list items', () => {
    const segments = renderMarkdown('- first\n- second');
    expect(segments).toEqual([
      { type: 'list-item', spans: [{ text: 'first' }] },
      { type: 'list-item', spans: [{ text: 'second' }] },
    ]);
  });

  it('passes plain text through untouched', () => {
    const segments = renderMarkdown('just plain text, nothing special.');
    expect(segments).toEqual([{ type: 'paragraph', spans: [{ text: 'just plain text, nothing special.' }] }]);
  });

  it('treats a line that merely starts with # but has no space as a plain paragraph', () => {
    const segments = renderMarkdown('#nospace');
    expect(segments).toEqual([{ type: 'paragraph', spans: [{ text: '#nospace' }] }]);
  });

  it('skips blank lines', () => {
    const segments = renderMarkdown('first\n\nsecond');
    expect(segments).toEqual([
      { type: 'paragraph', spans: [{ text: 'first' }] },
      { type: 'paragraph', spans: [{ text: 'second' }] },
    ]);
  });

  it('an unclosed fence does not lose text — everything after it becomes code', () => {
    const segments = renderMarkdown('```js\nconst x = 1;\nstill going, never closed');
    expect(segments).toEqual([{ type: 'code-block', lang: 'js', text: 'const x = 1;\nstill going, never closed' }]);
  });

  it('pathological input of only a fence marker does not throw and keeps the marker as an empty block', () => {
    expect(() => renderMarkdown('```')).not.toThrow();
    expect(renderMarkdown('```')).toEqual([{ type: 'code-block', text: '' }]);
  });

  it('never throws on empty input', () => {
    expect(() => renderMarkdown('')).not.toThrow();
    expect(renderMarkdown('')).toEqual([]);
  });

  it('never throws on input with only markdown punctuation', () => {
    expect(() => renderMarkdown('** ` # - ```')).not.toThrow();
  });

  it('handles mixed content in one document without losing any segment', () => {
    const text = '# Heading\nsome text\n- a list item\n```\ncode here\n```\nmore text';
    const segments = renderMarkdown(text);
    expect(segments.map((s) => s.type)).toEqual([
      'heading',
      'paragraph',
      'list-item',
      'code-block',
      'paragraph',
    ]);
  });
});
