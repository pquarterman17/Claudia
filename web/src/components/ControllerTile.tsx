import type { SessionSummary, TriggerStatus } from '@claudia/shared';
import { useEffect, useState } from 'react';
import { send } from '../store';
import { COLORS } from '../status';
import { FinishChain } from './FinishChain';

interface Props {
  trigger: TriggerStatus;
  sessions: SessionSummary[];
  countdownSec: number;
  stopOnCloseSec: number;
}

/**
 * Global control: what happens when every session settles, and bulk actions.
 * The aggregate counts live in the top bar; this tile is the action surface.
 */
export function ControllerTile({ trigger, sessions, countdownSec, stopOnCloseSec }: Props) {
  const [confirming, setConfirming] = useState(false);
  const waiting = sessions.filter((s) => s.pendingApproval).length;
  const asking = sessions.filter((s) => s.needsAction).length;
  const busy = sessions.filter((s) => s.state === 'working' || s.state === 'starting').length;
  const unprompted = sessions.filter((s) => s.permissionMode === 'bypassPermissions').length;
  const armed = trigger.state === 'armed' || trigger.state === 'counting';

  // A pending confirm must not survive an edit to the chain or a state change.
  const chainKey = trigger.chain.map((s) => s.key).join(',');
  useEffect(() => setConfirming(false), [chainKey, trigger.state]);

  const onArmClick = () => {
    if (armed) {
      send({ type: 'disarm_trigger' });
      return;
    }
    if (trigger.destructive && !confirming) {
      setConfirming(true);
      return;
    }
    send({ type: 'arm_trigger', confirmDestructive: trigger.destructive });
    setConfirming(false);
  };

  const armLabel = armed ? 'Disarm' : confirming ? 'Confirm — really?' : 'Arm';
  const armColor = confirming ? COLORS.err : armed ? COLORS.warn : '#b5abfc';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: armed ? COLORS.warn : '#4a4e5e',
            animation: armed ? 'claudia-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        <span className="kicker">Global control</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: armed ? COLORS.warn : COLORS.mute }}>{trigger.state}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {unprompted > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px',
              border: '1px solid #5c3b3b',
              borderRadius: 7,
              background: '#2a2027',
            }}
          >
            <span style={{ color: COLORS.err, fontSize: 12 }}>⚠</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: COLORS.warn }}>
              {unprompted} {unprompted === 1 ? 'session runs' : 'sessions run'} unprompted — every tool call
              executes without asking
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => send({ type: 'require_approvals_everywhere' })}
              style={{ fontSize: 11, padding: '2px 8px', color: '#9397ab' }}
            >
              Require approvals
            </button>
          </div>
        )}

        <FinishChain trigger={trigger} />

        <section
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 10px',
            borderRadius: 8,
            border: `1px solid ${confirming ? '#8a4f4f' : armed ? '#6b5636' : '#33364a'}`,
            background: armed ? '#251f2c' : '#1c1e2b',
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, color: armed ? COLORS.warn : COLORS.text }}>
              {statusTitle(trigger)}
            </span>
            <span style={{ display: 'block', fontSize: 11, color: '#75798c', marginTop: 2 }}>
              {statusSub(trigger)}
            </span>
          </span>
          {trigger.countdownSec !== undefined && (
            <span
              className="mono"
              style={{ fontSize: 20, color: COLORS.warn, fontVariantNumeric: 'tabular-nums' }}
            >
              {trigger.countdownSec}s
            </span>
          )}
          <button
            className="btn btn-primary"
            onClick={onArmClick}
            style={{ fontSize: 11.5, padding: '4px 12px', borderColor: armColor, color: armColor }}
          >
            {armLabel}
          </button>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="kicker" style={{ width: 92 }}>
              Grace period
            </span>
            <input
              type="number"
              aria-label="Grace period in seconds"
              min={5}
              max={600}
              value={countdownSec}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) send({ type: 'set_countdown', seconds: n });
              }}
              className="input mono"
              style={{ width: 62, fontSize: 11.5, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: '#75798c' }}>seconds to cancel before it fires</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="kicker" style={{ width: 92 }}>
              On tab close
            </span>
            <input
              type="number"
              aria-label="Stop on tab close delay in seconds"
              min={0}
              max={3600}
              value={stopOnCloseSec}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) send({ type: 'set_stop_on_close', seconds: n });
              }}
              className="input mono"
              style={{ width: 62, fontSize: 11.5, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: '#75798c' }}>
              {stopOnCloseSec > 0
                ? `seconds before sessions stop (survives a reload)`
                : `never stop — sessions keep running unattended`}
            </span>
          </div>
        </section>

        {asking > 0 && (
          <div style={{ fontSize: 11, color: COLORS.warn }}>
            {asking} {asking === 1 ? 'session is' : 'sessions are'} waiting on an answer — the chain
            will not fire until you reply.
          </div>
        )}

        <section>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Everything, at once
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              className="btn btn-secondary"
              disabled={waiting === 0}
              onClick={() => send({ type: 'bulk', op: 'approve_all' })}
              style={{
                fontSize: 11.5,
                padding: '4px 10px',
                borderColor: '#3f424d',
                color: waiting ? '#d2cefd' : '#595d6c',
              }}
            >
              Approve all ({waiting})
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy === 0}
              onClick={() => send({ type: 'bulk', op: 'interrupt_all' })}
              style={{
                fontSize: 11.5,
                padding: '4px 10px',
                borderColor: '#3f424d',
                color: busy ? '#9397ab' : '#595d6c',
              }}
            >
              Interrupt all ({busy})
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function statusTitle(t: TriggerStatus): string {
  const n = t.chain.length;
  const what = n === 1 ? '1 step' : `${n} steps`;
  if (t.state === 'fired') return 'Chain finished';
  if (t.state === 'running') return 'Running the chain';
  if (t.state === 'counting') return `${what} in a moment`;
  if (t.state === 'armed') return `Armed · ${what}`;
  return n === 0 ? 'Nothing selected' : `${what} when idle`;
}

function statusSub(t: TriggerStatus): string {
  if (t.state === 'fired') return t.lastResult ?? 'done';
  if (t.state === 'running') return 'each step waits for the one before it';
  if (t.blockedBy && t.state === 'armed') return `held — ${t.blockedBy}`;
  if (t.state === 'armed') return 'fires once every session reports idle';
  if (t.state === 'counting') return 'cancel by disarming, or by starting work';
  return t.chain.length === 0 ? 'add an action above first' : 'nothing fires until you arm it';
}
