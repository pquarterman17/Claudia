import { describe, expect, it } from 'vitest';
import { activeMention, insertMention } from '../src/mention';

describe('activeMention', () => {
  it('finds a token typed at the start of the message', () => {
    expect(activeMention('@SEC', 4)).toEqual({ start: 0, query: 'SEC' });
  });

  it('finds a token typed mid-message, after a space', () => {
    const text = 'please check @src/index';
    expect(activeMention(text, text.length)).toEqual({ start: 13, query: 'src/index' });
  });

  it('is null with no @ at all', () => {
    expect(activeMention('just a plain message', 10)).toBeNull();
  });

  it('is null once the token is closed by whitespace', () => {
    // The cursor is past the space, so the mention already ended.
    const text = '@file.ts and then some';
    expect(activeMention(text, text.length)).toBeNull();
  });

  it('is null for an email-like "@" that is not preceded by whitespace', () => {
    expect(activeMention('contact me at user@host', 'contact me at user@host'.length)).toBeNull();
  });

  it('only considers the @ nearest the cursor', () => {
    const text = '@one @two';
    expect(activeMention(text, text.length)).toEqual({ start: 5, query: 'two' });
  });

  it('is a live empty query right after typing the bare @', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' });
  });
});

describe('insertMention', () => {
  it('splices the path in for the token and places the cursor after the trailing space', () => {
    const text = 'please check @src/ind';
    const token = { start: 13, query: 'src/ind' };
    const result = insertMention(text, token, text.length, 'src/index.ts');
    expect(result.text).toBe('please check @src/index.ts ');
    expect(result.cursor).toBe(result.text.length);
  });

  it('preserves text typed after the cursor', () => {
    const text = '@fil and fix it';
    const token = { start: 0, query: 'fil' };
    // Cursor sits right after "fil", before " and fix it".
    const result = insertMention(text, token, 4, 'file.ts');
    expect(result.text).toBe('@file.ts  and fix it');
  });
});
