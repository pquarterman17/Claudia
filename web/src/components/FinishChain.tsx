import type { ChainStep, FinishActionKey, TriggerStatus } from '@claudia/shared';
import { fmtDur } from '../format';
import { send } from '../store';
import { COLORS } from '../status';

/** Offered in a fixed order; the chain itself follows the order you click. */
const ACTIONS: Array<{ key: FinishActionKey; label: string; unavailable?: string }> = [
  { key: 'notify', label: 'Notify me' },
  { key: 'memory', label: 'Save learnings' },
  {
    key: 'commit',
    label: 'Commit + push',
    unavailable: 'Not implemented yet — needs rules about which repos and what to do with a dirty tree',
  },
  { key: 'script', label: 'Wrap-up script' },
  { key: 'sleep', label: 'Sleep displays' },
  { key: 'shutdown', label: 'Shut down host' },
];

const labelFor = (key: FinishActionKey) => ACTIONS.find((a) => a.key === key)?.label ?? key;

const STEP_MARK: Record<ChainStep['state'], { icon: string; color: string }> = {
  pending: { icon: '·', color: '#4f5364' },
  running: { icon: '◌', color: COLORS.accent },
  done: { icon: '✓', color: COLORS.ok },
  failed: { icon: '✕', color: COLORS.err },
  skipped: { icon: '—', color: '#4f5364' },
};

interface Props {
  trigger: TriggerStatus;
}

/**
 * Builds and shows the ordered chain of finish actions. Clicking an action
 * appends it; clicking again removes it.
 */
export function FinishChain({ trigger }: Props) {
  const inChain = (key: FinishActionKey) => trigger.chain.some((s) => s.key === key);
  const lastIsDestructive = trigger.chain[trigger.chain.length - 1]?.destructive ?? false;
  const destructiveNotLast = trigger.chain.some((s) => s.destructive) && !lastIsDestructive;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="kicker">When everything finishes</span>
        <span style={{ flex: 1 }} />
        {trigger.chain.length > 0 && (
          <button
            onClick={() => send({ type: 'clear_finish_chain' })}
            className="btn btn-ghost"
            style={{ fontSize: 10, padding: '1px 6px', color: '#75798c' }}
          >
            clear
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ACTIONS.map((a) => {
          const on = inChain(a.key);
          const danger = a.key === 'shutdown';
          const position = trigger.chain.findIndex((s) => s.key === a.key) + 1;
          return (
            <button
              key={a.key}
              disabled={!!a.unavailable}
              title={a.unavailable ?? (on ? 'Click to remove from the chain' : 'Click to add to the end')}
              onClick={() => send({ type: 'toggle_finish_action', action: a.key })}
              style={{
                cursor: a.unavailable ? 'not-allowed' : 'pointer',
                borderRadius: 7,
                padding: '5px 10px',
                fontFamily: 'var(--font-body)',
                fontSize: 11.5,
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                border: `1px solid ${on ? (danger ? '#8a4f4f' : '#796cbf') : '#33364a'}`,
                background: on ? (danger ? '#2e2226' : '#2b2741') : 'transparent',
                color: on ? (danger ? '#e0a0a0' : '#d2cefd') : '#9397ab',
                textDecoration: a.unavailable ? 'line-through' : 'none',
              }}
            >
              {on && (
                <span style={{ fontSize: 9, color: danger ? '#e0a0a0' : '#b5abfc', fontVariantNumeric: 'tabular-nums' }}>
                  {position}
                </span>
              )}
              {a.label}
            </button>
          );
        })}
      </div>

      {trigger.chain.length === 0 ? (
        <div style={{ marginTop: 8, fontSize: 11, color: '#595d6c' }}>
          Nothing selected — pick one or more, and they run in the order you click.
        </div>
      ) : (
        <ol style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {trigger.chain.map((step, i) => {
            const mark = STEP_MARK[step.state];
            const atTop = i === 0;
            const atBottom = i === trigger.chain.length - 1;
            return (
              <li key={step.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ fontSize: 10, color: '#4f5364', width: 12, fontVariantNumeric: 'tabular-nums' }}>
                  {i + 1}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <button
                    disabled={atTop}
                    title={atTop ? undefined : 'Move up'}
                    onClick={() => send({ type: 'move_finish_action', action: step.key, direction: 'up' })}
                    className="btn btn-ghost"
                    style={{
                      fontSize: 9,
                      lineHeight: 1,
                      padding: '0 2px',
                      background: 'transparent',
                      border: 'none',
                      color: atTop ? '#4f5364' : '#75798c',
                      cursor: atTop ? 'default' : 'pointer',
                    }}
                  >
                    ▲
                  </button>
                  <button
                    disabled={atBottom}
                    title={atBottom ? undefined : 'Move down'}
                    onClick={() => send({ type: 'move_finish_action', action: step.key, direction: 'down' })}
                    className="btn btn-ghost"
                    style={{
                      fontSize: 9,
                      lineHeight: 1,
                      padding: '0 2px',
                      background: 'transparent',
                      border: 'none',
                      color: atBottom ? '#4f5364' : '#75798c',
                      cursor: atBottom ? 'default' : 'pointer',
                    }}
                  >
                    ▼
                  </button>
                </span>
                <span
                  style={{
                    width: 12,
                    color: mark.color,
                    fontSize: 11,
                    animation: step.state === 'running' ? 'claudia-pulse 1.2s ease-in-out infinite' : 'none',
                  }}
                >
                  {mark.icon}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 11.5, color: step.state === 'skipped' ? '#4f5364' : '#cfd3e5' }}>
                    {labelFor(step.key)}
                  </span>
                  <span
                    className="mono"
                    title={step.detail ?? step.command}
                    style={{
                      display: 'block',
                      fontSize: 10,
                      color: step.state === 'failed' ? COLORS.err : '#595d6c',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {step.detail ?? step.command}
                  </span>
                </span>
                {step.durMs !== undefined && (
                  <span style={{ fontSize: 10, color: '#595d6c', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtDur(step.durMs)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {destructiveNotLast && (
        <div style={{ marginTop: 7, fontSize: 10.5, color: COLORS.warn }}>
          ⚠ A destructive step isn't last — anything after it may never run.
        </div>
      )}
    </section>
  );
}
