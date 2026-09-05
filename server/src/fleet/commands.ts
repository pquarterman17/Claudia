import type { ClientCommand, ServerEvent } from '@claudia/shared';
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
    case 'get_fleet_events': {
      const events = store.events.sinceForMission(cmd.missionId, cmd.afterSeq ?? 0);
      if (!events.ok) return [notice(events.message)];
      return [{ type: 'fleet_events', missionId: cmd.missionId, events: events.value }];
    }
    default:
      return [];
  }
}

function listMissions(store: FleetStore): ServerEvent[] {
  const missions = store.missions.list();
  return missions.ok ? [{ type: 'missions', missions: missions.value }] : [notice(missions.message)];
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
