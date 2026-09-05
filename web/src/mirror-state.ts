import type { FeedStep, ServerEvent, TranscriptItem } from '@claudia/shared';

/**
 * What the client keeps for sessions it is only WATCHING.
 *
 * Held apart from the owned-session feeds and transcripts rather than merged
 * into them. Merging would be less code and the wrong shape: a mirrored session
 * cannot be prompted, approved or interrupted, and a component reading one map
 * for both would eventually offer a control that does nothing. Splitting it
 * here also keeps `store.ts` under the size ceiling, which is what forced the
 * question.
 */

export interface MirrorView {
  feed: FeedStep[];
  transcript: TranscriptItem[];
  /** Steps dropped off the front of the backlog, so a partial read says so. */
  elided: number;
  /** Set when there is nothing to read, and why. */
  reason?: string;
}

/**
 * A MAP, not a plain object.
 *
 * Every key here is a session id that arrived over the socket, and writing a
 * remote string as a property name is prototype pollution waiting to happen —
 * CodeQL flagged five instances of exactly that. The first fix filtered the id
 * against a denylist, which is the weaker answer twice over: a denylist is a
 * guess about which names are dangerous, and it leaves the write on a structure
 * that has a prototype to poison at all. A `Map` has no such surface, so the
 * question stops being asked. Replaced rather than mutated, so
 * `useSyncExternalStore` still sees a new snapshot.
 */
export type Mirrors = ReadonlyMap<string, MirrorView>;

/** Matches the cap owned sessions use, for the same reason: a transcript grows. */
const CAP = 500;

/**
 * Folds one mirror event in, or answers `undefined` when it is not one.
 *
 * Every case but `mirror_opened` requires the session to be open already. An
 * event for a mirror that was closed between the server reading and the client
 * receiving is not an error — it is the race that closing always has — and
 * re-creating the entry from a fragment would show a conversation starting in
 * the middle.
 */
export function foldMirror(mirrors: Mirrors, event: ServerEvent): Mirrors | undefined {
  if (!MIRROR_EVENTS.has(event.type)) return undefined;
  const id = (event as { sessionId?: unknown }).sessionId;
  if (typeof id !== 'string' || id === '') return mirrors;

  switch (event.type) {
    case 'mirror_opened':
      return withEntry(mirrors, id, { feed: event.feed, transcript: event.transcript, elided: event.elided });
    case 'mirror_unavailable':
      return withEntry(mirrors, id, { feed: [], transcript: [], elided: 0, reason: event.reason });
    case 'mirror_step': {
      const open = mirrors.get(id);
      return open ? withEntry(mirrors, id, { ...open, feed: [...open.feed, event.step].slice(-CAP) }) : mirrors;
    }
    case 'mirror_item': {
      const open = mirrors.get(id);
      return open
        ? withEntry(mirrors, id, { ...open, transcript: [...open.transcript, event.item].slice(-CAP) })
        : mirrors;
    }
    case 'mirror_patch': {
      const open = mirrors.get(id);
      if (!open) return mirrors;
      return withEntry(mirrors, id, {
        ...open,
        feed: open.feed.map((step) => (step.id === event.stepId ? { ...step, ...event.patch } : step)),
      });
    }
    default:
      return undefined;
  }
}

/** A new map with one entry replaced; the old one is never mutated. */
function withEntry(mirrors: Mirrors, id: string, view: MirrorView): Mirrors {
  return new Map(mirrors).set(id, view);
}

/**
 * The events this fold owns, named once so the guard above can run first.
 *
 * `server/test/client-events.test.ts` reads this list out of the source and
 * checks it against the store's switch, because between them these two are the
 * whole of the client's event handling and a member with nothing reading it is
 * not a type error.
 */
const MIRROR_EVENTS = new Set<ServerEvent['type']>([
  'mirror_opened',
  'mirror_unavailable',
  'mirror_step',
  'mirror_item',
  'mirror_patch',
]);
