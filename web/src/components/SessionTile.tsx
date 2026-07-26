import type { FeedStep, SessionSummary } from '@claudia/shared';
import { useRef, useState } from 'react';
import { accentFor } from '../accent';
import { elapsed, fmtModel } from '../format';
import { send } from '../store';
import { COLORS, statusOf } from '../status';
import { ApprovalBanner } from './ApprovalBanner';
import { Composer } from './Composer';
import { QuestionPicker } from './QuestionPicker';
import { SessionFeed } from './SessionFeed';

interface Props {
  session: SessionSummary;
  steps: FeedStep[];
  /** The reply currently streaming in, shown live below the feed. */
  draft?: string;
  now: number;
  index: number;
  focused: boolean;
  /** Fixed height in scroll mode; undefined lets the grid size the tile. */
  height: number | undefined;
  onResize: (px: number) => void;
}

/** One session: header chips, activity feed, approval banner, composer. */
export function SessionTile({ session, steps, draft: streaming, now, index, focused, height, onResize }: Props) {
  const tileRef = useRef<HTMLDivElement>(null);

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
          <span
            onClick={() => setRenaming(true)}
            title="Click to rename this session"
            style={{ flex: 'none', fontWeight: 500, fontSize: 13, letterSpacing: '-.01em', cursor: 'pointer' }}
          >
            {session.title ?? session.name}
            {session.title && (
              <span style={{ fontSize: 10, color: '#75798c', marginLeft: 5, fontWeight: 400 }}>{session.name}</span>
            )}
          </span>
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
          title={`${session.model ?? 'model unknown'} · ${session.permissionMode}`}
        >
          {fmtModel(session.model)}
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
          title="Stop and remove this session"
          style={{ flex: 'none', fontSize: 10, padding: '2px 6px', color: '#75798c' }}
          onClick={() => send({ type: 'remove_session', sessionId: session.id })}
        >
          ✕
        </button>
      </div>

      <div className="tile-body">
        <SessionFeed steps={steps} draft={streaming} />
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
