import type { EffortLevel, SessionSummary, ThinkingMode } from '@claudia/shared';
import { useState } from 'react';
import { send } from '../store';

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function ReasoningControls({ session }: { session: SessionSummary }) {
  const [open, setOpen] = useState(false);
  const setEffort = (effortLevel: EffortLevel) => send({ type: 'set_effort', sessionId: session.id, effortLevel });
  const setThinking = (thinkingMode: ThinkingMode) => send({ type: 'set_thinking', sessionId: session.id, thinkingMode });
  return (
    <span style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        className="btn btn-ghost"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Set reasoning effort and thinking mode"
        onClick={() => setOpen((value) => !value)}
        style={{ fontSize: 10, padding: '2px 6px', color: '#75798c' }}
      >
        Reasoning: {session.effortLevel}
      </button>
      {open && (
        <div role="menu" aria-label="Reasoning controls" style={{ position: 'absolute', bottom: '100%', right: 0, marginBottom: 4, zIndex: 6, minWidth: 190, padding: 5, background: '#1d1f2c', border: '1px solid #33364a', borderRadius: 6, boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)' }}>
          <div style={{ padding: '3px 5px', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', color: '#595d6c' }}>Effort</div>
          <div role="group" aria-label="Effort level" style={{ display: 'flex', gap: 2, padding: '2px 3px 6px' }}>
            {EFFORTS.map((effort) => (
              <button key={effort} type="button" className="btn btn-ghost" aria-pressed={session.effortLevel === effort} onClick={() => setEffort(effort)} style={{ padding: '3px 5px', fontSize: 9.5, color: session.effortLevel === effort ? '#d2cefd' : '#75798c', border: `1px solid ${session.effortLevel === effort ? '#423a6a' : 'transparent'}` }}>{effort}</button>
            ))}
          </div>
          <div style={{ padding: '3px 5px', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', color: '#595d6c' }}>Thinking</div>
          {(['adaptive', 'disabled'] as ThinkingMode[]).map((mode) => (
            <button key={mode} type="button" role="menuitemradio" aria-checked={session.thinkingMode === mode} className="btn btn-ghost" onClick={() => { setThinking(mode); setOpen(false); }} style={{ display: 'block', width: '100%', padding: '4px 6px', textAlign: 'left', fontSize: 10.5, color: session.thinkingMode === mode ? '#d2cefd' : '#a4a8b8' }}>{session.thinkingMode === mode ? '✓ ' : ''}{mode === 'adaptive' ? 'Adaptive' : 'Off'}</button>
          ))}
        </div>
      )}
    </span>
  );
}
