import { useState } from 'react';
import { MAX_ATTEMPTS_CEILING, MAX_CHILDREN_CEILING, type FleetLimits as Limits } from '@claudia/shared';
import { send } from '../store';

/**
 * The two numbers that bound what the whole fleet can spend.
 *
 * `maxChildren` is how much it spends at once and `maxAttempts` is how long it
 * keeps paying for a task that will not pass. They became a stored preference
 * rather than a constant in source, read at every mission's pulse — and then
 * had no way to be read or set by a person, which is a preference in name only.
 *
 * Fleet-wide, and applied ON TOP of each mission's own child limit: the pulse
 * takes the lower of the two. So lowering this throttles every mission at once
 * without editing any of them, which is what it is for — a machine that cannot
 * take the load, not the first thing that should bind.
 *
 * Sent on commit rather than on every keystroke. Each send is a settings write
 * and a broadcast to every client, and a number being typed is not a number
 * somebody meant.
 */
export function FleetLimitsControl({ limits }: { limits: Limits }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-ghost" style={chip} title="Fleet-wide ceilings">
        ≤{limits.maxChildren} at once · ≤{limits.maxAttempts} tries
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Number
        label="at once"
        value={limits.maxChildren}
        max={MAX_CHILDREN_CEILING}
        onCommit={(maxChildren) => send({ type: 'set_fleet_limits', maxChildren, maxAttempts: limits.maxAttempts })}
      />
      <Number
        label="tries"
        value={limits.maxAttempts}
        max={MAX_ATTEMPTS_CEILING}
        onCommit={(maxAttempts) => send({ type: 'set_fleet_limits', maxChildren: limits.maxChildren, maxAttempts })}
      />
      <button onClick={() => setOpen(false)} className="btn btn-ghost" style={chip}>
        done
      </button>
    </span>
  );
}

function Number({
  label,
  value,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  // The field holds text while it is being typed — an empty box is a normal
  // thing to pass through on the way to "2", and clamping mid-keystroke fights
  // the person using it. The server clamps whatever finally arrives.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const commit = (): void => {
    const parsed = globalThis.Number(draft);
    setDraft(undefined);
    if (draft !== undefined && draft.trim() !== '' && globalThis.Number.isFinite(parsed) && parsed !== value) {
      onCommit(parsed);
    }
  };
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: '#75798c' }}>
      <input
        type="number"
        min={1}
        max={max}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(undefined);
        }}
        style={{
          width: 44,
          fontSize: 11,
          padding: '2px 4px',
          background: '#15172480',
          border: '1px solid #2a2d40',
          borderRadius: 5,
          color: '#c8cadb',
        }}
      />
      {label}
    </label>
  );
}

const chip: React.CSSProperties = {
  fontSize: 10.5,
  padding: '2px 8px',
  color: '#75798c',
  border: '1px solid #33364a',
  borderRadius: 6,
  cursor: 'pointer',
};
