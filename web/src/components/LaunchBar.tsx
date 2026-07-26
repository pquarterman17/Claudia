import type { PermissionLaunchMode } from '@claudia/shared';
import { useEffect, useState } from 'react';
import { onFolderPicked, send } from '../store';

const MODES: Array<{ key: PermissionLaunchMode; label: string; danger?: boolean }> = [
  { key: 'default', label: 'Ask each time' },
  { key: 'acceptEdits', label: 'Auto-accept edits' },
  { key: 'bypassPermissions', label: 'Skip all permissions', danger: true },
];

interface Props {
  recentDirectories: string[];
}

/** Launch a new Claudia-owned session: cwd + first prompt + permission mode. */
export function LaunchBar({ recentDirectories }: Props) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionLaunchMode>('default');
  const [browsing, setBrowsing] = useState(false);

  // The native dialog runs on the server; its answer arrives over the socket.
  useEffect(
    () =>
      onFolderPicked((path) => {
        setBrowsing(false);
        if (path) setCwd(path);
      }),
    [],
  );

  // Never strand the button on "Choosing…". If the dialog is missed or the
  // picker dies, the label has to come back on its own.
  useEffect(() => {
    if (!browsing) return;
    const t = setTimeout(() => setBrowsing(false), 185_000);
    return () => clearTimeout(t);
  }, [browsing]);

  const launch = () => {
    if (!cwd.trim() || !prompt.trim()) return;
    send({ type: 'launch_session', cwd: cwd.trim(), prompt: prompt.trim(), permissionMode: mode });
    setPrompt('');
  };

  const danger = mode === 'bypassPermissions';

  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid #2c2f3d',
        background: '#1c1e2b',
      }}
    >
      <span className="kicker" style={{ flex: 'none' }}>
        New session
      </span>
      <input
        className="input mono"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        // Windows "Copy as path" wraps in quotes; strip them so a paste just works.
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text').trim().replace(/^["']|["']$/g, '');
          if (pasted) {
            e.preventDefault();
            setCwd(pasted);
          }
        }}
        list="claudia-recent-dirs"
        placeholder="paste a path, or browse…"
        style={{ flex: '0 1 300px', fontSize: 11.5, padding: '4px 8px' }}
      />
      <datalist id="claudia-recent-dirs">
        {recentDirectories.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <button
        className="btn btn-secondary"
        disabled={browsing}
        title="Open a folder picker on this machine (look for it in front of the browser)"
        onClick={() => {
          setBrowsing(true);
          send({ type: 'browse_folder' });
        }}
        style={{ flex: 'none', fontSize: 11.5, padding: '4px 10px', borderColor: '#3f424d', color: '#9397ab' }}
      >
        {browsing ? 'Choosing…' : 'Browse'}
      </button>
      <input
        className="input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            launch();
          }
        }}
        placeholder="first prompt…"
        style={{ flex: 1, minWidth: 120, fontSize: 11.5, padding: '4px 8px' }}
      />
      <span style={{ display: 'flex', gap: 4, flex: 'none' }}>
        {MODES.map((m) => {
          const on = mode === m.key;
          return (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              style={{
                cursor: 'pointer',
                borderRadius: 7,
                padding: '4px 9px',
                fontFamily: 'var(--font-body)',
                fontSize: 11,
                whiteSpace: 'nowrap',
                border: `1px solid ${on ? (m.danger ? '#8a4f4f' : '#796cbf') : '#33364a'}`,
                background: on ? (m.danger ? '#2e2226' : '#2b2741') : 'transparent',
                color: on ? (m.danger ? '#e0a0a0' : '#d2cefd') : '#9397ab',
              }}
            >
              {m.label}
            </button>
          );
        })}
      </span>
      <button
        className="btn btn-primary"
        onClick={launch}
        style={{ flex: 'none', fontSize: 11.5, padding: '4px 12px', borderColor: danger ? '#d98484' : '#9184d9' }}
      >
        + Launch
      </button>
    </div>
  );
}
