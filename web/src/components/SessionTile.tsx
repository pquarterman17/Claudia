import type { FeedStep, FileCheckpoint, SessionSummary, TranscriptItem } from '@claudia/shared';
import { useEffect, useRef, useState } from 'react';
import { accentFor } from '../accent';
import { elapsed, fmtModel } from '../format';
import { PERMISSION_MODES } from '../permission-modes';
import { send } from '../store';
import { COLORS, statusOf } from '../status';
import { ApprovalBanner } from './ApprovalBanner';
import { Composer } from './Composer';
import { ContextMeter } from './ContextMeter';
import { QuestionPicker } from './QuestionPicker';
import { SessionFeed } from './SessionFeed';
import { TranscriptView } from './TranscriptView';

interface Props {
  session: SessionSummary;
  steps: FeedStep[];
  transcript: TranscriptItem[];
  /** The reply currently streaming in, shown live below the feed. */
  draft?: string;
  now: number;
  index: number;
  focused: boolean;
  /** Fixed height in scroll mode; undefined lets the grid size the tile. */
  height: number | undefined;
  onResize: (px: number) => void;
  checkpoints: FileCheckpoint[];
}

/** One session: header chips, activity feed, approval banner, composer. */
export function SessionTile({
  session,
  steps,
  transcript,
  draft: streaming,
  now,
  index,
  focused,
  height,
  onResize,
  checkpoints,
}: Props) {
  const tileRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'feed' | 'chat'>('feed');
  const [menuOpen, setMenuOpen] = useState(false);
  const backfilledRef = useRef(false);

  useEffect(() => {
    if (view === 'chat' && !backfilledRef.current) {
      backfilledRef.current = true;
      send({ type: 'get_transcript', sessionId: session.id });
    }
  }, [view, session.id]);

  const onGripDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const top = tileRef.current?.getBoundingClientRect().top ?? 0;
    const move = (ev: MouseEvent) => onResize(ev.clientY - top);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const [renaming, setRenaming] = useState(false);
  const status = statusOf(session.state);
  const yolo = session.permissionMode === 'bypassPermissions';
  const accent = accentFor(session.id);

  const submitRename = (value: string) => {
    send({ type: 'rename_session', sessionId: session.id, title: value });
    setRenaming(false);
  };

  const removeSession = () => {
    if (window.confirm(`Stop and remove ${session.title ?? session.name}? This cannot be undone.`)) {
      send({ type: 'remove_session', sessionId: session.id });
    }
  };

  const cls = [
    'tile',
    session.pendingApproval || session.needsAction || session.pendingQuestion ? 'awaiting' : '',
    session.state === 'error' ? 'error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={tileRef}
      id={`session-${session.id}`}
      className={cls}
      style={{
        ...(height === undefined ? { minHeight: 0 } : { height }),
        ...(yolo ? { borderColor: '#5c3b3b', boxShadow: 'inset 0 2px 0 #8a4f4f' } : {}),
        ...(focused ? { outline: '1px solid #796cbf', outlineOffset: 2 } : {}),
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div className="tile-head">
        {index < 9 && (
          <span
            title={`jump with the modifier and ${index + 1}`}
            style={{
              flex: 'none',
              fontSize: 9,
              color: '#14151b',
              fontWeight: 600,
              background: accent,
              borderRadius: 3,
              padding: '0 3px',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {index + 1}
          </span>
        )}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: status.dot,
            flex: 'none',
            animation: status.pulse ? 'claudia-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        {renaming ? (
          <input
            autoFocus
            aria-label="Session name"
            defaultValue={session.title ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitRename((e.target as HTMLInputElement).value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            onBlur={() => setRenaming(false)}
            style={{
              flex: 'none',
              width: 130,
              fontFamily: 'var(--font-body)',
              fontWeight: 500,
              fontSize: 13,
              letterSpacing: '-.01em',
              color: '#e4e7f5',
              background: '#12131a',
              border: '1px solid #3f424d',
              borderRadius: 4,
              padding: '0 4px',
            }}
          />
        ) : (
          <button
            type="button"
            aria-label={`Rename session ${session.title ?? session.name}`}
            className="btn btn-ghost"
            onClick={() => setRenaming(true)}
            title="Rename this session"
            style={{ flex: 'none', fontWeight: 500, fontSize: 13, letterSpacing: '-.01em', cursor: 'pointer' }}
          >
            {session.title ?? session.name}
            {session.title && (
              <span style={{ fontSize: 10, color: '#75798c', marginLeft: 5, fontWeight: 400 }}>{session.name}</span>
            )}
          </button>
        )}
        <span
          className="mono"
          title={session.cwd}
          style={{ flex: '1 1 auto', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 10.5, color: '#75798c' }}
        >
          {session.cwd}
        </span>
        <span title={status.label} style={{ flex: 'none', fontSize: 10.5, color: status.color }}>
          {status.short}
        </span>
        <span style={{ flex: 'none', fontSize: 10.5, color: '#75798c', fontVariantNumeric: 'tabular-nums' }}>
          {elapsed(session.startedAt, now)}
        </span>
        <span
          style={{
            flex: 'none',
            fontSize: 10,
            border: `1px solid ${yolo ? '#8a4f4f' : '#3f424d'}`,
            background: yolo ? '#2e2226' : '#22252f',
            borderRadius: 4,
            padding: '1px 6px',
            fontVariantNumeric: 'tabular-nums',
            color: yolo ? '#e0a0a0' : '#b5abfc',
          }}
          title={
            session.selectedModel
              ? `Running ${session.model ?? 'unknown'} · switching to ${session.selectedModel} on the next turn`
              : `${session.model ?? 'model unknown'} · ${session.permissionMode}`
          }
        >
          {fmtModel(session.model)}
          {/* A switch only takes effect next turn, so show it as pending rather
              than pretending the running turn changed model. */}
          {session.selectedModel && (
            <span style={{ color: COLORS.warn }}> → {fmtModel(session.selectedModel)}</span>
          )}
          {yolo ? ' ⚠' : ''}
        </span>
        {(session.state === 'working' || session.state === 'starting') && (
          <button
            className="btn btn-ghost"
            title="Interrupt this session"
            style={{ flex: 'none', fontSize: 10, padding: '2px 6px', color: COLORS.warn }}
            onClick={() => send({ type: 'interrupt', sessionId: session.id })}
          >
            ⏸
          </button>
        )}
        <button
          className="btn btn-ghost"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="Session actions"
          style={{ flex: 'none', fontSize: 10, padding: '2px 6px', color: '#75798c' }}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div role="menu" aria-label={`Actions for ${session.title ?? session.name}`} style={{ position: 'absolute', right: 12, zIndex: 10, minWidth: 190, padding: 4, background: '#1d1f2c', border: '1px solid #33364a', borderRadius: 6, boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)' }}>
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
                  setMenuOpen(false);
                }}
              >
                {`${m.key === session.permissionMode ? '✓ ' : ''}${m.label}`}
              </MenuAction>
            ))}
            <div style={{ borderTop: '1px solid #2c2f3d', margin: '4px 0' }} />
            <MenuAction onClick={() => { setRenaming(true); setMenuOpen(false); }}>Rename</MenuAction>
            {session.claudeSessionId && <MenuAction onClick={() => send({ type: 'get_saved_session_detail', sessionId: session.claudeSessionId!, cwd: session.cwd })}>Load file checkpoints</MenuAction>}
            {checkpoints.map((checkpoint) => (
              <MenuAction key={checkpoint.messageId} title="Restores tracked files only; conversation is unchanged" color="#e0c58c" onClick={() => {
                if (window.confirm(`Restore tracked files to “${checkpoint.label}”? Conversation history will not change.`)) send({ type: 'rewind_files', sessionId: session.id, checkpointId: checkpoint.messageId });
                setMenuOpen(false);
              }}>{`Restore files: ${checkpoint.label}`}</MenuAction>
            ))}
            {(session.state === 'working' || session.state === 'starting') && <MenuAction color={COLORS.warn} onClick={() => { send({ type: 'interrupt', sessionId: session.id }); setMenuOpen(false); }}>Interrupt</MenuAction>}
            <MenuAction color="#e0a0a0" onClick={removeSession}>Stop and remove…</MenuAction>
          </div>
        )}
      </div>

      <div className="tile-body">
        <div role="group" aria-label="Session view" style={{ display: 'flex', gap: 4, flex: 'none' }}>
          {(['feed', 'chat'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className="btn btn-ghost"
              title={v === 'feed' ? 'Abstracted activity feed' : 'Full conversation transcript'}
              onClick={() => setView(v)}
              style={{
                fontSize: 9.5,
                minHeight: 28, padding: '1px 7px',
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                border: `1px solid ${view === v ? '#423a6a' : 'transparent'}`,
                color: view === v ? '#b5abfc' : '#595d6c',
              }}
            >
              {v === 'feed' ? 'Activity' : 'Chat'}
            </button>
          ))}
          <ContextMeter session={session} />
        </div>
        {view === 'feed' ? (
          <SessionFeed steps={steps} draft={streaming} />
        ) : (
          <TranscriptView items={transcript} draft={streaming} />
        )}
      </div>

      {session.needsAction && !session.pendingApproval && (
        <div
          className="approval-banner"
          style={{ background: '#251f2c', borderTopColor: '#6b5636' }}
        >
          <span
            style={{
              fontSize: 10,
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: COLORS.warn,
              flex: 'none',
            }}
          >
            Waiting on you
          </span>
          <span
            title={session.needsAction.detail ?? session.needsAction.request}
            style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#e4e7f5' }}
          >
            {session.needsAction.request}
          </span>
        </div>
      )}

      {session.pendingQuestion && (
        <QuestionPicker sessionId={session.id} question={session.pendingQuestion} />
      )}

      {session.pendingApproval && !session.pendingQuestion && (
        <ApprovalBanner
          approval={session.pendingApproval}
          now={now}
          onApprove={() =>
            send({ type: 'approve', sessionId: session.id, requestId: session.pendingApproval!.requestId })
          }
          onDeny={() => send({ type: 'deny', sessionId: session.id, requestId: session.pendingApproval!.requestId })}
        />
      )}

      <Composer session={session} />

      {height !== undefined && (
        <div className="tile-grip" onMouseDown={onGripDown} title="Drag to resize this tile" />
      )}
    </div>
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
