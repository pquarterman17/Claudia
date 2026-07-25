import { useEffect, useState } from 'react';
import { ControllerTile } from './components/ControllerTile';
import { LaunchBar } from './components/LaunchBar';
import { SessionTile } from './components/SessionTile';
import { TopBar } from './components/TopBar';
import { store, useClaudia } from './store';

export function App() {
  const { sessions, feeds, connected, lastError, trigger } = useClaudia();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    store.connect();
  }, []);

  // One clock for every elapsed-time display, rather than a timer per tile.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);

  return (
    <div className="app">
      <TopBar sessions={sessions} connected={connected} />
      <LaunchBar />
      {lastError && (
        <div style={{ flex: 'none', padding: '6px 16px', background: '#2a2027', color: '#d98484', fontSize: 11.5 }}>
          {lastError}
        </div>
      )}
      <div className="board">
        {trigger && <ControllerTile trigger={trigger} sessions={sessions} />}
        {ordered.map((session) => (
          <SessionTile key={session.id} session={session} steps={feeds[session.id] ?? []} now={now} />
        ))}
        {ordered.length === 0 && (
          <div style={{ color: '#595d6c', fontSize: 12, padding: 20 }}>
            No sessions yet — launch one above with a working directory and a first prompt.
          </div>
        )}
      </div>
    </div>
  );
}
