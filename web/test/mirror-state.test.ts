import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@claudia/shared';
import { foldMirror, type Mirrors } from '../src/mirror-state';

/**
 * What the client keeps for a session it is only watching.
 *
 * The interesting cases are all about a mirror that is NOT open — closing races
 * every event already in flight, and rebuilding an entry from a fragment would
 * show a conversation that appears to start in the middle.
 */

const step = (id: string, status?: 'running' | 'ok' | 'error') => ({
  id,
  ts: 1,
  kind: 'tool' as const,
  title: 'Bash',
  ...(status ? { status } : {}),
});

const item = (text: string) => ({ ts: 1, kind: 'user' as const, text });

const opened = (sessionId: string): ServerEvent => ({
  type: 'mirror_opened',
  sessionId,
  transcript: [item('hello')],
  feed: [step('s1', 'running')],
  elided: 3,
});

describe('folding mirror events', () => {
  it('ignores events that are not a mirror', () => {
    expect(foldMirror(new Map(), { type: 'server_error', message: 'unrelated' })).toBeUndefined();
  });

  it('opens with the backlog, and says how much was cut', () => {
    const next = foldMirror(new Map(), opened('s'));
    expect(next?.get('s')?.elided).toBe(3);
    expect(next?.get('s')?.transcript).toHaveLength(1);
  });

  it('appends steps and items to an open mirror', () => {
    const open = foldMirror(new Map(), opened('s')) as Mirrors;
    const withStep = foldMirror(open, { type: 'mirror_step', sessionId: 's', step: step('s2') }) as Mirrors;
    const withItem = foldMirror(withStep, { type: 'mirror_item', sessionId: 's', item: item('more') }) as Mirrors;
    expect(withItem.get('s')?.feed.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(withItem.get('s')?.transcript.map((i) => i.text)).toEqual(['hello', 'more']);
  });

  it('revises a step already sent', () => {
    const open = foldMirror(new Map(), opened('s')) as Mirrors;
    const patched = foldMirror(open, {
      type: 'mirror_patch',
      sessionId: 's',
      stepId: 's1',
      patch: { status: 'ok', durMs: 12 },
    }) as Mirrors;
    expect(patched.get('s')?.feed[0]?.status).toBe('ok');
    expect(patched.get('s')?.feed[0]?.durMs).toBe(12);
  });

  it('drops events for a mirror that was closed', () => {
    // The race closing always has: the server read and sent before it saw the
    // close. Re-creating the entry here would start a conversation midway.
    const after = foldMirror(new Map(), { type: 'mirror_step', sessionId: 'gone', step: step('s9') });
    expect(after?.size).toBe(0);
  });

  it('records why there is nothing to read', () => {
    const next = foldMirror(new Map(), {
      type: 'mirror_unavailable',
      sessionId: 's',
      reason: 'no transcript for that session on this machine',
    });
    expect(next?.get('s')?.reason).toContain('no transcript');
    expect(next?.get('s')?.transcript).toEqual([]);
  });
});

describe('a hostile session id cannot poison anything', () => {
  // CodeQL flagged five remote-property-injection alerts when this state was a
  // plain object: the id arrives over the socket and became a property name.
  // The answer is the data structure, not a filter — a Map has no prototype to
  // reach, so these names are simply keys and the question stops being asked.
  it.each(['__proto__', 'constructor', 'prototype'])('stores %j as an ordinary key', (hostile) => {
    const after = foldMirror(new Map(), {
      type: 'mirror_opened',
      sessionId: hostile,
      transcript: [item('hello')],
      feed: [],
      elided: 0,
    });
    expect(after?.get(hostile)?.transcript).toHaveLength(1);
    // And nothing leaked into the prototype chain.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['transcript']).toBeUndefined();
  });

  it('ignores an empty id, which is not a session', () => {
    const after = foldMirror(new Map(), opened(''));
    expect(after?.size).toBe(0);
  });

  it('still folds a normal id', () => {
    const after = foldMirror(new Map(), opened('sess-1'));
    expect([...(after?.keys() ?? [])]).toEqual(['sess-1']);
  });
});
