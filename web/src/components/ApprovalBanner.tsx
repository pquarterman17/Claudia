import type { PendingApproval } from '@claudia/shared';
import { elapsed } from '../format';

interface Props {
  approval: PendingApproval;
  now: number;
  onApprove: () => void;
  onDeny: () => void;
}

/** Inline permission prompt — resolves the session's canUseTool promise. */
export function ApprovalBanner({ approval, now, onApprove, onDeny }: Props) {
  return (
    <div className="approval-banner">
      <span
        style={{
          fontSize: 10,
          letterSpacing: '.12em',
          textTransform: 'uppercase',
          color: '#b5abfc',
          flex: 'none',
        }}
      >
        Allow?
      </span>
      <span style={{ flex: 'none', fontSize: 11, color: '#9397ab' }}>{approval.toolName}</span>
      <span
        className="mono"
        title={approval.summary}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {approval.summary}
      </span>
      <span style={{ flex: 'none', fontSize: 10.5, color: '#75798c', fontVariantNumeric: 'tabular-nums' }}>
        {elapsed(approval.requestedAt, now)}
      </span>
      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px', color: '#9397ab' }} onClick={onDeny}>
        Deny
      </button>
      <button className="btn btn-primary" style={{ fontSize: 11, padding: '3px 11px' }} onClick={onApprove}>
        Approve
      </button>
    </div>
  );
}
