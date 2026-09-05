import { useState } from 'react';
import type { ObservedSession } from '@claudia/shared';
import { send } from '../store';
import type { MirrorView } from '../mirror-state';
import { ObservedTile } from './ObservedTile';

/**
 * The terminal sessions Claudia can see, and the switch that reveals them.
 *
 * Kept below the board rather than mixed into it: these cannot be launched,
 * approved, interrupted or prompted, and a read-only tile sitting in the same
 * grid as a live one invites clicking things that are not there.
 *
 * The switch is explicit and stays explicit. Turning it on writes the owner's
 * GLOBAL `~/.claude/settings.json`, which affects every Claude Code session on
 * the machine and not just Claudia's, so it says so before you click and
 * reports exactly what it wrote afterwards.
 */
export function ObservedStrip({
  observed,
  monitoring,
  now,
  mirrors,
}: {
  observed: ObservedSession[];
  monitoring: boolean;
  now: number;
  mirrors: Record<string, MirrorView>;
}) {
  // Which tiles are expanded. Local, because it is a view preference and
  // nothing on the server needs to know — but the SUBSCRIPTION does follow it,
  // so closing a tile stops the server reading that transcript.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Nothing to show and nothing switched on: one quiet line, not a panel.
  const empty = observed.length === 0;

  return (
    <section style={{ flex: 'none', padding: '8px 16px 12px', borderTop: '1px solid #23263a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: empty ? 0 : 8 }}>
        <span className="kicker">Terminal sessions</span>
        {!empty && <span style={{ fontSize: 10.5, color: '#595d6c' }}>{observed.length}</span>}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => send({ type: 'set_hook_monitor', enabled: !monitoring })}
          title={
            monitoring
              ? "Removes Claudia's hook from your global ~/.claude/settings.json"
              : "Adds a hook to your GLOBAL ~/.claude/settings.json so sessions you start in a terminal appear here. Your existing file is copied aside first, and every other setting is left alone."
          }
          className="btn btn-ghost"
          style={{
            fontSize: 10.5,
            padding: '2px 8px',
            color: monitoring ? '#d2cefd' : '#75798c',
            border: `1px solid ${monitoring ? '#423a6a' : '#33364a'}`,
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          {monitoring ? 'watching — turn off' : 'watch terminal sessions'}
        </button>
      </div>

      {empty ? (
        <div style={{ fontSize: 11, color: '#595d6c', marginTop: 4 }}>
          {monitoring
            ? 'Watching. A session you start in a terminal will appear here once it does something.'
            : 'Sessions started outside Claudia are invisible to it. Turning this on adds a hook to your global Claude Code settings so they show up here, read-only.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          }}
        >
          {observed.map((session) => (
            <ObservedTile
              key={session.id}
              session={session}
              now={now}
              mirror={mirrors[session.id]}
              open={open.has(session.id)}
              onToggle={() => toggle(session.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
