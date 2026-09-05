import type { FleetEvent, Mission, ServerEvent, Task } from '@claudia/shared';

/**
 * What the client keeps for the mission layer.
 *
 * Folded here rather than in `store.ts`'s switch, for the reason
 * `mirror-state.ts` was: five events revise one shape and touch nothing else,
 * and the store's switch is already the file that grew past its ceiling once
 * and lost seven cases being split under that pressure. One delegation there
 * is one thing that cannot be accidentally deleted.
 *
 * Maps, not plain objects. Every key here is a mission id off the socket, and
 * writing a remote string as a property name is prototype pollution waiting to
 * happen — the same finding CodeQL raised five times against the mirror state.
 * A `Map` has no such surface, so the question stops being asked.
 */

export interface FleetState {
  missions: Mission[];
  /** Tasks by mission id, as far as they have been asked for. */
  tasks: ReadonlyMap<string, Task[]>;
  /** Recent history by mission id, oldest first. */
  events: ReadonlyMap<string, FleetEvent[]>;
  /**
   * Set when the mission database would not open this run.
   *
   * The server says this once instead of refusing every command separately, so
   * the UI can say it once too rather than showing a string of failures that
   * each look like their own bug.
   */
  unavailable?: string;
}

export const NO_FLEET: FleetState = { missions: [], tasks: new Map(), events: new Map() };

/** As much history as one mission's timeline shows. A log is not a payload. */
const HISTORY = 200;

/**
 * The next state, or `undefined` when the event is not this fold's business.
 *
 * `undefined` rather than the unchanged state, so the caller can tell "handled,
 * nothing changed" from "not mine" and fall through to its own switch.
 */
export function foldFleet(state: FleetState, event: ServerEvent): FleetState | undefined {
  if (!FLEET_EVENTS.has(event.type)) return undefined;
  switch (event.type) {
    case 'missions':
      // An answer from the layer is proof it is there. A mission list that
      // arrives while `unavailable` is set would otherwise render under a
      // banner saying the database is closed.
      return { ...state, missions: event.missions, unavailable: undefined };
    case 'tasks':
      return { ...state, tasks: replace(state.tasks, event.missionId, event.tasks) };
    case 'fleet_events':
      return { ...state, events: replace(state.events, event.missionId, merge(known(state, event.missionId), event.events)) };
    case 'fleet_event':
      return { ...state, events: replace(state.events, event.event.missionId, merge(known(state, event.event.missionId), [event.event])) };
    case 'fleet_unavailable':
      return { ...state, unavailable: event.reason };
  }
  return undefined;
}

function known(state: FleetState, missionId: string): readonly FleetEvent[] {
  return state.events.get(missionId) ?? [];
}

function replace<T>(map: ReadonlyMap<string, T>, key: string, value: T): ReadonlyMap<string, T> {
  return new Map(map).set(key, value);
}

/**
 * One log, from a page of history and a stream of live appends.
 *
 * Both arrive: `get_fleet_events` answers with a page, and every commit
 * broadcasts its event. They overlap by design — a page requested at the same
 * moment an event lands contains it — and they can interleave, because the
 * request is a round trip and the broadcast is not. Deduplicating on `seq` and
 * sorting by it is what makes the two sources one timeline instead of a
 * timeline with repeats in it.
 */
function merge(existing: readonly FleetEvent[], incoming: readonly FleetEvent[]): FleetEvent[] {
  const bySeq = new Map<number, FleetEvent>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-HISTORY);
}

/** The events this fold owns, named once so the guard above can run first. */
const FLEET_EVENTS = new Set<ServerEvent['type']>([
  'missions',
  'tasks',
  'fleet_events',
  'fleet_event',
  'fleet_unavailable',
]);
