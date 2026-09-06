import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prFactsFrom, pullRequestFor } from '../src/fleet/pr-facts.js';

/**
 * What the forge says about the branch a child worked on.
 *
 * `prUrl` and `prState` were declared, judged on, and written by nothing:
 * `judge` rejects a run whose pull request was closed and had never been told
 * about one, and `blocksCleanup` reads `prState === 'merged'` as one of its
 * two ways to confirm a branch is merged and only ever saw the other.
 *
 * The one piece of evidence with a soft dependency, so the case that matters
 * most is the absent one: no `gh`, no authentication, no pull request, or a
 * call that times out must all read as "nobody checked" rather than as a claim
 * about the work.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-pr-facts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('reading what gh printed', () => {
  it('takes the url and the state', () => {
    expect(prFactsFrom(JSON.stringify({ url: 'https://example.test/pr/7', state: 'OPEN', isDraft: false }))).toEqual({
      prUrl: 'https://example.test/pr/7',
      prState: 'open',
    });
  });

  it('tells a draft from an open one', () => {
    expect(prFactsFrom(JSON.stringify({ url: 'u', state: 'OPEN', isDraft: true })).prState).toBe('draft');
  });

  it('carries merged and closed through, which are the two that decide things', () => {
    // `judge` rejects on `closed`, and `blocksCleanup` accepts `merged` as
    // confirmation that a branch has landed somewhere.
    expect(prFactsFrom(JSON.stringify({ url: 'u', state: 'MERGED' })).prState).toBe('merged');
    expect(prFactsFrom(JSON.stringify({ url: 'u', state: 'CLOSED' })).prState).toBe('closed');
  });

  it('leaves a state it does not recognise absent rather than guessing', () => {
    // The four values `Evidence` allows are the ones `judge` and
    // `blocksCleanup` reason about; a fifth arriving as one of them would be a
    // decision made on a misunderstanding.
    expect(prFactsFrom(JSON.stringify({ url: 'u', state: 'LOCKED' })).prState).toBeUndefined();
    expect(prFactsFrom(JSON.stringify({ url: 'u', state: 7 })).prState).toBeUndefined();
    expect(prFactsFrom(JSON.stringify({ url: 'u' })).prState).toBeUndefined();
  });

  it('says nothing about anything that is not a pull request', () => {
    for (const bad of ['', 'not json', '[]', 'null', '"a string"', '{}']) {
      expect(prFactsFrom(bad), bad).toEqual({});
    }
  });
});

describe('asking for a branch nobody can answer about', () => {
  it('answers nothing rather than inventing a state', async () => {
    // No `gh` on this PATH, no repository at that path, no pull request: all
    // the same answer, and none of them is CLOSED. Saying otherwise would
    // reject work whose author simply had not opened one yet.
    expect(await pullRequestFor(dir, 'claudia/nothing-here')).toEqual({});
  });

  it('does not ask about a branch it was not given', async () => {
    expect(await pullRequestFor(dir, '')).toEqual({});
  });
});
