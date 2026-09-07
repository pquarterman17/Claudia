import { useState } from 'react';
import type { SessionSummary } from '@claudia/shared';
import { capabilitiesFor } from '../agent-kinds';
import { COLORS } from '../status';
import { send, useClaudia } from '../store';
import { useDismiss } from '../use-dismiss';

/**
 * Which model this session's next turn runs on.
 *
 * Split out of the composer, which had grown past the repository's size
 * ceiling carrying it. The picker owns three things nothing else in the
 * composer touches — an open flag, a fetch that only the server can answer,
 * and the empty state that fetch can legitimately produce — and keeping them
 * together is what makes the refetch rule below readable at all.
 */
export function ModelPicker({ session }: { session: SessionSummary }) {
  const { models } = useClaudia();
  const [open, setOpen] = useState(false);
  const wrap = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const can = capabilitiesFor(session.agent);
  const choices = models[session.id];


  const toggle = () => {
    // Asked again whenever the list is EMPTY, not only when it has never been
    // asked for. A session launched without a first prompt has no driver, so
    // the server answers with nothing — and caching that as though it were the
    // final word left "no models reported" on screen for the life of the tile,
    // including long after the session had started and could have answered.
    if (!open && (choices === undefined || choices.length === 0)) {
      send({ type: 'get_models', sessionId: session.id });
    }
    setOpen((was) => !was);
  };

  return (
    <span ref={wrap} style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!can.modelPicker}
        aria-expanded={open}
        aria-haspopup="menu"
        title={can.modelPicker ? 'Pick the model for this session' : 'This agent has no model picker'}
        onClick={toggle}
        style={{ fontSize: 10, padding: '2px 6px', color: '#75798c' }}
      >
        Choose model
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Models"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 4,
            zIndex: 5,
            minWidth: 210,
            maxHeight: 240,
            overflowY: 'auto',
            background: '#1d1f2c',
            border: '1px solid #33364a',
            borderRadius: 6,
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
          }}
        >
          {choices === undefined && (
            <div style={{ padding: '6px 9px', fontSize: 10.5, color: '#75798c' }}>loading…</div>
          )}
          {choices?.length === 0 && (
            // Says that reopening may help, rather than guessing WHY it is
            // empty. The list comes from the agent's live query, which exists
            // only once a turn has begun — but nothing the browser holds
            // distinguishes "no driver yet" from "this agent offers none", and
            // a message that picked one would be confidently wrong half the
            // time. Reopening re-asks, which is the action either way.
            <div style={{ padding: '6px 9px', fontSize: 10.5, color: '#75798c' }}>
              no models reported yet — reopen once this session is running
            </div>
          )}
          {choices?.map((m) => {
            // Marks the pick the moment it is made. Without this the menu
            // looked inert, because a switch does not reach the chip until the
            // next turn reports which model actually ran.
            const chosen = session.selectedModel === m.value;
            return (
              <div
                key={m.value}
                role="menuitemradio"
                aria-checked={chosen}
                onMouseDown={(e) => {
                  e.preventDefault();
                  send({ type: 'set_model', sessionId: session.id, model: m.value });
                  setOpen(false);
                }}
                style={{
                  padding: '5px 9px',
                  cursor: 'pointer',
                  borderBottom: '1px solid #26293a',
                  background: chosen ? '#2b2741' : 'transparent',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 600, color: chosen ? '#d2cefd' : '#e4e7f5' }}>
                  {chosen ? '✓ ' : ''}
                  {m.displayName}
                  {chosen && <span style={{ color: COLORS.warn, fontWeight: 400 }}> · next turn</span>}
                </div>
                {m.description && <div style={{ fontSize: 9.5, color: '#75798c' }}>{m.description}</div>}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
