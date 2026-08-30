import type { FeedStep, SessionSummary, TriggerStatus, ToolkitAction } from '@claudia/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityDigest } from './ActivityDigest';
import { ToolkitPanel } from './ToolkitPanel';
import { ControllerTile } from './ControllerTile';

interface Props {
  trigger: TriggerStatus;
  sessions: SessionSummary[];
  feeds: Record<string, FeedStep[]>;
  now: number;
  countdownSec: number;
  stopOnCloseSec: number;
  width: number;
  toolkit: ToolkitAction[];
  focusedSessionId?: string;
  onResize: (px: number) => void;
}

/**
 * Full-height global control down the left edge.
 *
 * It was a tile in the grid, which wasted the vertical space and pushed the
 * board around as sessions came and went. Given the whole column it can also
 * carry a live digest of what every session is doing, so the board can be read
 * at a glance without visiting each tile.
 */
export function ControlSidebar({
  trigger,
  sessions,
  feeds,
  now,
  countdownSec,
  stopOnCloseSec,
  width,
  onResize,
  toolkit,
  focusedSessionId,
}: Props) {
  // Same rule as the command palette: the focused session, or the only one.
  // Two surfaces disagreeing about the target would be worse than either.
  const toolkitTarget =
    sessions.find((s) => s.id === focusedSessionId) ?? (sessions.length === 1 ? sessions[0] : undefined);
  const dragging = useRef(false);
  const active = trigger.state !== 'disarmed';
  const [automationOpen, setAutomationOpen] = useState(active);

  useEffect(() => {
    if (active) setAutomationOpen(true);
  }, [active]);

  const onGripDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const move = (ev: MouseEvent) => {
        if (dragging.current) onResize(ev.clientX);
      };
      const up = () => {
        dragging.current = false;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        // Restore text selection, suppressed during the drag.
        document.body.style.userSelect = '';
      };
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [onResize],
  );

  return (
    <>
      <div className="sidebar" style={{ width }}>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <ActivityDigest sessions={sessions} feeds={feeds} now={now} />
          <ToolkitPanel target={toolkitTarget} actions={toolkit} />
          <section>
            <button
              type="button"
              className="sidebar-section-toggle"
              aria-expanded={automationOpen}
              onClick={() => setAutomationOpen((open) => !open)}
            >
              <span>
                <span className="kicker">Automation</span>
                <span className="sidebar-section-summary">
                  {active
                    ? trigger.state
                    : `${trigger.chain.length} finish step${trigger.chain.length === 1 ? '' : 's'}`}
                </span>
              </span>
              <span aria-hidden="true">{automationOpen ? '−' : '+'}</span>
            </button>
            {automationOpen && (
              <div style={{ marginTop: 14 }}>
                <ControllerTile
                  trigger={trigger}
                  sessions={sessions}
                  countdownSec={countdownSec}
                  stopOnCloseSec={stopOnCloseSec}
                />
              </div>
            )}
          </section>
        </div>
      </div>
      <div
        className="sidebar-grip"
        onMouseDown={onGripDown}
        title="Drag to resize the panel"
        role="separator"
        aria-orientation="vertical"
      />
    </>
  );
}
