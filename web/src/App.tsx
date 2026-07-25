import { useEffect, useState } from 'react';
import { ControllerTile } from './components/ControllerTile';
import { LaunchBar } from './components/LaunchBar';
import { SessionTile } from './components/SessionTile';
import { TopBar } from './components/TopBar';
import { UsagePanel } from './components/UsagePanel';
import { oldestPendingApproval, resolveShortcut } from './shortcuts';
import { send, store, useClaudia } from './store';
import { StatusFooter } from './components/StatusFooter';

export function App() {
  const { sessions, feeds, connected, lastError, trigger, usage, recentDirectories, countdownSec, platform } =
    useClaudia();
  const [now, setNow] = useState(() => Date.now());
  const [usageOpen, setUsageOpen] = useState(false);
  const [focused, setFocused] = useState<string | undefined>();

  useEffect(() => {
    store.connect();
  }, []);

  // One clock for every elapsed-time display, rather than a timer per tile.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          targetTag: (e.target as HTMLElement | null)?.tagName,
        },
        platform,
      );
      if (!action) return;

      if (action.kind === 'approve_oldest') {
        const target = oldestPendingApproval(sessions);
        if (!target?.pendingApproval) return;
        e.preventDefault();
        send({ type: 'approve', sessionId: target.id, requestId: target.pendingApproval.requestId });
        return;
      }
      if (action.kind === 'toggle_usage') {
        e.preventDefault();
        setUsageOpen((v) => !v);
        return;
      }
      const target = ordered[action.index];
      if (target) {
        e.preventDefault();
        document.getElementById(`session-${target.id}`)?.scrollIntoView({ block: 'nearest' });
        setFocused(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, ordered, platform]);

  return (
    <div className="app">
      <TopBar
        sessions={sessions}
        connected={connected}
        usage={usage}
        usageOpen={usageOpen}
        onToggleUsage={() => setUsageOpen((v) => !v)}
      />
      {usageOpen && usage && <UsagePanel usage={usage} />}
      <LaunchBar recentDirectories={recentDirectories} />
      {lastError && (
        <div style={{ flex: 'none', padding: '6px 16px', background: '#2a2027', color: '#d98484', fontSize: 11.5 }}>
          {lastError}
        </div>
      )}
      <div className="board">
        {trigger && <ControllerTile trigger={trigger} sessions={sessions} countdownSec={countdownSec} />}
        {ordered.map((session, i) => (
          <SessionTile
            key={session.id}
            session={session}
            steps={feeds[session.id] ?? []}
            now={now}
            index={i}
            focused={focused === session.id}
          />
        ))}
        {ordered.length === 0 && (
          <div style={{ color: '#595d6c', fontSize: 12, padding: 20 }}>
            No sessions yet — launch one above with a working directory and a first prompt.
          </div>
        )}
      </div>
      <StatusFooter sessions={sessions} platform={platform} />
    </div>
  );
}
