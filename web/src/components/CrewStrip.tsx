import type { AgentKind, CrewMemberStatus, CrewStatus, SessionSummary } from '@claudia/shared';
import { useState } from 'react';
import { agentKindLabel } from '../agent-kinds';
import { send } from '../store';
import { COLORS } from '../status';

/**
 * Give one objective to several agents at once and come back to a report.
 *
 * Like the exchange panel above it, this is a surface you do not watch. What
 * it shows while running is which pieces exist and who has which; what it
 * shows at the end is the planner's four-line report. The work itself is on
 * branches, and the branch name is the most important thing on each row —
 * without it a finished run is a paragraph about changes the human cannot find.
 */

const AGENT_MIXES: Array<{ key: string; label: string; workers: AgentKind[]; hint: string }> = [
  { key: 'mixed', label: 'both', workers: ['claude', 'codex'], hint: 'Pieces alternate between Claude and Codex' },
  { key: 'claude', label: 'Claude', workers: ['claude'], hint: 'Every piece goes to Claude' },
  { key: 'codex', label: 'Codex', workers: ['codex'], hint: 'Every piece goes to Codex' },
];

const STATE_COLOR: Record<CrewStatus['state'], string> = {
  planning: COLORS.accent,
  running: COLORS.accent,
  done: COLORS.ok,
  failed: COLORS.err,
};

const MEMBER_COLOR: Record<CrewMemberStatus['state'], string> = {
  planned: '#595d6c',
  running: COLORS.accent,
  done: COLORS.ok,
  failed: COLORS.err,
};

export function CrewStrip({ crews, sessions }: { crews: CrewStatus[]; sessions: SessionSummary[] }) {
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState('');
  const [mix, setMix] = useState('mixed');
  const [pieces, setPieces] = useState(3);
  const [cwdId, setCwdId] = useState('');
  const source = sessions.find((s) => s.id === cwdId) ?? sessions[0];
  const canStart = Boolean(source && objective.trim());

  const start = () => {
    if (!source || !objective.trim()) return;
    const chosen = AGENT_MIXES.find((m) => m.key === mix) ?? AGENT_MIXES[0]!;
    send({
      type: 'start_crew',
      cwd: source.cwd,
      objective: objective.trim(),
      // The planner is whichever agent this tile runs: it is the one whose
      // view of the repository the human has been reading.
      planner: source.agent ?? 'claude',
      workers: chosen.workers,
      maxTasks: pieces,
    });
    setObjective('');
    setOpen(false);
  };

  return (
    <section style={{ flex: 'none', padding: '8px 16px 12px', borderTop: '1px solid #23263a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="kicker">Split the work</span>
        {crews.length > 0 && <span style={{ fontSize: 10.5, color: '#595d6c' }}>{crews.length}</span>}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setOpen(!open)}
          disabled={sessions.length === 0}
          title={
            sessions.length === 0
              ? 'Launch a session first — the run needs a repository to split up'
              : 'One objective, split into pieces, worked at the same time'
          }
          className="btn btn-ghost"
          style={{
            fontSize: 10.5,
            padding: '2px 8px',
            borderRadius: 6,
            border: '1px solid #33364a',
            color: sessions.length === 0 ? '#4f5364' : '#9397ab',
            cursor: sessions.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {open ? 'cancel' : 'new run'}
        </button>
      </div>

      {open && source && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          <input
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What is the whole job? e.g. add rate limiting, retries and a health endpoint to the API"
            style={{
              background: '#12141d',
              border: '1px solid #33364a',
              borderRadius: 6,
              padding: '6px 8px',
              color: '#cfd3e5',
              fontSize: 11.5,
            }}
          />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {AGENT_MIXES.map((m) => (
              <button
                key={m.key}
                title={m.hint}
                onClick={() => setMix(m.key)}
                style={{
                  cursor: 'pointer',
                  fontSize: 10.5,
                  padding: '2px 7px',
                  borderRadius: 6,
                  border: `1px solid ${mix === m.key ? '#423a6a' : '#33364a'}`,
                  background: mix === m.key ? '#2b2741' : 'transparent',
                  color: mix === m.key ? '#d2cefd' : '#75798c',
                }}
              >
                {m.label}
              </button>
            ))}
            <select
              value={pieces}
              onChange={(e) => setPieces(Number(e.target.value))}
              title="The most pieces it may split into. It is allowed to use fewer."
              style={selectStyle}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  up to {n} {n === 1 ? 'piece' : 'pieces'}
                </option>
              ))}
            </select>
            <select
              value={source.id}
              onChange={(e) => setCwdId(e.target.value)}
              title="Which repository is being worked on"
              style={selectStyle}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title ?? s.name} · {agentKindLabel(s.agent)}
                </option>
              ))}
            </select>
            <span style={{ flex: 1 }} />
            <button
              onClick={start}
              disabled={!canStart}
              style={{
                cursor: canStart ? 'pointer' : 'not-allowed',
                fontSize: 10.5,
                padding: '3px 10px',
                borderRadius: 6,
                border: '1px solid #796cbf',
                background: canStart ? '#2b2741' : 'transparent',
                color: canStart ? '#d2cefd' : '#4f5364',
              }}
            >
              Start
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#595d6c' }}>
            Each piece gets its own branch and its own checkout, so they cannot overwrite each other
            or the files in front of you. Nothing is committed — you review the branches afterwards.
          </div>
        </div>
      )}

      {crews.length === 0 ? (
        <div style={{ fontSize: 11, color: '#595d6c' }}>
          Nothing yet. One agent splits the objective, the pieces are worked at the same time in
          separate branches, and you get one report — instead of holding four half-done threads.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {crews.map((c) => (
            <CrewRow key={c.id} crew={c} />
          ))}
        </div>
      )}
    </section>
  );
}

const selectStyle = {
  background: '#12141d',
  border: '1px solid #33364a',
  borderRadius: 6,
  color: '#9397ab',
  fontSize: 10.5,
  padding: '2px 4px',
} as const;

function CrewRow({ crew }: { crew: CrewStatus }) {
  const done = crew.members.filter((m) => m.state === 'done' || m.state === 'failed').length;
  return (
    <div style={{ border: '1px solid #23263a', borderRadius: 8, padding: '7px 9px', background: '#161822' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: '#cfd3e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {crew.objective}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ flex: 'none', fontSize: 10, color: STATE_COLOR[crew.state] }}>
          {crew.state === 'planning'
            ? 'splitting…'
            : crew.state === 'running'
              ? `${done}/${crew.members.length} done`
              : crew.state}
        </span>
      </div>

      {/* Blocked is louder than progress: it is the one state that needs a human. */}
      {crew.blockedBy && <div style={{ marginTop: 4, fontSize: 10.5, color: COLORS.warn }}>⚠ {crew.blockedBy}</div>}

      {crew.members.length > 0 && (
        <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {crew.members.map((m, i) => (
            <div key={`${m.title}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 10.5 }}>
              <span style={{ flex: 'none', color: MEMBER_COLOR[m.state] }}>●</span>
              <span style={{ flex: 'none', color: '#75798c' }}>{agentKindLabel(m.agent)}</span>
              <span style={{ color: '#a4a8b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.title}
              </span>
              <span style={{ flex: 1 }} />
              {/* The branch is where the work actually is; without it the run is unfindable. */}
              {m.branch && (
                <code style={{ flex: 'none', color: '#595d6c', fontSize: 10 }}>{m.branch}</code>
              )}
            </div>
          ))}
        </div>
      )}

      {crew.report && (
        <pre
          style={{
            margin: '6px 0 0',
            fontSize: 10.5,
            lineHeight: 1.5,
            color: '#a4a8b8',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-body)',
          }}
        >
          {crew.report}
        </pre>
      )}

      {crew.error && <div style={{ marginTop: 4, fontSize: 10.5, color: COLORS.err }}>{crew.error}</div>}
      {crew.stoppedBecause && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#595d6c' }}>{crew.stoppedBecause}</div>
      )}
    </div>
  );
}
