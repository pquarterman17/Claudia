import type { EffectiveSettings, McpServerInfo, SessionSummary } from '@claudia/shared';
import { useEffect, useState } from 'react';
import { send } from '../store';

export function OperationsPanel({ session, servers, settings }: { session: SessionSummary; servers?: McpServerInfo[]; settings?: EffectiveSettings }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) send({ type: 'get_mcp_status', sessionId: session.id }); }, [open, session.id]);
  return <section style={{ borderTop: '1px solid #303344', marginTop: 10, paddingTop: 8 }}>
    <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>Operations {servers?.some((s) => s.status === 'failed') ? '• attention' : ''}</button>
    {open && <div style={{ display: 'grid', gap: 7, marginTop: 8, fontSize: 11 }}>
      {(servers ?? []).length === 0 ? <span className="muted">No MCP servers reported for this session.</span> : servers?.map((server) => <div key={server.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span title={server.error} style={{ color: server.status === 'connected' ? '#85b58b' : '#d8a46a' }}>{server.status}</span><span style={{ flex: 1 }}>{server.name} {server.toolCount ? `(${server.toolCount})` : ''}</span>
        {server.status !== 'connected' && server.status !== 'disabled' && <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'reconnect_mcp', sessionId: session.id, serverName: server.name })}>Reconnect</button>}
        <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'toggle_mcp', sessionId: session.id, serverName: server.name, enabled: server.status === 'disabled' })}>{server.status === 'disabled' ? 'Enable' : 'Disable'}</button>
      </div>)}
      <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'get_effective_settings', sessionId: session.id })}>Inspect effective settings</button>
      {settings && <details><summary>Settings: {Object.keys(settings.effective).length} effective keys</summary><div className="muted">{settings.sources.map((s) => `${s.source}${s.path ? `: ${s.path}` : ''}`).join(' · ')}</div><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{JSON.stringify({ effective: settings.effective, provenance: settings.provenance }, null, 2)}</pre></details>}
    </div>}
  </section>;
}
