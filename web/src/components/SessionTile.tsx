import type { FeedStep, SessionSummary } from '@claudia/shared';
import { useRef, useState } from 'react';
import { elapsed, fmtCost, fmtTokens } from '../format';
import { send } from '../store';
import { COLORS, statusOf } from '../status';
import { ApprovalBanner } from './ApprovalBanner';
import { SessionFeed } from './SessionFeed';

interface Props {
  session: SessionSummary;
  steps: FeedStep[];
  now: number;
  index: number;
  focused: boolean;
  height: number;
  onResize: (px: number) => void;
}

/** One session: header chips, activity feed, approval banner, composer. */
export function SessionTile({ session, steps, now, index, focused, height, onResize }: Props) {
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

  const [draft, setDraft] = useState('');
  const status = statusOf(session.state);
  const yolo = session.permissionMode === 'bypassPermissions';

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send({ type: 'send_prompt', sessionId: session.id, text });
    setDraft('');
  };

  const cls = ['tile', session.pendingApproval ? 'awaiting' : '', session.state === 'error' ? 'error' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={tileRef}
      id={`session-${session.id}`}
      className={cls}
      style={{
        height,
        ...(yolo ? { borderColor: '#5c3b3b', boxShadow: 'inset 0 2px 0 #8a4f4f' } : {}),
        ...(focused ? { outline: '1px solid #796cbf', outlineOffset: 2 } : {}),
      }}
    >
      <div className="tile-head">
        {index < 9 && (
          <span
            title={`jump with the modifier and ${index + 1}`}
            style={{ flex: 'none', fontSize: 9, color: '#4f5364', fontVariantNumeric: 'tabular-nums' }}
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
        <span style={{ flex: 'none', fontWeight: 500, fontSize: 13, letterSpacing: '-.01em' }}>{session.name}</span>
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
            color: '#9397ab',
            border: `1px solid ${yolo ? '#8a4f4f' : '#33364a'}`,
            background: yolo ? '#2e2226' : 'transparent',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          {session.model?.split(/[-\s]/)[0] ?? '—'}
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
        <SessionFeed steps={steps} />
      </div>

      {session.pendingApproval && (
        <ApprovalBanner
          approval={session.pendingApproval}
          now={now}
          onApprove={() =>
            send({ type: 'approve', sessionId: session.id, requestId: session.pendingApproval!.requestId })
          }
          onDeny={() => send({ type: 'deny', sessionId: session.id, requestId: session.pendingApproval!.requestId })}
        />
      )}

      <div className="composer">
        <button
          title={
            yolo
              ? 'Permissions skipped — click to require approvals again'
              : 'Click to run this session without permission prompts'
          }
          onClick={() =>
            send({
              type: 'set_permission_mode',
              sessionId: session.id,
              mode: yolo ? 'default' : 'bypassPermissions',
            })
          }
          style={{
            flex: 'none',
            cursor: 'pointer',
            borderRadius: 5,
            padding: '1px 6px',
            fontFamily: 'var(--font-body)',
            fontSize: 9.5,
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            border: `1px solid ${yolo ? '#5c3b3b' : '#33364a'}`,
            background: yolo ? '#2e2226' : 'transparent',
            color: yolo ? COLORS.err : '#595d6c',
          }}
        >
          skip perms
        </button>
        <span className="mono" style={{ color: status.color, fontSize: 12 }}>
          ›
        </span>
        <input
          value={draft}
          placeholder={session.state === 'idle' ? 'send a new task…' : 'queue a message…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <span style={{ flex: 'none', fontSize: 10, color: '#75798c', fontVariantNumeric: 'tabular-nums' }}>
          {fmtTokens(session.inputTokens + session.outputTokens)}
        </span>
        <span style={{ flex: 'none', fontSize: 10, color: '#b5abfc', fontVariantNumeric: 'tabular-nums' }}>
          {fmtCost(session.costUsd)}
        </span>
      </div>

      <div className="tile-grip" onMouseDown={onGripDown} title="Drag to resize this tile" />
    </div>
  );
}
