import type { FeedStep, ServerEvent, TranscriptItem } from '@claudia/shared';
import { isSafeKey } from './safe-key';

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

export type Mirrors = Record<string, MirrorView>;

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
  // Validated HERE, where the key is written, rather than relied upon from a
  // caller. A session id arrives over the socket, and `__proto__` as a key
  // reaches the prototype and poisons every object inheriting from it. The
  // store guards its own switch, but this function is exported and a guard
  // upstream of it proves nothing about anybody else calling it.
  const id = (event as { sessionId?: unknown }).sessionId;
  if (!isSafeKey(id)) return mirrors;

  switch (event.type) {
    case 'mirror_opened':
      return { ...mirrors, [id]: { feed: event.feed, transcript: event.transcript, elided: event.elided } };
    case 'mirror_unavailable':
      return { ...mirrors, [id]: { feed: [], transcript: [], elided: 0, reason: event.reason } };
    case 'mirror_step': {
      const open = mirrors[id];
      return open ? { ...mirrors, [id]: { ...open, feed: [...open.feed, event.step].slice(-CAP) } } : mirrors;
    }
    case 'mirror_item': {
      const open = mirrors[id];
      return open ? { ...mirrors, [id]: { ...open, transcript: [...open.transcript, event.item].slice(-CAP) } } : mirrors;
    }
    case 'mirror_patch': {
      const open = mirrors[id];
      if (!open) return mirrors;
      return {
        ...mirrors,
        [id]: {
          ...open,
          feed: open.feed.map((step) => (step.id === event.stepId ? { ...step, ...event.patch } : step)),
        },
      };
    }
    default:
      return undefined;
  }
}

/** The events this fold owns, named once so the guard above can run first. */
const MIRROR_EVENTS = new Set<ServerEvent['type']>([
  'mirror_opened',
  'mirror_unavailable',
  'mirror_step',
  'mirror_item',
  'mirror_patch',
]);
