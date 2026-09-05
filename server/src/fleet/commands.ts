import type { ClientCommand, EscalationResolution, FleetEvent, ServerEvent } from '@claudia/shared';
import { DEFAULT_PAGE } from '../store/events.js';
import { planResync, replayIsUsable } from './resync.js';
import type { FleetStore } from '../store/index.js';

/**
 * The mission layer's half of the wire protocol.
 *
 * Separate from gateway.ts because that file is a router, not a domain: it
 * already carries every session, settings and orchestrator command, and it sits
 * one line under the repository's size ceiling. More to the point, everything
 * here needs a store that may not exist, and threading "or nothing" through the
 * router's other forty cases would spread one absence across all of them.
 *
 * Every handler answers with events rather than mutating the socket, so the
 * caller decides who hears what and this stays testable without a WebSocket.
 */

/** Commands this module owns. Anything else is not its business. */
const FLEET_COMMANDS = new Set([
  'create_mission',
  'list_missions',
  'set_mission_watch',
  'create_task',
  'list_tasks',
  'set_task_status',
  'get_fleet_events',
  'list_escalations',
  'resolve_escalation',
]);

export function isFleetCommand(cmd: ClientCommand): boolean {
  return FLEET_COMMANDS.has(cmd.type);
}

/**
 * Answers one mission command, or says why it cannot.
 *
 * `store` is optional on purpose. The database is allowed to be unavailable —
 * `startFleet` reports that as a value and the rest of the server runs — so the
 * commands that need it answer with one `fleet_unavailable` rather than each
 * inventing its own failure. A client learns the layer is down once, from a
 * message that says so, instead of inferring it from a run of refusals.
 */
export function handleFleetCommand(cmd: ClientCommand, store: FleetStore | undefined): ServerEvent[] {
  if (!store) {
    return [{ type: 'fleet_unavailable', reason: 'the mission database is not open in this session' }];
  }
  switch (cmd.type) {
    case 'create_mission': {
      const created = store.missions.create({
        name: cmd.name,
        body: cmd.body,
        cwd: cmd.cwd,
        ...(cmd.agent ? { agent: cmd.agent } : {}),
      });
      if (!created.ok) return [notice(created.message)];
      // The whole list, not just the new row: a client that has been away has
      // no reliable way to merge one insert into a list it may not hold.
      return listMissions(store);
    }
    case 'list_missions':
      return listMissions(store);
    case 'set_mission_watch': {
      const moved = store.missions.setWatch(cmd.missionId, cmd.watch);
      if (!moved.ok) return [notice(moved.message)];
      return listMissions(store);
    }
    case 'create_task': {
      const created = store.tasks.create({
        missionId: cmd.missionId,
        title: cmd.title,
        description: cmd.description,
        cwd: cmd.cwd,
        dependsOn: cmd.dependsOn,
      });
      if (!created.ok) return [notice(created.message)];
      return listTasks(store, cmd.missionId);
    }
    case 'set_task_status': {
      // The store owns which transitions are legal; this only asks for one, and
      // reports the refusal verbatim when the answer is no.
      const moved = store.tasks.setStatus(cmd.taskId, cmd.status);
      if (!moved.ok) return [notice(moved.message)];
      return listTasks(store, cmd.missionId);
    }
    case 'list_tasks':
      return listTasks(store, cmd.missionId);
    case 'get_fleet_events':
      return pageOfHistory(store, cmd.missionId, cmd.afterSeq ?? 0);
    case 'list_escalations':
      // Pending unless asked otherwise. The inbox is the point; the settled
      // ones are an audit trail somebody goes looking for.
      return listEscalations(store, cmd.missionId, cmd.resolution ?? 'pending');
    case 'resolve_escalation': {
      const answered = store.escalations.resolve(cmd.escalationId, cmd.resolution, cmd.note);
      // The store refuses `pending` and refuses re-resolving something already
      // settled, in its own words — overwriting a decision somebody made is
      // the one thing an audit trail cannot do. Passed through rather than
      // rephrased.
      if (!answered.ok) return [notice(answered.message)];
      // Recorded in the timeline too, so the log shows who answered and how,
      // beside the escalation it answers.
      const logged = store.events.append({
        missionId: cmd.missionId,
        ...(answered.value.taskId !== undefined ? { taskId: answered.value.taskId } : {}),
        actor: 'human',
        kind: `escalation_${cmd.resolution}`,
        payload: { request: answered.value.request, note: cmd.note ?? null },
      });
      if (!logged.ok) return [notice(logged.message)];
      return listEscalations(store, cmd.missionId, 'pending');
    }
    default:
      return [];
  }
}

function listMissions(store: FleetStore): ServerEvent[] {
  const missions = store.missions.list();
  return missions.ok ? [{ type: 'missions', missions: missions.value }] : [notice(missions.message)];
}

/**
 * One page of a mission's timeline, planned rather than guessed at.
 *
 * The version this replaces called `sinceForMission(id, afterSeq)` and sent
 * whatever came back. That reader defaults to 500 rows ORDERED ASCENDING, so a
 * client asking from zero against a 1,200-event log was handed events 1–500 —
 * the OLDEST page — and told nothing. The board kept the newest 200 of those
 * and rendered events 301–500 as the current state of a mission whose real
 * history ran to 1,200. Three defensible decisions composing into a lie.
 *
 * `resync.ts` was written to prevent exactly this and was imported by nothing;
 * its own comment describes the 700-event hole as "the exact silent gap the
 * whole resync design exists to prevent". So: `planResync` decides, `replay`
 * reads a window whose limit is DERIVED from that window rather than kept
 * equal to it by hand, and `replayIsUsable` checks what actually came back.
 *
 * A cursor of 0 is a client with nothing, and what a timeline wants then is
 * the NEWEST page, not the oldest — so that case is served from the end and
 * says how many it skipped. Everything else is a catch-up and goes through the
 * planner.
 */
function pageOfHistory(store: FleetStore, missionId: string, afterSeq: number): ServerEvent[] {
  const bounds = store.events.boundsForMission(missionId);
  if (!bounds.ok) return [notice(bounds.message)];
  const { oldestSeq, newestSeq } = bounds.value;
  if (newestSeq === 0) return [page(missionId, [], 0, false, 0)];

  if (afterSeq <= 0) return tail(store, missionId, newestSeq);

  const plan = planResync({ lastSeq: afterSeq }, { oldestSeq, newestSeq, maxBatch: DEFAULT_PAGE });
  if (plan.kind === 'up_to_date') return [page(missionId, [], 0, false, newestSeq)];
  // Not a failure path. The client's cursor cannot be replayed, so the honest
  // answer is the newest page plus an instruction to drop what it holds —
  // splicing this onto a history that never led to it is the silent-corruption
  // case the planner exists to refuse.
  if (plan.kind === 'snapshot') return tail(store, missionId, newestSeq, plan.reason);

  const events = store.events.replay({ fromSeq: plan.fromSeq, toSeq: plan.toSeq, missionId });
  if (!events.ok) return [notice(events.message)];
  // A FILTERED stream: this mission's sequences are sparse by construction, so
  // ordering and range are checkable and completeness is not.
  if (!replayIsUsable(events.value.map((e) => e.seq), plan.fromSeq, plan.toSeq, 'filtered')) {
    return tail(store, missionId, newestSeq, 'the log moved while it was being read');
  }
  // Through the WINDOW's end, not the last event in it. See `throughSeq`.
  return [page(missionId, events.value, 0, plan.more, plan.toSeq)];
}

/**
 * The newest page, for a client with no usable cursor.
 *
 * Read by the store in the MISSION's own event space rather than by a sequence
 * window ending at the newest. Found by a test written for the sparse case: a
 * mission holding seq 1–5 and 606–610, with another mission's 600 events
 * between, has a 500-wide window reaching back only to 111 — so the window
 * returned five of its ten events and reported none missing. A smaller copy of
 * the very bug this change is about.
 */
function tail(store: FleetStore, missionId: string, newestSeq: number, reset?: string): ServerEvent[] {
  const end = store.events.tailForMission(missionId);
  if (!end.ok) return [notice(end.message)];
  return [page(missionId, end.value.events, end.value.older, false, newestSeq, reset)];
}

function page(
  missionId: string,
  events: FleetEvent[],
  elided: number,
  more: boolean,
  throughSeq: number,
  reset?: string,
): ServerEvent {
  return {
    type: 'fleet_events',
    missionId,
    events,
    elided,
    more,
    throughSeq,
    ...(reset !== undefined ? { reset } : {}),
  };
}

function listEscalations(store: FleetStore, missionId: string, resolution: EscalationResolution): ServerEvent[] {
  const found = store.escalations.listByMission(missionId, resolution);
  return found.ok ? [{ type: 'escalations', missionId, escalations: found.value }] : [notice(found.message)];
}

function listTasks(store: FleetStore, missionId: string): ServerEvent[] {
  const tasks = store.tasks.listByMission(missionId);
  return tasks.ok ? [{ type: 'tasks', missionId, tasks: tasks.value }] : [notice(tasks.message)];
}

/**
 * A refusal the user can read, rather than a thrown error.
 *
 * The repositories already phrase their failures for a person — "A task that is
 * running cannot become ready" — so the honest thing is to pass that through.
 * Everything here is a command a human just issued; there is someone to tell.
 */
function notice(message: string): ServerEvent {
  return { type: 'notice', message };
}
