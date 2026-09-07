import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftBuffer } from '../src/draft-buffer.js';

/** Collects what the buffer told the UI, in order. */
function spy() {
  const emitted: string[] = [];
  return { emitted, emit: (draft: string) => void emitted.push(draft) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DraftBuffer', () => {
  it('emits the accumulated text when the interval has passed', () => {
    const { emitted, emit } = spy();
    const d = new DraftBuffer(emit, 250);
    d.append('Hel', 1000); // first delta of a turn is never throttled
    d.append('lo', 1100); // inside the window
    d.append(' world', 1300);
    expect(emitted).toEqual(['Hel', 'Hello world']);
  });

  it('keeps accumulating while throttled — nothing is lost', () => {
    const { emitted, emit } = spy();
    const d = new DraftBuffer(emit, 250);
    d.append('a', 1000);
    d.append('b', 1001);
    d.append('c', 1002);
    d.append('d', 1300);
    expect(emitted).toEqual(['a', 'abcd']);
  });

  // The bug this class exists to avoid: a burst lands in a few milliseconds and
  // is followed by a long pause. Only the leading token was ever broadcast, so
  // the tile sat on one character until the next burst — or until the complete
  // message landed and the whole answer appeared at once.
  it('flushes the tail of a burst without waiting for another delta', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { emitted, emit } = spy();
    const d = new DraftBuffer(emit, 250);
    d.append('The ');
    d.append('status ');
    d.append('is fine.');
    expect(emitted).toEqual(['The ']); // rest is inside the window

    vi.advanceTimersByTime(250);
    expect(emitted).toEqual(['The ', 'The status is fine.']);

    vi.advanceTimersByTime(10_000); // the pause: nothing more to say, nothing re-sent
    expect(emitted).toEqual(['The ', 'The status is fine.']);
  });

  it('schedules one flush per window however many deltas arrive', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { emitted, emit } = spy();
    const d = new DraftBuffer(emit, 250);
    for (let i = 0; i < 40; i += 1) {
      d.append('x');
      vi.advanceTimersByTime(10); // 400ms of dense streaming
    }
    expect(emitted.length).toBe(2); // leading edge, then one window boundary

    vi.advanceTimersByTime(250); // streaming stopped; the tail still lands
    expect(emitted.length).toBe(3);
    expect(emitted.at(-1)).toBe('x'.repeat(40));
  });

  it('clear reports whether a draft existed, so a stray clear is not broadcast', () => {
    const { emit } = spy();
    const d = new DraftBuffer(emit);
    expect(d.clear()).toBe(false);
    d.append('x', 0);
    expect(d.clear()).toBe(true);
  });

  // The complete message replaces the draft. A flush that fired afterwards
  // would put the half-written version back on screen.
  it('cancels a pending flush when the draft is cleared', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { emitted, emit } = spy();
    const d = new DraftBuffer(emit, 250);
    d.append('half');
    d.append(' written');
    expect(d.clear()).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual(['half']);
  });

  it('resets the throttle on clear so the next turn emits immediately', () => {
    const { emitted, emit } = spy();
    const d = new DraftBuffer(emit, 250);
    d.append('first', 1000);
    d.clear();
    d.append('second', 1001);
    expect(emitted).toEqual(['first', 'second']);
  });
});
