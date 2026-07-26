import type { PermissionLaunchMode, SessionTemplate } from '@claudia/shared';
import { useEffect, useRef, useState } from 'react';
import { onFoldersPicked, send } from '../store';

const MODES: Array<{ key: PermissionLaunchMode; label: string; title: string; danger?: boolean }> = [
  { key: 'auto', label: 'Auto', title: 'Claude decides what genuinely needs asking' },
  { key: 'default', label: 'Ask each time', title: 'Prompt for anything not already allowlisted' },
  { key: 'acceptEdits', label: 'Accept edits', title: 'Edits apply without asking; commands still prompt' },
  {
    key: 'bypassPermissions',
    label: 'Skip all',
    title: 'Every tool call runs unprompted — nothing will stop to ask you',
    danger: true,
  },
];

interface Props {
  recentDirectories: string[];
  /** Last mode used, remembered server-side so a chosen posture sticks. */
  defaultMode: PermissionLaunchMode;
  templates: SessionTemplate[];
}

const modeLabel = (mode: PermissionLaunchMode): string =>
  MODES.find((m) => m.key === mode)?.label ?? mode;

/** Launch a new Claudia-owned session: cwd + first prompt + permission mode. */
export function LaunchBar({ recentDirectories, defaultMode, templates }: Props) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionLaunchMode>(defaultMode);

  // Adopt the remembered mode once it arrives, unless already changed by hand.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setMode(defaultMode);
  }, [defaultMode]);
  const [browsing, setBrowsing] = useState(false);

  // The native dialog runs on the server; its answer arrives over the socket.
  useEffect(
    () =>
      onFoldersPicked((paths) => {
        setBrowsing(false);
        if (paths.length === 0) return;
        if (paths.length === 1) {
          setCwd(paths[0] ?? '');
          return;
        }
        // Several folders chosen: start one session in each, rather than making
        // the user launch them one at a time.
        for (const dir of paths) {
          send({
            type: 'launch_session',
            cwd: dir,
            ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
            permissionMode: mode,
          });
        }
        setCwd(paths[paths.length - 1] ?? '');
        setPrompt('');
      }),
    [prompt, mode],
  );

  // Never strand the button on "Choosing…". If the dialog is missed or the
  // picker dies, the label has to come back on its own.
  useEffect(() => {
    if (!browsing) return;
    const t = setTimeout(() => setBrowsing(false), 185_000);
    return () => clearTimeout(t);
  }, [browsing]);

  const launch = () => {
    if (!cwd.trim()) return;
    // An empty prompt is allowed: the session opens idle and waits.
    send({
      type: 'launch_session',
      cwd: cwd.trim(),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      permissionMode: mode,
    });
    setPrompt('');
  };

  const launchTemplate = (t: SessionTemplate) => {
    send({
      type: 'launch_session',
      cwd: t.cwd,
      ...(t.prompt ? { prompt: t.prompt } : {}),
      permissionMode: t.permissionMode,
    });
  };

  const saveTemplate = () => {
    const name = window.prompt('Template name')?.trim();
    if (!name) return;
    send({
      type: 'save_template',
      template: {
        name,
        cwd: cwd.trim(),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        permissionMode: mode,
      },
    });
  };

  const danger = mode === 'bypassPermissions';

  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 6,
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
        aria-label="Working directory"
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
        title="Pick a folder — ctrl-click several to start a session in each"
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
        aria-label="First prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            launch();
          }
        }}
        placeholder="first prompt (optional)…"
        style={{ flex: 1, minWidth: 120, fontSize: 11.5, padding: '4px 8px' }}
      />
      <span role="group" aria-label="Launch permission mode" style={{ display: 'flex', gap: 4, flex: 'none' }}>
        {MODES.map((m) => {
          const on = mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={on}
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
      {templates.length > 0 && (
        <span aria-label="Session templates" style={{ display: 'flex', gap: 4, flex: 'none', flexWrap: 'wrap' }}>
          {templates.map((t) => (
            <span
              key={t.name}
              style={{
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                borderRadius: 7,
                padding: '4px 6px 4px 9px',
                fontFamily: 'var(--font-body)',
                fontSize: 11,
                border: '1px solid #33364a',
                background: 'transparent',
                color: '#9397ab',
              }}
            >
              <button
                type="button"
                title={`${t.cwd} — ${modeLabel(t.permissionMode)}`}
                aria-label={`Launch template ${t.name}`}
                onClick={() => launchTemplate(t)}
                style={{
                  cursor: 'pointer', border: 0, background: 'transparent', color: 'inherit', font: 'inherit', padding: 0,
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.name}
              </button>
              <button
                type="button"
                aria-label={`Delete template ${t.name}`}
                title="delete template"
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: 'delete_template', name: t.name });
                }}
                style={{
                  cursor: 'pointer',
                  border: 0,
                  background: 'transparent',
                  color: '#9397ab',
                  fontSize: 10,
                  lineHeight: 1,
                  padding: 0, minWidth: 28, minHeight: 28,
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </span>
      )}
      <button
        className="btn btn-secondary"
        disabled={!cwd.trim()}
        title="Save current cwd, prompt, and mode as a template"
        onClick={saveTemplate}
        style={{ flex: 'none', fontSize: 11.5, padding: '4px 10px', borderColor: '#3f424d', color: '#9397ab' }}
      >
        Save…
      </button>
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
