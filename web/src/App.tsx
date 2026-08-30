import type { SessionSummary } from '@claudia/shared';
import { useEffect, useRef, useState } from 'react';
import { BoardControls } from './components/BoardControls';
import { ControlSidebar } from './components/ControlSidebar';
import { LaunchBar } from './components/LaunchBar';
import { DebateStrip } from './components/DebateStrip';
import { ObservedStrip } from './components/ObservedStrip';
import { SessionTile } from './components/SessionTile';
import { StatusFooter } from './components/StatusFooter';
import { TopBar } from './components/TopBar';
import { UsageDrawer } from './components/UsageDrawer';
import { CommandPalette } from './components/CommandPalette';
import { autoRows, DEFAULT_TILE_HEIGHT, gridTemplate, useLayout } from './layout';
import { buildPaletteActions } from './palette';
import { newlyNeedingAttention, notificationsEnabled, notify, stateMap } from './notifications';
import { orderSessions } from './session-order';
import { oldestPendingApproval, resolveShortcut } from './shortcuts';
import { send, store, useClaudia } from './store';

export function App() {
  const {
    sessions,
    feeds,
    drafts,
    transcripts,
    connected,
    lastError,
    lastNotice,
    observed,
    monitoring,
    debates,
    trigger,
    usage,
    recentDirectories,
    countdownSec,
    platform,
    stopSessionsWhenClosedSec,
    defaultPermissionMode,
    templates,
    toolkit,
    customCeilings,
    savedSessions,
    checkpoints,
    mcp,
    effectiveSettings,
  } = useClaudia();
  const [now, setNow] = useState(() => Date.now());
  const [usageOpen, setUsageOpen] = useState(false);
  const [focused, setFocused] = useState<string | undefined>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const lastStates = useRef(new Map<string, string>());
  const {
    layout,
    setColumns,
    setSizeMode,
    setAttentionFirst,
    setSidebarOpen,
    setSidebarWidth,
    setHeight,
    arrangeAll,
    isArranged,
  } = useLayout();
  const fitting = layout.sizeMode === 'fit';

  useEffect(() => {
    store.connect();
  }, []);

  // One clock for every elapsed-time display, rather than a timer per tile.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ordered = orderSessions(sessions, layout.attentionFirst);

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
      if (action.kind === 'open_palette') {
        // preventDefault must win over the browser's own Ctrl+K behavior.
        e.preventDefault();
        setPaletteOpen(true);
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
      {usageOpen && usage && (
        <UsageDrawer usage={usage} customCeilings={customCeilings} sessions={sessions} onClose={() => setUsageOpen(false)} />
      )}
      <LaunchBar
        recentDirectories={recentDirectories}
        defaultMode={defaultPermissionMode}
        templates={templates}
        savedSessions={savedSessions}
        checkpoints={checkpoints}
        platform={platform}
      />
      {(lastError ?? lastNotice) && (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 16px',
            background: lastError ? '#2a2027' : '#1f2430',
            color: lastError ? '#d98484' : '#9fb2d8',
            fontSize: 11.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{lastError ?? lastNotice}</span>
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
        {trigger && ordered.length > 0 && layout.sidebarOpen && (
          <ControlSidebar
            trigger={trigger}
            sessions={sessions}
            feeds={feeds}
            now={now}
            countdownSec={countdownSec}
            stopOnCloseSec={stopSessionsWhenClosedSec}
            width={layout.sidebarWidth}
            onResize={setSidebarWidth}
            toolkit={toolkit}
            focusedSessionId={focused}
          />
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {ordered.length > 0 && (
            <BoardControls
              columns={layout.columns}
              onColumns={setColumns}
              sizeMode={layout.sizeMode}
              onSizeMode={setSizeMode}
              onArrangeAll={arrangeAll}
              sidebarOpen={layout.sidebarOpen}
              onToggleSidebar={() => setSidebarOpen(!layout.sidebarOpen)}
              attentionFirst={layout.attentionFirst}
              onToggleAttentionFirst={() => setAttentionFirst(!layout.attentionFirst)}
              arranged={isArranged}
              sessionCount={ordered.length}
            />
          )}
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
                transcript={transcripts[session.id] ?? []}
                draft={drafts[session.id]}
                now={now}
                index={i}
                focused={focused === session.id}
                height={fitting ? undefined : (layout.heights[session.id] ?? DEFAULT_TILE_HEIGHT)}
                onResize={(px) => setHeight(session.id, px)}
                checkpoints={session.claudeSessionId ? (checkpoints[session.claudeSessionId] ?? []) : []}
                mcp={mcp[session.id]}
                effectiveSettings={effectiveSettings[session.id]}
              />
            ))}
            {ordered.length === 0 && (
              <div className="empty-state">
                <span className="kicker">Start here</span>
                <h1>Launch your first session</h1>
                <p>Choose a repository above, add a task if you have one, then launch.</p>
                <ol>
                  <li>Paste a path or browse for a folder</li>
                  <li>Optionally describe the first task</li>
                  <li>Launch — an empty task simply waits for you</li>
                </ol>
              </div>
            )}
          </div>
          <DebateStrip debates={debates} sessions={ordered} />
          <ObservedStrip observed={observed} monitoring={monitoring} now={now} />
        </div>
      </div>

      <StatusFooter sessions={sessions} platform={platform} />

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          actions={buildPaletteActions({
            sessions: ordered,
            toolkit,
            focusedSessionId: focused,
            runToolkitAction: (sessionId, action) =>
              send({ type: 'send_prompt', sessionId, text: action.prompt }),
            focusSession: (id) => {
              document.getElementById(`session-${id}`)?.scrollIntoView({ block: 'nearest' });
              setFocused(id);
            },
            approveOldest: (() => {
              const target = oldestPendingApproval(sessions);
              if (!target?.pendingApproval) return null;
              const req = target.pendingApproval.requestId;
              return () => send({ type: 'approve', sessionId: target.id, requestId: req });
            })(),
            toggleUsage: () => setUsageOpen((v) => !v),
            setSizeMode,
            setColumns,
            arrangeAll,
            recentDirectories,
            defaultPermissionMode,
            launch: (cwd) => send({ type: 'launch_session', cwd, permissionMode: defaultPermissionMode }),
          })}
        />
      )}
    </div>
  );
}
