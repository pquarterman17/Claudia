import { useState } from 'react';
import { verifyCommandProblem } from '@claudia/shared';
import { send } from '../store';

/**
 * The command that decides whether this mission's finished work is any good.
 *
 * Here rather than only on the create form because it is the field most likely
 * to be got right on the second attempt: a mission is described before anybody
 * knows what its checks are called, and a mission whose command is wrong
 * rejects good work until somebody can change it.
 *
 * The same refusal the store makes is made here as well, before sending. Not
 * because the client is trusted — the store is the one that counts — but
 * because "one program, no shell" is a surprising rule, and learning it from a
 * notice after the fact is worse than being told while typing.
 */
export function MissionVerify({ missionId, verify }: { missionId: string; verify: string | undefined }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(verify ?? '');
  const problem = draft.trim() === '' ? undefined : verifyCommandProblem(draft);

  if (!editing) {
    return (
      <p style={{ fontSize: 10.5, color: '#595d6c', margin: '4px 0' }}>
        {verify === undefined ? (
          <>
            No checks. Nothing runs against a finished child’s worktree, so every completion claim reaches you with no test results.{' '}
          </>
        ) : (
          <>
            Checked with <code style={{ color: '#8ab4ff' }}>{verify}</code>.{' '}
          </>
        )}
        <button
          onClick={() => {
            setDraft(verify ?? '');
            setEditing(true);
          }}
          className="btn btn-ghost"
          style={link}
        >
          {verify === undefined ? 'add a check' : 'change'}
        </button>
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' }}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="npm test"
        style={{
          flex: '1 1 200px',
          minWidth: 140,
          fontSize: 11.5,
          padding: '3px 7px',
          background: '#15172480',
          border: `1px solid ${problem ? '#5a3030' : '#2a2d40'}`,
          borderRadius: 5,
          color: '#c8cadb',
        }}
      />
      <button
        onClick={() => {
          send({ type: 'set_mission_verify', missionId, verify: draft });
          setEditing(false);
        }}
        disabled={problem !== undefined}
        className="btn btn-ghost"
        style={link}
        title="Runs in the child’s worktree once it reports, and decides the verdict."
      >
        {draft.trim() === '' ? 'clear' : 'save'}
      </button>
      <button onClick={() => setEditing(false)} className="btn btn-ghost" style={link}>
        cancel
      </button>
      {problem !== undefined && <span style={{ fontSize: 10, color: '#c08a8a', flexBasis: '100%' }}>{problem}</span>}
    </div>
  );
}

const link: React.CSSProperties = {
  fontSize: 10.5,
  padding: '1px 6px',
  color: '#75798c',
  border: '1px solid #33364a',
  borderRadius: 5,
  cursor: 'pointer',
};
