import { useEffect, useMemo, useRef, useState } from 'react';
import { filterActions, type PaletteAction } from '../palette';

interface Props {
  actions: PaletteAction[];
  onClose: () => void;
}

/** Ctrl/⌘K overlay: type to filter, arrows to move, Enter to run. */
export function CommandPalette({ actions, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterActions(actions, query).slice(0, 10), [actions, query]);
  // Selection resets when the list changes shape under it.
  const clamped = Math.min(selected, Math.max(0, visible.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSelected = () => {
    const action = visible[clamped];
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 40,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          width: 'min(520px, 90vw)',
          marginTop: '12vh',
          background: '#1c1e2b',
          border: '1px solid #33364a',
          borderRadius: 10,
          boxShadow: '0 6px 18px rgba(0,0,0,.35)',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a command…"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, visible.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runSelected();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: 'transparent',
            border: 0,
            outline: 'none',
            borderBottom: '1px solid #2c2f3d',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-body)',
            fontSize: 13,
            padding: '10px 12px',
          }}
        />
        <div style={{ maxHeight: 320, overflowY: 'auto', padding: 4 }}>
          {visible.map((action, i) => (
            <button
              key={action.id}
              onClick={() => {
                onClose();
                action.run();
              }}
              onMouseEnter={() => setSelected(i)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                border: 0,
                borderRadius: 6,
                padding: '6px 9px',
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                background: i === clamped ? '#2b2741' : 'transparent',
                color: i === clamped ? '#d2cefd' : '#cfd3e5',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {action.label}
              </span>
              {action.hint && <span style={{ fontSize: 10, color: '#75798c', flex: 'none' }}>{action.hint}</span>}
            </button>
          ))}
          {visible.length === 0 && (
            <div style={{ padding: '10px 9px', fontSize: 11.5, color: '#595d6c' }}>nothing matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
