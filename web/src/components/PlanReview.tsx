import type { PendingApproval } from '@claudia/shared';
import { useState } from 'react';
import { renderMarkdown } from '../markdown-lite';
import { planFeedbackMessage } from '../plan-review';
import { send } from '../store';
import { MarkdownBlock } from './MarkdownBlock';

interface Props {
  sessionId: string;
  approval: PendingApproval;
}

/**
 * Plan-mode review surface: ExitPlanMode's input is the plan itself (markdown
 * text + the CLI's on-disk copy), not a diff — so unlike ApprovalBanner this
 * renders the plan for reading and offers a free-text "ask for changes"
 * instead of a bare deny. That text rides back as the SDK's existing deny
 * `message`; no new protocol was needed, the SDK already feeds a deny
 * message back to the model as the reason for the rejection.
 */
export function PlanReview({ sessionId, approval }: Props) {
  const [feedback, setFeedback] = useState('');
  const change = approval.change;
  if (!change || change.kind !== 'plan') return null;

  const segments = renderMarkdown(change.plan);

  const requestChanges = () => {
    const message = planFeedbackMessage(feedback);
    if (!message) return;
    send({ type: 'deny', sessionId, requestId: approval.requestId, message });
    setFeedback('');
  };

  return (
    <div
      style={{
        flex: 'none',
        padding: '10px 11px',
        background: '#221f31',
        borderTop: '1px solid #423a6a',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span
          style={{
            fontSize: 9,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: '#b5abfc',
            border: '1px solid #423a6a',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          Plan
        </span>
        <span style={{ flex: 1, fontSize: 11.5, color: '#e4e7f5' }}>Ready for review</span>
      </div>

      <div
        className="mono"
        title={change.planFilePath}
        style={{ fontSize: 10, color: '#75798c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        saved to {change.planFilePath}
      </div>

      <div
        style={{
          maxHeight: 260,
          overflow: 'auto',
          padding: '6px 8px',
          background: '#16182a',
          borderRadius: 6,
          fontSize: 12,
          color: '#cfd3e5',
        }}
      >
        <MarkdownBlock segments={segments} />
      </div>
      {change.truncated && (
        <span style={{ fontSize: 10.5, color: '#9397ab' }}>
          This plan was too long to show in full here — the complete version is saved at the path above.
        </span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={() => send({ type: 'approve', sessionId, requestId: approval.requestId })}
          style={{ fontSize: 11, padding: '3px 11px' }}
        >
          Approve plan
        </button>
        <span style={{ fontSize: 10.5, color: '#75798c' }}>or ask for changes below</span>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input"
          value={feedback}
          placeholder="Ask for changes…"
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              requestChanges();
            }
          }}
          style={{ flex: 1, fontSize: 11, padding: '4px 7px' }}
        />
        <button
          className="btn btn-ghost"
          disabled={!planFeedbackMessage(feedback)}
          onClick={requestChanges}
          style={{ fontSize: 11, padding: '3px 9px', color: '#9397ab' }}
        >
          Ask for changes
        </button>
      </div>
    </div>
  );
}
