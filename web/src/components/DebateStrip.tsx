import type { DebateStatus, DebateSubject, SessionSummary } from '@claudia/shared';
import { useState } from 'react';
import { agentKindLabel } from '../agent-kinds';
import { send } from '../store';
import { COLORS } from '../status';

/**
 * Hand one problem to both agents and read what survives.
 *
 * The point of this surface is that you do not watch it. You start it, go and
 * do something else, and come back to a verdict — so what it shows while
 * running is progress (which turn, who is speaking) and what it shows at the
 * end is the four-line summary, not the whole argument. The full exchange is
 * in the two tiles it drove, which are ordinary sessions.
 */

const SUBJECTS: Array<{ key: DebateSubject; label: string; hint: string }> = [
  { key: 'diff', label: 'the diff', hint: "Both agents read this directory's uncommitted changes" },
  { key: 'plan', label: 'a question', hint: 'Nothing written yet — they answer, then argue about the answer' },
  { key: 'last', label: 'the last reply', hint: 'Critiques whatever the chosen session just said' },
];

const STATE_COLOR: Record<DebateStatus['state'], string> = {
  running: COLORS.accent,
  done: COLORS.ok,
  failed: COLORS.err,
};

export function DebateStrip({ debates, sessions }: { debates: DebateStatus[]; sessions: SessionSummary[] }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState<DebateSubject>('diff');
  const [objective, setObjective] = useState('');
  const [authorId, setAuthorId] = useState('');
  // Only an idle session can take part. A stopped one never answers, and a
  // working one answers the question it was already busy with — which the
  // exchange would read as the reply it asked for. The server refuses these
  // too; offering them here would only be a slower way to be told no.
  const eligible = sessions.filter((s) => s.state === 'idle');
  const author = eligible.find((s) => s.id === authorId) ?? eligible[0];
  const canStart = Boolean(author && objective.trim());

  const start = () => {
    if (!author || !objective.trim()) return;
    const authorAgent = author.agent ?? 'claude';
    send({
      type: 'start_debate',
      cwd: author.cwd,
      objective: objective.trim(),
      subject,
      authorSessionId: author.id,
      author: authorAgent,
      // The other agent, because a model reviewing itself agrees with itself.
      reviewer: authorAgent === 'claude' ? 'codex' : 'claude',
      rounds: 2,
    });
    setObjective('');
    setOpen(false);
  };

  return (
    <section style={{ flex: 'none', padding: '8px 16px 12px', borderTop: '1px solid #23263a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="kicker">Argue it out</span>
        {debates.length > 0 && <span style={{ fontSize: 10.5, color: '#595d6c' }}>{debates.length}</span>}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setOpen(!open)}
          disabled={eligible.length === 0}
          title={
            sessions.length === 0
              ? 'Launch a session first — the exchange runs in its directory'
              : eligible.length === 0
                ? 'Every session is busy or stopped; an exchange needs an idle one'
                : 'Hand this problem to both agents and let them settle it'
          }
          className="btn btn-ghost"
          style={{
            fontSize: 10.5,
            padding: '2px 8px',
            borderRadius: 6,
            border: '1px solid #33364a',
            color: eligible.length === 0 ? '#4f5364' : '#9397ab',
            cursor: eligible.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {open ? 'cancel' : 'new exchange'}
        </button>
      </div>

      {open && author && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          <input
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What are they arguing about? e.g. does this retry actually fix transient failures"
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
            {SUBJECTS.map((s) => (
              <button
                key={s.key}
                title={s.hint}
                onClick={() => setSubject(s.key)}
                style={{
                  cursor: 'pointer',
                  fontSize: 10.5,
                  padding: '2px 7px',
                  borderRadius: 6,
                  border: `1px solid ${subject === s.key ? '#423a6a' : '#33364a'}`,
                  background: subject === s.key ? '#2b2741' : 'transparent',
                  color: subject === s.key ? '#d2cefd' : '#75798c',
                }}
              >
                {s.label}
              </button>
            ))}
            <select
              value={author.id}
              onChange={(e) => setAuthorId(e.target.value)}
              title="Whose work is under discussion; the other agent reviews it"
              style={{ background: '#12141d', border: '1px solid #33364a', borderRadius: 6, color: '#9397ab', fontSize: 10.5, padding: '2px 4px' }}
            >
              {eligible.map((s) => (
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
              Start — 2 rounds
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#595d6c' }}>
            Spends turns on both agents while you are away. It stops early if the reviewer has no
            objections, and never runs more than 4 rounds.
          </div>
        </div>
      )}

      {debates.length === 0 ? (
        <div style={{ fontSize: 11, color: '#595d6c' }}>
          Nothing yet. An exchange hands one problem to Claude and Codex, relays the critique back,
          and ends with a verdict — so you are not the one carrying messages between them.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {debates.map((d) => (
            <DebateRow key={d.id} debate={d} />
          ))}
        </div>
      )}
    </section>
  );
}

function DebateRow({ debate }: { debate: DebateStatus }) {
  const last = debate.entries[debate.entries.length - 1];
  return (
    <div style={{ border: '1px solid #23263a', borderRadius: 8, padding: '7px 9px', background: '#161822' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: '#cfd3e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {debate.objective}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ flex: 'none', fontSize: 10, color: STATE_COLOR[debate.state] }}>
          {debate.state === 'running' ? `round ${last?.round ?? 1}…` : debate.state}
        </span>
      </div>

      {/* Blocked is louder than progress: it is the one state that needs a human. */}
      {debate.blockedBy && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: COLORS.warn }}>⚠ {debate.blockedBy}</div>
      )}

      {debate.state === 'running' && last && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: '#75798c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agentKindLabel(last.speaker)} · {last.role}
        </div>
      )}

      {debate.verdict && (
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
          {debate.verdict}
        </pre>
      )}

      {debate.error && <div style={{ marginTop: 4, fontSize: 10.5, color: COLORS.err }}>{debate.error}</div>}
      {debate.stoppedBecause && !debate.verdict && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#595d6c' }}>{debate.stoppedBecause}</div>
      )}
    </div>
  );
}
