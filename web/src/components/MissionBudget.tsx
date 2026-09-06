import { useState } from 'react';
import type { Mission } from '@claudia/shared';
import { send } from '../store';

/** What the server measured, or nothing if this mission has not been read. */
export interface Spend {
  elapsedSec: number;
  tokens: number | null;
}

/**
 * The ceilings a mission may spend against.
 *
 * Persisted since the first fleet PR, enforced by `overBudget` since the pulse
 * measured spend, and settable by nothing: `budgetSec` and `budgetTokens`
 * appeared nowhere in this app, so the only way to give a mission a budget was
 * to edit the database by hand. A limit that cannot be set is the other half
 * of a limit that enforces nothing — the same bug wearing the opposite face.
 *
 * Blank means no budget, and clearing one is as important as setting it: a
 * mission that has hit a ceiling stops dispatching, and the person who has
 * decided to let it carry on needs a way to say so.
 */
export function MissionBudget({ mission, spend }: { mission: Mission; spend: Spend | undefined }) {
  const [editing, setEditing] = useState(false);
  const [seconds, setSeconds] = useState('');
  const [tokens, setTokens] = useState('');

  const open = (): void => {
    setSeconds(mission.budgetSec === undefined ? '' : String(mission.budgetSec));
    setTokens(mission.budgetTokens === undefined ? '' : String(mission.budgetTokens));
    setEditing(true);
  };

  const parsed = (text: string): number | null | undefined => {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    // `undefined` is this component's "not a number I can send" — the store
    // refuses the same shapes, and being told before the click is kinder.
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };

  const budgetSec = parsed(seconds);
  const budgetTokens = parsed(tokens);
  const wrong = budgetSec === undefined || budgetTokens === undefined;

  if (!editing) {
    return (
      <p style={{ fontSize: 10.5, color: '#595d6c', margin: '4px 0' }}>
        {describe(mission, spend)}{' '}
        <button onClick={open} className="btn btn-ghost" style={link}>
          {mission.budgetSec === undefined && mission.budgetTokens === undefined ? 'set a budget' : 'change'}
        </button>
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' }}>
      <input
        value={seconds}
        onChange={(e) => setSeconds(e.target.value)}
        placeholder="seconds — blank for none"
        style={field(budgetSec === undefined)}
      />
      <input
        value={tokens}
        onChange={(e) => setTokens(e.target.value)}
        placeholder="tokens — blank for none"
        style={field(budgetTokens === undefined)}
      />
      <button
        onClick={() => {
          if (wrong) return;
          send({ type: 'set_mission_budget', missionId: mission.id, budgetSec, budgetTokens });
          setEditing(false);
        }}
        disabled={wrong}
        className="btn btn-ghost"
        style={link}
        title="Wall clock from the mission’s first run, and tokens summed across every attempt it has made."
      >
        save
      </button>
      <button onClick={() => setEditing(false)} className="btn btn-ghost" style={link}>
        cancel
      </button>
      {wrong && (
        <span style={{ fontSize: 10, color: '#c08a8a', flexBasis: '100%' }}>
          A budget is a whole number above zero, or blank for none.
        </span>
      )}
    </div>
  );
}

/**
 * What it has spent, and what it is spending against.
 *
 * The seconds are wall clock from the mission's first run — not the sum of its
 * children's runtimes, which is a different and also useful bound but not what
 * the field promises.
 *
 * A budget with no spend beside it is a number nobody can act on: the question
 * anyone actually has is not "what is the limit" but "how close is it". And a
 * spend nothing could measure says so in words, because that is the state in
 * which the fleet refuses to dispatch — it would otherwise be unreadable from
 * a limit alone, on the one screen where somebody decides whether to raise it.
 */
function describe(mission: Mission, spend: Spend | undefined): string {
  const parts: string[] = [];
  if (mission.budgetSec !== undefined) {
    const used = spend === undefined ? '' : `${Math.floor(spend.elapsedSec)}s of `;
    parts.push(`${used}${mission.budgetSec}s`);
  }
  if (mission.budgetTokens !== undefined) {
    const used = spend === undefined || spend.tokens === null ? '' : `${spend.tokens.toLocaleString()} of `;
    parts.push(`${used}${mission.budgetTokens.toLocaleString()} tokens`);
  }
  if (parts.length > 0) {
    const unmeasured =
      mission.budgetTokens !== undefined && spend?.tokens === null ? ' Nothing can measure what it has spent.' : '';
    return `Spending ${parts.join(' and ')}.${unmeasured}`;
  }

  // No budget: what it has spent is still worth knowing, and this is the only
  // place the board says so at all.
  if (spend === undefined) return 'No budget — it runs until you stop it.';
  const tokens = spend.tokens === null ? 'tokens nothing can measure' : `${spend.tokens.toLocaleString()} tokens`;
  return `No budget — ${Math.floor(spend.elapsedSec)}s and ${tokens} so far.`;
}

const link: React.CSSProperties = {
  fontSize: 10.5,
  padding: '1px 6px',
  color: '#75798c',
  border: '1px solid #33364a',
  borderRadius: 5,
  cursor: 'pointer',
};

const field = (wrong: boolean): React.CSSProperties => ({
  flex: '1 1 140px',
  minWidth: 110,
  fontSize: 11.5,
  padding: '3px 7px',
  background: '#15172480',
  border: `1px solid ${wrong ? '#5a3030' : '#2a2d40'}`,
  borderRadius: 5,
  color: '#c8cadb',
});
