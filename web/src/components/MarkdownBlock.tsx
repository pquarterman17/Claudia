import type { Segment, Span } from '../markdown-lite';

interface Props {
  segments: Segment[];
}

/** Renders markdown-lite segments as JSX — assistant transcript text only. */
export function MarkdownBlock({ segments }: Props) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'code-block') {
          return (
            <pre
              key={i}
              className="mono"
              style={{
                background: '#16182a',
                borderRadius: 6,
                padding: 8,
                overflowX: 'auto',
                fontSize: 11.5,
                margin: '4px 0',
              }}
            >
              <code>{seg.text}</code>
            </pre>
          );
        }
        if (seg.type === 'heading') {
          return (
            <div
              key={i}
              style={{ fontSize: 15 - seg.level, fontWeight: 600, margin: '6px 0 2px', color: '#e4e7f5' }}
            >
              <Spans spans={seg.spans} />
            </div>
          );
        }
        if (seg.type === 'list-item') {
          return (
            <div key={i} style={{ display: 'flex', gap: 6, margin: '1px 0' }}>
              <span style={{ color: '#75798c' }}>–</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <Spans spans={seg.spans} />
              </span>
            </div>
          );
        }
        return (
          <div key={i} style={{ margin: '2px 0' }}>
            <Spans spans={seg.spans} />
          </div>
        );
      })}
    </>
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <code
            key={i}
            className="mono"
            style={{
              background: '#16182a',
              borderRadius: 3,
              padding: '0 4px',
              fontSize: '0.92em',
              fontWeight: s.bold ? 600 : 400,
            }}
          >
            {s.text}
          </code>
        ) : s.bold ? (
          <strong key={i}>{s.text}</strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
