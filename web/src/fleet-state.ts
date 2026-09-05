import type { Escalation, FleetEvent, Mission, ServerEvent, Task } from '@claudia/shared';

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
   * What the last page of history said about itself, by mission id.
   *
   * `elided` because a timeline that quietly begins in the middle is worse
   * than a short one: it reads as the whole history and is not. Named for the
   * same field on `mirror_opened`, which solved this for a transcript.
   *
   * `more` because a page that is not the end has to say so, or the client
   * stops one page short and believes it is caught up — which is the bug this
   * whole shape exists to close.
   *
   * `through` because the next page is asked for from the WINDOW's end, not
   * from the last event received. In a sparse log those differ, and a client
   * continuing from its last event advances one sequence per round trip.
   */
  pages: ReadonlyMap<string, { elided: number; more: boolean; through: number }>;
  /**
   * Decisions a mission is waiting on, by mission id.
   *
   * Pending ones, which is what an inbox is. The watchdog files one when a run
   * is parked on a human, and until this existed it filed them into a table
   * with nothing reading it — the mission simply stopped moving and said
   * nothing about why.
   */
  escalations: ReadonlyMap<string, Escalation[]>;
  /**
   * Set when the mission database would not open this run.
   *
   * The server says this once instead of refusing every command separately, so
   * the UI can say it once too rather than showing a string of failures that
   * each look like their own bug.
   */
  unavailable?: string;
}

export const NO_FLEET: FleetState = {
  missions: [],
  tasks: new Map(),
  events: new Map(),
  pages: new Map(),
  escalations: new Map(),
};

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
    case 'escalations':
      return { ...state, escalations: replace(state.escalations, event.missionId, event.escalations) };
    case 'fleet_events': {
      // `reset` means the client's cursor could not be replayed, so what it
      // holds never led to this page. Merging would splice one history onto
      // another and produce a timeline that looks continuous and is not.
      const before = event.reset === undefined ? known(state, event.missionId) : [];
      const union = unionOf(before, event.events);
      const kept = union.slice(-HISTORY);
      // How many events precede the OLDEST one now rendered — an absolute
      // count, carried forward, not a per-merge delta.
      //
      // Both halves were wrong before, and a review caught both. Counting only
      // this merge's losses made the number move BACKWARD: a tail of a
      // 1,200-event log keeps 200 with 1,000 before them, then 500 more arrive
      // and 1,500 precede the rendered tail — reported as 500, telling the
      // viewer the history had got shorter. And subtracting lengths counted an
      // event the client ALREADY HAD as one it lost: a live broadcast and the
      // page that also contains it collapse in the union, which is not an
      // omission. Evictions are counted off the deduplicated union.
      //
      // On a reset the prior count goes with the prior history: what the
      // client held never led here, so the number describing it cannot be
      // carried forward either.
      const prior = event.reset === undefined ? (state.pages.get(event.missionId)?.elided ?? 0) : 0;
      const dropped = prior + event.elided + (union.length - kept.length);
      return {
        ...state,
        events: replace(state.events, event.missionId, kept),
        pages: replace(state.pages, event.missionId, {
          elided: dropped,
          more: event.more,
          through: event.throughSeq,
        }),
      };
    }
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
  return unionOf(existing, incoming).slice(-HISTORY);
}

/**
 * The two sources as one ordered timeline, deduplicated and NOT yet capped.
 *
 * Split from the cap so the caller can see what the cap actually evicted. The
 * difference matters: `existing.length + incoming.length - kept.length` counts
 * every event that appeared in both as a loss, and an event the client already
 * had is not an event it lost.
 */
function unionOf(existing: readonly FleetEvent[], incoming: readonly FleetEvent[]): FleetEvent[] {
  const bySeq = new Map<number, FleetEvent>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The events this fold owns, named once so the guard above can run first. */
const FLEET_EVENTS = new Set<ServerEvent['type']>([
  'missions',
  'tasks',
  'escalations',
  'fleet_events',
  'fleet_event',
  'fleet_unavailable',
]);

/**
 * Where to ask for the next page, or nothing when the client is caught up.
 *
 * A function rather than a flag read at the call site, because the component
 * has to react to it and a boolean cannot express "again, from further on".
 * The sequence advances every round — the server guarantees it, and
 * `fleet-timeline-paging.test.ts` asserts it — so a component keyed on this
 * value re-fires each round and stops when it becomes `undefined`.
 *
 * Keyed on a BOOLEAN this stalled after one page: `more` stayed true from one
 * page to the next, React saw no change in the dependency, and the client
 * stopped a page short believing it was caught up. Which is the bug the whole
 * paging change exists to close, reproduced one layer up.
 */
export function nextPageFrom(fleet: FleetState, missionId: string): number | undefined {
  const page = fleet.pages.get(missionId);
  return page?.more === true ? page.through : undefined;
}
