import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every event the server can send is handled by the client.
 *
 * This is a source-reading test, like `repo-integrity.test.ts` beside it, and
 * for the same reason: the property is about the shape of the repository
 * rather than the behaviour of one module, and the two files it compares are
 * in different workspaces with different type environments.
 *
 * It exists because seven cases were deleted from `web/src/store.ts` in one
 * commit — `session_upsert` and `session_removed` among them — while a mirror
 * reducer was split out of the same function to get under the size ceiling.
 * Everything type-checked, every test passed, and the board silently stopped
 * updating. A union member with nothing reading it is not a type error in any
 * language we are using here, so it has to be an assertion.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

/** The `type: '...'` of every member of the ServerEvent union. */
function serverEventTypes(): string[] {
  const source = read('shared', 'src', 'protocol.ts');
  const start = source.indexOf('export type ServerEvent =');
  expect(start).toBeGreaterThan(-1);
  // Up to the next top-level export, which is where this union ends.
  const end = source.indexOf('\nexport ', start + 1);
  const union = source.slice(start, end === -1 ? undefined : end);
  return [...union.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1] as string);
}

/** The `case '...'` labels of the store's event switch. */
function handledInStore(): Set<string> {
  return new Set([...read('web', 'src', 'store.ts').matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] as string));
}

/** The members of the mirror fold's own event set, which the switch never sees. */
function handledInMirror(): Set<string> {
  const source = read('web', 'src', 'mirror-state.ts');
  const start = source.indexOf('MIRROR_EVENTS = new Set');
  expect(start).toBeGreaterThan(-1);
  // From the array literal's own bracket, not the first `]` after the name:
  // the declaration is `new Set<ServerEvent['type']>([...])`, and the naive
  // slice stopped inside the type argument and came back holding `type`.
  const open = source.indexOf('([', start);
  const end = source.indexOf('])', open);
  expect(open).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(open);
  return new Set([...source.slice(open, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string));
}

/**
 * The events the client knowingly ignores, listed rather than tolerated.
 *
 * These five are the mission layer, which is complete on the server and on the
 * wire and has no UI at all: nothing in `web/src` can create a mission,
 * promote a task, or watch one run. That is a real gap and it is tracked as
 * one — the change that builds the fleet board deletes this list, and until
 * then the assertion below still fails for anything NOT on it.
 */
const NO_UI_YET = ['missions', 'tasks', 'fleet_events', 'fleet_event', 'fleet_unavailable'];

describe('nothing the server sends is dropped on the floor', () => {
  it('handles every member of the ServerEvent union', () => {
    const types = serverEventTypes();
    // A floor under the extraction. If the union's shape ever stops matching
    // these patterns this test would pass vacuously, which is worse than not
    // having it.
    expect(types.length).toBeGreaterThan(30);

    const store = handledInStore();
    const mirror = handledInMirror();
    // Non-vacuous, and specific: this fold owns the mirror events and nothing
    // else, so an extraction that came back with the wrong thing fails here
    // rather than quietly excusing an unhandled event below.
    expect(mirror.size).toBeGreaterThan(3);
    expect([...mirror].every((type) => type.startsWith('mirror_'))).toBe(true);

    expect(types.filter((type) => !store.has(type) && !mirror.has(type))).toEqual(NO_UI_YET);
  });

  it('names a gap that is still real', () => {
    // So the list above cannot outlive what it excuses: the moment the fleet
    // board handles one of these, this fails until it is taken off the list.
    const store = handledInStore();
    const mirror = handledInMirror();
    for (const type of NO_UI_YET) expect(store.has(type) || mirror.has(type)).toBe(false);
  });
});
