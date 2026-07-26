import type { FeedStep, SessionSummary, TriggerStatus } from '@claudia/shared';
import { useCallback, useRef } from 'react';
import { ActivityDigest } from './ActivityDigest';
import { ControllerTile } from './ControllerTile';

interface Props {
  trigger: TriggerStatus;
  sessions: SessionSummary[];
  feeds: Record<string, FeedStep[]>;
  now: number;
  countdownSec: number;
  stopOnCloseSec: number;
  width: number;
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
}: Props) {
  const dragging = useRef(false);

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
          <ControllerTile
            trigger={trigger}
            sessions={sessions}
            countdownSec={countdownSec}
            stopOnCloseSec={stopOnCloseSec}
          />
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
