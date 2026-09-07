import { useState } from 'react';
import type { FileCheckpoint, SessionSummary } from '@claudia/shared';
import { capabilitiesFor } from '../agent-kinds';
import { fmtModel } from '../format';
import { PERMISSION_MODES } from '../permission-modes';
import { COLORS } from '../status';
import { send } from '../store';
import { belowAnchor, useAnchor } from '../use-anchor';
import { useDismiss } from '../use-dismiss';

/**
 * The tile's overflow menu: permission mode, rename, file checkpoints, and the
 * two ways to end a session.
 *
 * Split out of `SessionTile`, which had grown past the repository's size
 * ceiling carrying it — but the split earns its keep beyond the line count.
 * The menu needs a dismiss root that wraps its trigger and its own menu and
 * NOTHING else, and while it lived in the tile the nearest wrapper was the
 * whole header row. That row also holds the agent picker, so opening the agent
 * picker counted as a click inside this menu and left both open, overlapping —
 * exactly the fault the dismiss hook exists to fix. A component boundary makes
 * the correct root the obvious one.
 *
 * `display: contents` on that root: the button has to stay in the header's
 * flex row, and a wrapper that generates no box changes neither the layout nor
 * the containing block the menu is positioned against.
 */
export function SessionMenu({ session, yolo, checkpoints, onRename }: {
  session: SessionSummary;
  yolo: boolean;
  checkpoints: FileCheckpoint[];
  onRename: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  // Against the viewport, not the tile: the header clips what overflows it.
  const anchor = useAnchor<HTMLButtonElement>(open);
  const can = capabilitiesFor(session.agent);

  const removeSession = () => {
    if (window.confirm(`Stop and remove ${session.title ?? session.name}? This cannot be undone.`)) {
      send({ type: 'remove_session', sessionId: session.id });
    }
  };

  return (
    <span ref={wrap} style={{ display: 'contents' }}>
      <button
        ref={anchor.ref}
        className="btn btn-ghost"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Session actions"
        style={{ flex: 'none', fontSize: 10, padding: '2px 6px', color: '#75798c' }}
        onClick={() => setOpen((was) => !was)}
      >
        ⋯
      </button>
      {open && anchor.rect && (
        <div role="menu" aria-label={`Actions for ${session.title ?? session.name}`} style={{ ...belowAnchor(anchor.rect, 'right'), zIndex: 20, minWidth: 190, padding: 4, background: '#1d1f2c', border: '1px solid #33364a', borderRadius: 6, boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)' }}>
          <div style={{ padding: '4px 6px 6px', fontSize: 10, color: '#75798c' }}>{fmtModel(session.model)} · {yolo ? 'approvals skipped' : 'approvals on'}</div>
          <div style={{ padding: '2px 6px 3px', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', color: '#4a4e5e' }}>
            Permission mode
          </div>
          {PERMISSION_MODES.map((m) => (
            <MenuAction
              key={m.key}
              title={m.title}
              color={m.key === session.permissionMode ? '#b5abfc' : m.danger ? '#e0a0a0' : undefined}
              onClick={() => {
                send({ type: 'set_permission_mode', sessionId: session.id, mode: m.key });
                setOpen(false);
              }}
            >
              {`${m.key === session.permissionMode ? '✓ ' : ''}${m.label}`}
            </MenuAction>
          ))}
          <div style={{ borderTop: '1px solid #2c2f3d', margin: '4px 0' }} />
          <MenuAction onClick={() => { onRename(); setOpen(false); }}>Rename</MenuAction>
          {!can.fileCheckpoints ? (
            <div style={{ padding: '4px 6px', fontSize: 10, color: '#595d6c' }}>File checkpoints aren't available for Codex sessions</div>
          ) : (
            <>
              {session.claudeSessionId && <MenuAction onClick={() => send({ type: 'get_saved_session_detail', sessionId: session.claudeSessionId!, cwd: session.cwd })}>Load file checkpoints</MenuAction>}
              {checkpoints.map((checkpoint) => (
                <MenuAction key={checkpoint.messageId} title="Restores tracked files only; conversation is unchanged" color="#e0c58c" onClick={() => {
                  if (window.confirm(`Restore tracked files to “${checkpoint.label}”? Conversation history will not change.`)) send({ type: 'rewind_files', sessionId: session.id, checkpointId: checkpoint.messageId });
                  setOpen(false);
                }}>{`Restore files: ${checkpoint.label}`}</MenuAction>
              ))}
            </>
          )}
          {(session.state === 'working' || session.state === 'starting') && <MenuAction color={COLORS.warn} onClick={() => { send({ type: 'interrupt', sessionId: session.id }); setOpen(false); }}>Interrupt</MenuAction>}
          <MenuAction color="#e0a0a0" onClick={removeSession}>Stop and remove…</MenuAction>
        </div>
      )}
    </span>
  );
}

function MenuAction({
  children,
  color,
  title,
  onClick,
}: {
  children: string;
  color?: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button role="menuitem" className="btn btn-ghost" title={title} onClick={onClick} style={{ display: 'block', width: '100%', padding: '5px 7px', textAlign: 'left', fontSize: 11, color }}>
      {children}
    </button>
  );
}
