import type { SessionSummary } from '@claudia/shared';
import { useEffect, useRef, useState } from 'react';
import { BoardControls } from './components/BoardControls';
import { ControlSidebar } from './components/ControlSidebar';
import { LaunchBar } from './components/LaunchBar';
import { SessionTile } from './components/SessionTile';
import { StatusFooter } from './components/StatusFooter';
import { TopBar } from './components/TopBar';
import { UsagePanel } from './components/UsagePanel';
import { autoRows, DEFAULT_TILE_HEIGHT, gridTemplate, useLayout } from './layout';
import { newlyNeedingAttention, notificationsEnabled, notify, stateMap } from './notifications';
import { oldestPendingApproval, resolveShortcut } from './shortcuts';
import { send, store, useClaudia } from './store';

export function App() {
  const {
    sessions,
    feeds,
    connected,
    lastError,
    trigger,
    usage,
    recentDirectories,
    countdownSec,
    platform,
    stopSessionsWhenClosedSec,
    defaultPermissionMode,
    templates,
  } = useClaudia();
  const [now, setNow] = useState(() => Date.now());
  const [usageOpen, setUsageOpen] = useState(false);
  const [focused, setFocused] = useState<string | undefined>();
  const lastStates = useRef(new Map<string, string>());
  const { layout, setColumns, setSizeMode, setSidebarWidth, setHeight, arrangeAll, isArranged } =
    useLayout();
  const fitting = layout.sizeMode === 'fit';

  useEffect(() => {
    store.connect();
  }, []);

  // One clock for every elapsed-time display, rather than a timer per tile.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);

  // Tell the user when a session needs them, but only on the transition and
  // only when they are not already looking at the window.
  useEffect(() => {
    if (notificationsEnabled()) {
      for (const event of newlyNeedingAttention(lastStates.current, sessions)) {
        notify(event, (id) => {
          document.getElementById(`session-${id}`)?.scrollIntoView({ block: 'nearest' });
          setFocused(id);
        });
      }
    }
    lastStates.current = stateMap(sessions);
  }, [sessions]);

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
      <LaunchBar
        recentDirectories={recentDirectories}
        defaultMode={defaultPermissionMode}
        templates={templates}
      />
      {lastError && (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 16px',
            background: '#2a2027',
            color: '#d98484',
            fontSize: 11.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{lastError}</span>
          <button
            onClick={() => store.clearError()}
            title="Dismiss"
            style={{
              cursor: 'pointer',
              border: 0,
              background: 'transparent',
              color: '#9397ab',
              fontSize: 12,
              padding: '0 4px',
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="workspace">
        {trigger && (
          <ControlSidebar
            trigger={trigger}
            sessions={sessions}
            feeds={feeds}
            now={now}
            countdownSec={countdownSec}
            stopOnCloseSec={stopSessionsWhenClosedSec}
            width={layout.sidebarWidth}
            onResize={setSidebarWidth}
          />
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <BoardControls
            columns={layout.columns}
            onColumns={setColumns}
            sizeMode={layout.sizeMode}
            onSizeMode={setSizeMode}
            onArrangeAll={arrangeAll}
            arranged={isArranged}
            sessionCount={ordered.length}
          />
          <div
            className={fitting ? 'board board-fit' : 'board'}
            style={{
              gridTemplateColumns: gridTemplate(layout.columns, layout.sizeMode, ordered.length),
              // Equal shares of the visible area, so the board always fills it.
              ...(fitting
                ? { gridTemplateRows: `repeat(${autoRows(ordered.length, layout.columns)}, minmax(0, 1fr))` }
                : {}),
            }}
          >
            {ordered.map((session, i) => (
              <SessionTile
                key={session.id}
                session={session}
                steps={feeds[session.id] ?? []}
                now={now}
                index={i}
                focused={focused === session.id}
                height={fitting ? undefined : (layout.heights[session.id] ?? DEFAULT_TILE_HEIGHT)}
                onResize={(px) => setHeight(session.id, px)}
              />
            ))}
            {ordered.length === 0 && (
              <div style={{ color: '#595d6c', fontSize: 12, padding: 20 }}>
                No sessions yet — pick a working directory above and hit Launch. A first prompt is
                optional; the session will wait for you.
              </div>
            )}
          </div>
        </div>
      </div>

      <StatusFooter sessions={sessions} platform={platform} />
    </div>
  );
}
