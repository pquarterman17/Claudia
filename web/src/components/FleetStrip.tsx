import { useEffect, useState } from 'react';
import { AGENT_KINDS, type AgentKind, type Mission } from '@claudia/shared';
import type { FleetLimits } from '@claudia/shared';
import type { FleetState } from '../fleet-state';
import { send } from '../store';
import { FleetLimitsControl } from './FleetLimits';
import { MissionEscalations } from './MissionEscalations';
import { MissionTasks } from './MissionTasks';

/**
 * The mission layer, finally reachable.
 *
 * Everything below this line has existed on the server since the pulse landed
 * — missions, tasks, reservations, a watchdog, real children in real worktrees
 * — and none of it could be driven from the board. The end-to-end proof of the
 * launcher had to be run from a hand-written WebSocket script, which is the
 * clearest possible statement that the capability was not shipped.
 *
 * Below the board with the other strips, not in the grid. A mission is not a
 * session: it has no transcript to read, no approval to answer and no prompt
 * to send, and putting it in the same grid as a live tile would invite all
 * three.
 *
 * Watching is OFF for a new mission, and that is the safety property this
 * surface is built around. A mission that is `paused` is described but not
 * acted on; nothing is dispatched, nothing is spent. Two separate decisions
 * stand between typing a task and paying for it: promoting the task to `ready`
 * and setting the mission to `watching`.
 */
/**
 * The sequence this client is caught up TO, which the server told it.
 *
 * Not the last event it holds. Those differ whenever the page's window was
 * sparse, and continuing from the last event would re-walk a gap the server
 * has already said is empty — one sequence per round trip.
 */
function caughtUpTo(fleet: FleetState, missionId: string): number {
  return fleet.pages.get(missionId)?.through ?? 0;
}

export function FleetStrip({ fleet, connected, limits }: { fleet: FleetState; connected: boolean; limits: FleetLimits }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  // Missions are not in `hello`. They are durable rows rather than live
  // process state, so the server does not push them at anybody who connects —
  // the client that wants them asks, and this is that client.
  useEffect(() => {
    if (connected) send({ type: 'list_missions' });
  }, [connected]);

  // The pulse writes rows and broadcasts its events; it does not re-send the
  // task list, because most clients are not looking at that mission. So the
  // one that IS re-reads when the log moves. Keyed on the latest sequence
  // number, which is exactly "something happened here" and nothing else.
  const latest = open === undefined ? undefined : fleet.events.get(open)?.at(-1)?.seq;
  useEffect(() => {
    if (open === undefined || latest === undefined) return;
    send({ type: 'list_tasks', missionId: open });
    // And the inbox with them: the watchdog files an escalation and notes it
    // in the log, so the log moving is exactly the signal that one may be
    // waiting.
    send({ type: 'list_escalations', missionId: open });
  }, [open, latest]);

  // A page that said it was not the end. Asked for from the last sequence
  // rendered, so every round strictly advances and the loop ends when the
  // server stops saying `more` — the client can no longer stop a page short
  // and believe it is caught up.
  const more = open === undefined ? false : (fleet.pages.get(open)?.more ?? false);
  useEffect(() => {
    if (open !== undefined && more) send({ type: 'get_fleet_events', missionId: open, afterSeq: caughtUpTo(fleet, open) });
    // `fleet` is deliberately not a dependency: this fires on the flag, and the
    // reply that lands clears it. Depending on the whole snapshot would re-ask
    // on every unrelated mission update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, more]);

  const expand = (mission: Mission): void => {
    const next = open === mission.id ? undefined : mission.id;
    setOpen(next);
    // Asked for on expand, not held for every mission: a fleet of twenty
    // missions is twenty task lists and twenty logs nobody is looking at.
    if (next !== undefined) {
      send({ type: 'list_tasks', missionId: mission.id });
      send({ type: 'list_escalations', missionId: mission.id });
      // From what this client has already rendered, not from zero. A cursor of
      // zero asks for a fresh tail every time, which re-sends a page the board
      // is already holding; a real cursor asks only for the gap.
      send({ type: 'get_fleet_events', missionId: mission.id, afterSeq: caughtUpTo(fleet, mission.id) });
    }
  };

  return (
    <section style={{ flex: 'none', padding: '8px 16px 12px', borderTop: '1px solid #23263a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span className="kicker">Fleet</span>
        {fleet.missions.length > 0 && (
          <span style={{ fontSize: 10.5, color: '#595d6c' }}>{fleet.missions.length}</span>
        )}
        <span style={{ flex: 1 }} />
        {fleet.unavailable === undefined && <FleetLimitsControl limits={limits} />}
        {fleet.unavailable === undefined && (
          <button onClick={() => setCreating((v) => !v)} className="btn btn-ghost" style={ghost}>
            {creating ? 'cancel' : 'new mission'}
          </button>
        )}
      </div>

      {fleet.unavailable !== undefined ? (
        <p style={{ fontSize: 11, color: '#c08a8a', margin: 0 }}>
          The mission database is not open this run — {fleet.unavailable}. Sessions are unaffected; only missions
          are.
        </p>
      ) : (
        <>
          {creating && <NewMission onDone={() => setCreating(false)} />}
          {fleet.missions.length === 0 && !creating && (
            <p style={{ fontSize: 11, color: '#595d6c', margin: 0 }}>
              No missions. A mission is a standing intention with tasks under it — Claudia works it unattended,
              in its own worktrees, once you set it watching.
            </p>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            {fleet.missions.map((mission) => (
              <div key={mission.id}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => expand(mission)} className="btn btn-ghost" style={disclosure}>
                    {open === mission.id ? '▾' : '▸'}
                  </button>
                  <span style={{ fontSize: 12.5, color: '#c8cadb' }}>{mission.name}</span>
                  <span style={{ fontSize: 10.5, color: '#4a4d5e', fontFamily: 'ui-monospace, monospace' }}>
                    {mission.cwd}
                  </span>
                  <span style={{ fontSize: 10, color: '#595d6c' }}>
                    {mission.agent} · up to {mission.maxChildren}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    onClick={() =>
                      send({
                        type: 'set_mission_watch',
                        missionId: mission.id,
                        watch: mission.watch === 'watching' ? 'paused' : 'watching',
                      })
                    }
                    title={
                      mission.watch === 'watching'
                        ? 'Stop deciding on this mission’s behalf. Children already running are not stopped.'
                        : 'Start deciding on this mission’s behalf. Ready tasks will be dispatched to real children, which costs tokens.'
                    }
                    className="btn btn-ghost"
                    style={{
                      ...ghost,
                      color: mission.watch === 'watching' ? '#7ee0a3' : '#75798c',
                      border: `1px solid ${mission.watch === 'watching' ? '#2f5a44' : '#33364a'}`,
                    }}
                  >
                    {mission.watch === 'watching' ? 'watching — pause' : 'paused — start watching'}
                  </button>
                </div>
                {open === mission.id && (
                  <div style={{ paddingLeft: 16 }}>
                    <MissionEscalations missionId={mission.id} escalations={fleet.escalations.get(mission.id)} />
                  </div>
                )}
                {open === mission.id && (
                  <MissionTasks
                    missionId={mission.id}
                    cwd={mission.cwd}
                    tasks={fleet.tasks.get(mission.id)}
                    events={fleet.events.get(mission.id)}
                    elided={fleet.pages.get(mission.id)?.elided ?? 0}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Name, repository and harness. Everything else has a default worth keeping. */
function NewMission({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [cwd, setCwd] = useState('');
  const [agent, setAgent] = useState<AgentKind>('claude');

  const create = (): void => {
    const trimmed = name.trim();
    const dir = cwd.trim();
    if (trimmed === '' || dir === '') return;
    send({ type: 'create_mission', name: trimmed, body: body.trim(), cwd: dir, agent });
    onDone();
  };

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mission name" style={field(160)} />
      <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Repository path" style={field(200)} />
      <input
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="The standing intention, in your words"
        style={field(240)}
      />
      <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)} style={field(80)}>
        {AGENT_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </select>
      <button
        onClick={create}
        disabled={name.trim() === '' || cwd.trim() === ''}
        className="btn btn-ghost"
        style={ghost}
      >
        create — paused
      </button>
    </div>
  );
}

const ghost: React.CSSProperties = {
  fontSize: 10.5,
  padding: '2px 8px',
  color: '#75798c',
  border: '1px solid #33364a',
  borderRadius: 6,
  cursor: 'pointer',
};

const disclosure: React.CSSProperties = {
  fontSize: 10,
  padding: '0 4px',
  color: '#595d6c',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
};

const field = (width: number): React.CSSProperties => ({
  flex: `1 1 ${width}px`,
  minWidth: 120,
  fontSize: 11.5,
  padding: '3px 7px',
  background: '#15172480',
  border: '1px solid #2a2d40',
  borderRadius: 5,
  color: '#c8cadb',
});
