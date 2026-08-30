import type { TranscriptItem } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { TranscriptLog } from '../src/transcript-log.js';

/**
 * The cursor exists because the array's length does not work as one. Once the
 * log is at its cap, `length` reports the same number before and after a
 * reply — so an orchestrator using it as a position marker concludes the
 * session said nothing, and only on long-lived sessions, which are exactly
 * the ones a human has been working in.
 */

const say = (text: string): TranscriptItem => ({ ts: 1, kind: 'assistant', text });

describe('TranscriptLog cursor', () => {
  it('keeps counting after eviction starts, unlike length', () => {
    const log = new TranscriptLog(3);
    for (let i = 0; i < 10; i++) log.append(say(`m${i}`));
    expect(log.list()).toHaveLength(3);
    expect(log.cursor()).toBe(10);
  });

  it('finds a reply appended to a log already at its cap', () => {
    // The exact failure: at the cap, a length-based cursor sees 3 before and
    // 3 after, and concludes nothing was said.
    const log = new TranscriptLog(3);
    for (let i = 0; i < 3; i++) log.append(say(`old ${i}`));
    const lengthCursor = log.list().length;
    const cursor = log.cursor();

    log.append(say('the reply'));

    expect(log.list().slice(lengthCursor)).toEqual([]); // what the old code did
    expect(log.since(cursor)).toEqual([say('the reply')]); // what it does now
  });

  it('returns only what came after the cursor', () => {
    const log = new TranscriptLog(10);
    log.append(say('before'));
    const cursor = log.cursor();
    log.append(say('after one'));
    log.append(say('after two'));
    expect(log.since(cursor).map((i) => i.text)).toEqual(['after one', 'after two']);
  });

  it('returns nothing when nothing was appended', () => {
    const log = new TranscriptLog(10);
    log.append(say('a'));
    expect(log.since(log.cursor())).toEqual([]);
  });

  it('returns what survives when the cursor points at evicted entries', () => {
    // Better than a confident empty answer: the caller asked about a window
    // that has fallen out of the log, and something is still true.
    const log = new TranscriptLog(2);
    log.append(say('a'));
    const stale = log.cursor();
    for (const t of ['b', 'c', 'd']) log.append(say(t));
    expect(log.since(stale).map((i) => i.text)).toEqual(['c', 'd']);
  });

  it('does not rewind the cursor when the log is cleared', () => {
    // A cursor taken before a clear must not suddenly point into the middle
    // of the new conversation.
    const log = new TranscriptLog(10);
    log.append(say('a'));
    const cursor = log.cursor();
    log.clear();
    log.append(say('new conversation'));
    expect(log.cursor()).toBe(2);
    expect(log.since(cursor).map((i) => i.text)).toEqual(['new conversation']);
  });
});
