import type { FeedStep } from '@claudia/shared';
import { useEffect, useRef } from 'react';
import { fmtDur } from '../format';
import { COLORS, FEED_ICONS } from '../status';

interface Props {
  steps: FeedStep[];
}

/** The abstracted activity feed for one session — reads, edits, commands, results. */
export function SessionFeed({ steps }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [steps.length]);

  if (steps.length === 0) {
    return <div style={{ color: '#4f5364', fontSize: 11.5 }}>waiting for first event…</div>;
  }

  return (
    <>
      {steps.map((step) => {
        const base = FEED_ICONS[step.kind] ?? FEED_ICONS['info']!;
        // A finished tool call reports its outcome; a running one keeps its
        // tool icon and pulses so it reads as in-flight rather than stalled.
        const icon = step.status === 'ok' ? '✓' : step.status === 'error' ? '✕' : base.icon;
        const color =
          step.status === 'ok' ? COLORS.ok : step.status === 'error' ? COLORS.err : base.color;
        return (
          <div key={step.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <span
              style={{
                width: 16,
                textAlign: 'center',
                color,
                fontSize: 11,
                flex: 'none',
                marginTop: 1,
                animation: step.status === 'running' ? 'claudia-pulse 1.4s ease-in-out infinite' : 'none',
              }}
            >
              {icon}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12, color: '#e4e7f5', wordBreak: 'break-word' }}>
                {step.title}
              </span>
              {step.meta && (
                <span
                  className="mono"
                  style={{ display: 'block', fontSize: 11, color: '#75798c', marginTop: 1, wordBreak: 'break-all' }}
                >
                  {step.meta}
                </span>
              )}
            </span>
            {step.durMs !== undefined && (
              <span style={{ fontSize: 10.5, color: '#595d6c', fontVariantNumeric: 'tabular-nums' }}>
                {fmtDur(step.durMs)}
              </span>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </>
  );
}
