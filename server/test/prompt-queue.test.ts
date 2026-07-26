import { describe, expect, it } from 'vitest';
import { PromptQueue } from '../src/prompt-queue.js';

describe('PromptQueue', () => {
  it('preserves FIFO order', () => {
    const q = new PromptQueue();
    q.push('first');
    q.push('second');
    q.push('third');
    expect(q.list()).toEqual(['first', 'second', 'third']);
  });

  it('shift drops the oldest prompt', () => {
    const q = new PromptQueue();
    q.push('first');
    q.push('second');
    q.shift();
    expect(q.list()).toEqual(['second']);
  });

  it('shift on an empty queue is a no-op', () => {
    const q = new PromptQueue();
    expect(() => q.shift()).not.toThrow();
    expect(q.list()).toEqual([]);
  });

  it('clear empties the queue', () => {
    const q = new PromptQueue();
    q.push('first');
    q.push('second');
    q.clear();
    expect(q.list()).toEqual([]);
    expect(q.size).toBe(0);
  });

  it('list returns a copy — mutating it does not affect the queue', () => {
    const q = new PromptQueue();
    q.push('first');
    const copy = q.list();
    copy.push('intruder');
    expect(q.list()).toEqual(['first']);
  });

  it('size tracks the number of queued prompts', () => {
    const q = new PromptQueue();
    expect(q.size).toBe(0);
    q.push('a');
    expect(q.size).toBe(1);
    q.push('b');
    expect(q.size).toBe(2);
    q.shift();
    expect(q.size).toBe(1);
    q.clear();
    expect(q.size).toBe(0);
  });
});
