import { useState } from 'react';
import { HUMAN_RESOLUTIONS, type Escalation, type HumanResolution } from '@claudia/shared';
import { send } from '../store';

/**
 * The decisions a mission is waiting on.
 *
 * The watchdog files one of these when a run has been parked on a human rather
 * than working — a permission prompt the child cannot answer for itself — and
 * retrying would only spend a fresh turn to park on the same prompt. Until
 * this component existed those went into a table with no wire surface and no
 * note in the timeline, so a watched mission simply stopped moving and said
 * nothing about why.
 *
 * Answering here records the DECISION. It does not answer the child's prompt:
 * a fleet child is a session on the board like any other, and its approval
 * banner is where the tool call is actually allowed or refused. Saying so on
 * the panel matters more than it looks — a button that appears to unblock the
 * run and does not would be worse than no button.
 */
export function MissionEscalations({ missionId, escalations }: { missionId: string; escalations: Escalation[] | undefined }) {
  const pending = (escalations ?? []).filter((e) => e.resolution === 'pending');
  if (pending.length === 0) return null;
  return (
    <div style={{ margin: '0 0 10px', padding: '6px 8px', border: '1px solid #4a3f2a', borderRadius: 6, background: '#1a170f60' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#e0a34f', marginBottom: 6 }}>
        waiting on you — {pending.length}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {pending.map((escalation) => (
          <Row key={escalation.id} missionId={missionId} escalation={escalation} />
        ))}
      </ul>
      <p style={{ fontSize: 10, color: '#75798c', margin: '8px 0 0' }}>
        Answering records the decision. If the child is parked on a permission prompt, approve or deny it on that
        session’s own tile — that is where the tool call is actually allowed.
      </p>
    </div>
  );
}

function Row({ missionId, escalation }: { missionId: string; escalation: Escalation }) {
  const [note, setNote] = useState('');
  const answer = (resolution: HumanResolution): void =>
    send({
      type: 'resolve_escalation',
      missionId,
      escalationId: escalation.id,
      resolution,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });

  return (
    <li style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: SEVERITY[escalation.severity], minWidth: 52, textTransform: 'uppercase' }}>
          {escalation.severity}
        </span>
        <span style={{ fontSize: 12, color: '#c8cadb' }}>{escalation.request}</span>
        <span style={{ fontSize: 11, color: '#75798c', flex: 1, minWidth: 140 }}>{escalation.reason}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why (optional, kept with the decision)"
          style={{
            flex: '1 1 200px',
            minWidth: 140,
            fontSize: 11,
            padding: '2px 6px',
            background: '#15172480',
            border: '1px solid #2a2d40',
            borderRadius: 5,
            color: '#c8cadb',
          }}
        />
        {HUMAN_RESOLUTIONS.map((resolution) => (
          <button
            key={resolution}
            onClick={() => answer(resolution)}
            className="btn btn-ghost"
            style={{
              fontSize: 10,
              padding: '2px 9px',
              border: `1px solid ${resolution === 'denied' ? '#4a3038' : '#33364a'}`,
              borderRadius: 5,
              color: resolution === 'approved' ? '#7ee0a3' : resolution === 'denied' ? '#c08a8a' : '#a8abbd',
              cursor: 'pointer',
            }}
          >
            {resolution}
          </button>
        ))}
      </div>
    </li>
  );
}

const SEVERITY: Readonly<Record<Escalation['severity'], string>> = {
  info: '#75798c',
  warning: '#e0a34f',
  blocking: '#e07070',
};
