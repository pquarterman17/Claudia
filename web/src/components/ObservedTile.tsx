import type { ObservedSession } from '@claudia/shared';
import { fmtDur } from '../format';
import { COLORS } from '../status';

/**
 * A session running in a terminal, which Claudia can see but not touch.
 *
 * Deliberately looks unlike a real tile. Everything else on this board has
 * buttons; this has none, and there is no honest way to add them — there is no
 * attach path to a live CLI, so approving or interrupting from here is not
 * something that could be built later. The dashed border and the muted palette
 * are the promise that clicking will not do anything.
 */

const STATE_LABEL: Record<ObservedSession['state'], { text: string; color: string }> = {
  working: { text: 'working', color: COLORS.accent },
  idle: { text: 'idle', color: COLORS.ok },
  needs_you: { text: 'needs you', color: COLORS.warn },
  ended: { text: 'ended', color: '#5a5e70' },
};

/** What the notification actually meant, in words rather than an enum. */
const NEEDS_LABEL: Record<string, string> = {
  permission_prompt: 'waiting on a permission prompt',
  idle_prompt: 'waiting for your input',
  agent_needs_input: 'an agent needs input',
};

const name = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

export function ObservedTile({ session, now }: { session: ObservedSession; now: number }) {
  const mark = STATE_LABEL[session.state];
  const quiet = now - session.lastEventAt;
  const detail =
    (session.needs ? (NEEDS_LABEL[session.needs] ?? session.needs) : undefined) ??
    (session.state === 'working' && session.lastTool ? `running ${session.lastTool}` : undefined) ??
    session.lastMessage ??
    session.lastPrompt;

  return (
    <section
      style={{
        border: '1px dashed #3a3d52',
        borderRadius: 10,
        padding: '10px 12px',
        background: '#191b26',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        opacity: session.state === 'ended' ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span
          title={session.cwd}
          style={{
            fontSize: 12.5,
            color: '#cfd3e5',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name(session.cwd)}
        </span>
        <span
          title="Seen through Claude Code's hooks — Claudia did not launch this one and cannot control it"
          style={{
            flex: 'none',
            fontSize: 9,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: '#75798c',
            border: '1px solid #33364a',
            borderRadius: 4,
            padding: '1px 4px',
          }}
        >
          terminal
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ flex: 'none', fontSize: 10.5, color: mark.color }}>{mark.text}</span>
      </div>

      {detail && (
        <div
          style={{
            fontSize: 11,
            color: '#9397ab',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={detail}
        >
          {detail}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#595d6c' }}>
        {session.permissionMode && <span>{session.permissionMode}</span>}
        {/* Staleness is load-bearing on a read-only tile: a terminal killed with
            Ctrl+C sends nothing, so "last seen" is the only honest signal that
            what you are reading may already be over. */}
        <span title={new Date(session.lastEventAt).toLocaleString()}>
          {quiet < 5000 ? 'just now' : `${fmtDur(quiet)} ago`}
        </span>
      </div>
    </section>
  );
}
