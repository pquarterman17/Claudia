import type { SessionSummary } from '@claudia/shared';
import { useState } from 'react';
import { capabilitiesFor } from '../agent-kinds';
import { send } from '../store';

interface Props {
  session: SessionSummary;
}

/**
 * A compact picker for the session's output style, mirroring the model picker
 * in Composer: a ghost button that opens a dropdown, with a check mark on the
 * style in force. Unlike the model picker there is no separate "selected but
 * unconfirmed" wire field — `set_output_style` updates `current` optimistically
 * server-side the moment it is sent, since the switch itself is synchronous
 * even though the CLI does not apply it until the next turn.
 */
export function OutputStylePicker({ session }: Props) {
  const [open, setOpen] = useState(false);
  const can = capabilitiesFor(session.agent).outputStylePicker;
  const styles = session.outputStyles;

  return (
    <span style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!can}
        title={can ? 'Pick the output style for this session' : 'This agent has no output styles'}
        onClick={() => setOpen((o) => !o)}
        style={{ fontSize: 10, padding: '2px 6px', color: '#75798c' }}
      >
        Output style
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 4,
            zIndex: 5,
            minWidth: 180,
            maxHeight: 240,
            overflowY: 'auto',
            background: '#1d1f2c',
            border: '1px solid #33364a',
            borderRadius: 6,
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
          }}
        >
          {styles === undefined && (
            <div style={{ padding: '6px 9px', fontSize: 10.5, color: '#75798c' }}>
              {can ? 'loading…' : 'not supported'}
            </div>
          )}
          {styles?.available.length === 0 && (
            <div style={{ padding: '6px 9px', fontSize: 10.5, color: '#75798c' }}>no styles reported</div>
          )}
          {styles?.available.map((style) => {
            const chosen = styles.current === style;
            return (
              <div
                key={style}
                onMouseDown={(e) => {
                  e.preventDefault();
                  send({ type: 'set_output_style', sessionId: session.id, style });
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
                  {style}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
