import { describe, expect, it } from 'vitest';
import { DraftBuffer } from '../src/draft-buffer.js';

describe('DraftBuffer', () => {
  it('emits the accumulated text when the interval has passed', () => {
    const d = new DraftBuffer(250);
    expect(d.append('Hel', 1000)).toBe('Hel'); // first emit is immediate
    expect(d.append('lo', 1100)).toBeNull(); // throttled
    expect(d.append(' world', 1300)).toBe('Hello world');
  });

  it('keeps accumulating while throttled — nothing is lost', () => {
    const d = new DraftBuffer(250);
    d.append('a', 1000);
    d.append('b', 1001);
    d.append('c', 1002);
    expect(d.current()).toBe('abc');
  });

  it('clear reports whether a draft existed, so a stray clear is not broadcast', () => {
    const d = new DraftBuffer();
    expect(d.clear()).toBe(false);
    d.append('x', 0);
    expect(d.clear()).toBe(true);
    expect(d.current()).toBe('');
  });

  it('resets the throttle on clear so the next turn emits immediately', () => {
    const d = new DraftBuffer(250);
    d.append('first', 1000);
    d.clear();
    expect(d.append('second', 1001)).toBe('second');
  });
});
