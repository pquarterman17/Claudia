import { describe, expect, it } from 'vitest';
import { PromptHistory } from '../src/prompt-history';

describe('PromptHistory', () => {
  it('prev walks backward from the newest entry', () => {
    const h = new PromptHistory();
    h.push('one');
    h.push('two');
    h.push('three');
    expect(h.prev('')).toBe('three');
    expect(h.prev('')).toBe('two');
    expect(h.prev('')).toBe('one');
  });

  it('prev stops at the oldest entry rather than wrapping', () => {
    const h = new PromptHistory();
    h.push('only');
    expect(h.prev('')).toBe('only');
    expect(h.prev('')).toBe('only');
  });

  it('prev then next returns to the more recent entry, then null past the newest', () => {
    const h = new PromptHistory();
    h.push('one');
    h.push('two');
    h.push('three');
    expect(h.prev('')).toBe('three');
    expect(h.prev('')).toBe('two');
    expect(h.next()).toBe('three'); // walked back toward the present
    expect(h.next()).toBeNull(); // past the newest: caller restores its own draft
  });

  it('next with no active recall returns null', () => {
    const h = new PromptHistory();
    h.push('one');
    expect(h.next()).toBeNull();
  });

  it('collapses a consecutive duplicate push into one entry', () => {
    const h = new PromptHistory();
    h.push('same');
    h.push('same');
    expect(h.prev('')).toBe('same');
    expect(h.prev('')).toBe('same'); // only one entry — prev stays put, doesn't reveal a second
  });

  it('a duplicate that is not consecutive is kept as its own entry', () => {
    const h = new PromptHistory();
    h.push('a');
    h.push('b');
    h.push('a');
    expect(h.prev('')).toBe('a');
    expect(h.prev('')).toBe('b');
    expect(h.prev('')).toBe('a');
  });

  it('caps history at 50 entries, dropping the oldest', () => {
    const h = new PromptHistory();
    for (let i = 0; i < 60; i++) h.push(`p${i}`);
    // Newest is p59; walking all the way back should bottom out at p10, not p0.
    let last = '';
    for (let i = 0; i < 60; i++) {
      const v = h.prev('');
      if (v === null) break;
      last = v;
    }
    expect(last).toBe('p10');
  });

  it('reset (as push does after send) starts the next prev from the newest again', () => {
    const h = new PromptHistory();
    h.push('one');
    h.push('two');
    h.prev(''); // now recalling 'two'
    h.prev(''); // now recalling 'one'
    h.reset();
    expect(h.prev('')).toBe('two');
  });

  it('prev/next on an empty history never throws and returns null', () => {
    const h = new PromptHistory();
    expect(h.prev('draft')).toBeNull();
    expect(h.next()).toBeNull();
  });
});
