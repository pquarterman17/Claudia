import { useEffect, useRef } from 'react';
import type { UsageSnapshot } from '@claudia/shared';
import { UsagePanel, usageHeadline } from './UsagePanel';

interface Props {
  usage: UsageSnapshot;
  customCeilings?: { sessionTokens: number; weeklyTokens: number };
  onClose: () => void;
}

function summary(usage: UsageSnapshot) {
  const window = usage.windows[0];
  if (!window) return 'No usage data yet';
  const { value, suffix } = usageHeadline(window);
  return suffix === 'typical' ? `${value} typical` : `${value} ${suffix}`;
}

/** A modal surface so usage details never steal height from the session board. */
export function UsageDrawer({ usage, customCeilings, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="usage-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        aria-describedby="usage-drawer-description"
        aria-labelledby="usage-drawer-title"
        aria-modal="true"
        className="usage-drawer"
        role="dialog"
      >
        <header className="usage-drawer-header">
          <div>
            <div className="kicker">Usage estimate</div>
            <h2 id="usage-drawer-title">{summary(usage)}</h2>
            <p id="usage-drawer-description">Local session history, not a live plan allowance.</p>
          </div>
          <button ref={closeRef} className="usage-close" onClick={onClose} type="button">
            Close <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="usage-drawer-content">
          <UsagePanel usage={usage} customCeilings={customCeilings} />
        </div>
      </section>
    </div>
  );
}
