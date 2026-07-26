import type { FeedStep, SessionSummary, TranscriptItem } from '@claudia/shared';
import { useEffect, useRef, useState } from 'react';
import { elapsed, fmtCost, fmtModel, fmtTokens } from '../format';
import { send } from '../store';
import { COLORS, statusOf } from '../status';
import { ApprovalBanner } from './ApprovalBanner';
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
}: Props) {
  const tileRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'feed' | 'chat'>('feed');
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

  const [draft, setDraft] = useState('');
  const status = statusOf(session.state);
  const yolo = session.permissionMode === 'bypassPermissions';

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send({ type: 'send_prompt', sessionId: session.id, text });
    setDraft('');
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
        <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
          {(['feed', 'chat'] as const).map((v) => (
            <button
              key={v}
              className="btn btn-ghost"
              title={v === 'feed' ? 'Abstracted activity feed' : 'Full conversation transcript'}
              onClick={() => setView(v)}
              style={{
                fontSize: 9.5,
                padding: '1px 7px',
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                border: `1px solid ${view === v ? '#423a6a' : 'transparent'}`,
                color: view === v ? '#b5abfc' : '#595d6c',
              }}
            >
              {v}
            </button>
          ))}
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
          placeholder={
            session.needsAction ? 'answer…' : session.state === 'idle' ? 'send a new task…' : 'queue a message…'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        {session.queuedPrompts.length > 0 && (
          <span
            title={session.queuedPrompts.join('\n')}
            style={{
              flex: 'none',
              fontSize: 10,
              color: '#d9b184',
              border: '1px solid #6b5636',
              borderRadius: 4,
              padding: '1px 6px',
            }}
          >
            {session.queuedPrompts.length} queued
          </span>
        )}
        <span style={{ flex: 'none', fontSize: 10, color: '#75798c', fontVariantNumeric: 'tabular-nums' }}>
          {fmtTokens(session.inputTokens + session.outputTokens)}
        </span>
        <span style={{ flex: 'none', fontSize: 10, color: '#b5abfc', fontVariantNumeric: 'tabular-nums' }}>
          {fmtCost(session.costUsd)}
        </span>
      </div>

      {height !== undefined && (
        <div className="tile-grip" onMouseDown={onGripDown} title="Drag to resize this tile" />
      )}
    </div>
  );
}
