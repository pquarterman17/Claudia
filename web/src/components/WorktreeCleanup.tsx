import { useState } from 'react';
import type { WorktreeCleanupEntry } from '@claudia/shared';
import { send } from '../store';

/**
 * Managed worktree cleanup: preview first, then remove what was picked.
 *
 * The plan is explicit that cleanup must preview branches and worktrees and
 * refuse unsafe deletion, and that fully autonomous destructive cleanup is a
 * non-goal — so there is no automatic pass behind this and no "remove all".
 * Nothing here is reached without a person asking twice.
 *
 * The list shows the KEPT ones too, with their reasons. A preview that names
 * only what it will delete answers the wrong question: the one a person
 * actually has, looking at a repository full of stale directories, is "why is
 * that one still here?".
 */
export function WorktreeCleanup({ missionId, plan }: {
  missionId: string;
  plan: { phase: 'preview' | 'applied'; entries: WorktreeCleanupEntry[] } | undefined;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());

  const entries = plan?.entries ?? [];
  const removable = entries.filter((entry) => entry.removable);
  // Unmerged is the one veto a human may lift, and per worktree: confirming one
  // removal in a preview must never authorise the unmerged one beside it.
  const unmerged = entries.filter((entry) => !entry.removable && /is not merged|confirm .* is merged/.test(entry.reason));
  const picked = [...chosen].filter((id) => entries.some((entry) => entry.worktreeId === id));

  return (
    <div style={{ margin: '0 0 10px', padding: '6px 8px', border: '1px solid #33364a', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#75798c' }}>worktrees</span>
        <button type="button" onClick={() => send({ type: 'preview_worktree_cleanup', missionId })} style={ghost}>
          {plan ? 'refresh preview' : 'preview cleanup'}
        </button>
        {picked.length > 0 && (
          <button
            type="button"
            onClick={() => {
              send({ type: 'remove_worktrees', missionId, worktreeIds: picked, confirmedUnmerged: [...confirmed] });
              setChosen(new Set());
              setConfirmed(new Set());
            }}
            style={{ ...ghost, color: '#e07070', border: '1px solid #4a2f2f' }}
          >
            remove {picked.length} selected
          </button>
        )}
      </div>

      {plan === undefined && (
        <p style={{ fontSize: 10, color: '#75798c', margin: '6px 0 0' }}>
          Nothing is removed automatically. A preview reads git and writes nothing.
        </p>
      )}

      {plan && entries.length === 0 && (
        <p style={{ fontSize: 10, color: '#75798c', margin: '6px 0 0' }}>This mission owns no worktrees.</p>
      )}

      {plan && entries.length > 0 && (
        <ul aria-label="Worktree cleanup plan" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 5 }}>
          {entries.map((entry) => (
            <li key={entry.worktreeId} style={{ display: 'grid', gap: 2 }}>
              <label style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, color: '#c8cadb' }}>
                {plan.phase === 'preview' && entry.removable && (
                  <input
                    type="checkbox"
                    checked={chosen.has(entry.worktreeId)}
                    onChange={(e) => setChosen(toggled(chosen, entry.worktreeId, e.target.checked))}
                  />
                )}
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5 }}>{entry.branch}</span>
                <span style={{ color: '#595d6c', fontSize: 10 }}>{entry.state}</span>
              </label>
              <span style={{ fontSize: 9.5, color: '#75798c', paddingLeft: plan.phase === 'preview' && entry.removable ? 20 : 0 }}>
                {describe(entry)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {plan?.phase === 'preview' && unmerged.length > 0 && (
        <div style={{ marginTop: 7, paddingTop: 6, borderTop: '1px solid #26283a' }}>
          <p style={{ fontSize: 9.5, color: '#e0a34f', margin: '0 0 4px' }}>
            These hold commits that are nowhere else. Confirming one lets it be selected; it confirms only that one.
          </p>
          {unmerged.map((entry) => (
            <label key={entry.worktreeId} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 10, color: '#a8abbd' }}>
              <input
                type="checkbox"
                checked={confirmed.has(entry.worktreeId)}
                onChange={(e) => {
                  setConfirmed(toggled(confirmed, entry.worktreeId, e.target.checked));
                  // Confirming is not choosing. The next preview re-grades this
                  // record with the confirmation applied, and only then can it
                  // be selected — so a click here never removes anything.
                  send({ type: 'preview_worktree_cleanup', missionId });
                }}
              />
              confirm {entry.branch}
            </label>
          ))}
        </div>
      )}

      {removable.length === 0 && entries.length > 0 && plan?.phase === 'preview' && (
        <p style={{ fontSize: 9.5, color: '#75798c', margin: '6px 0 0' }}>Nothing here can be removed safely yet.</p>
      )}
    </div>
  );
}

/** What happened, or what would — the reason is carried either way. */
function describe(entry: WorktreeCleanupEntry): string {
  if (entry.error !== undefined) return `not removed: ${entry.error}`;
  if (entry.removed === true) return `removed — ${entry.reason}`;
  return entry.removable ? `can be removed: ${entry.reason}` : `kept: ${entry.reason}`;
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

const ghost = {
  padding: '2px 7px',
  fontSize: 10,
  color: '#a8abbd',
  background: 'transparent',
  border: '1px solid #33364a',
  borderRadius: 4,
  cursor: 'pointer',
} as const;
