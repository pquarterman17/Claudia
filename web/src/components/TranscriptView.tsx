import type { TranscriptItem } from '@claudia/shared';
import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../markdown-lite';
import { MarkdownBlock } from './MarkdownBlock';

interface Props {
  items: TranscriptItem[];
  /** In-progress reply, streamed token by token — shown as a trailing pulsing block. */
  draft?: string;
}

/**
 * Full conversation transcript for one session — the terminal-parity view.
 * Where SessionFeed compresses everything to one-liners, this is the
 * conversation as Claude Code itself would show it: full text, never
 * truncated.
 */
export function TranscriptView({ items, draft }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length, draft?.length]);

  if (items.length === 0 && !draft) {
    return <div style={{ color: '#4f5364', fontSize: 11.5 }}>no messages yet…</div>;
  }

  return (
    <>
      {items.map((item, i) => (
        <TranscriptRow key={`${item.ts}-${i}`} item={item} />
      ))}
      {draft && (
        <div
          style={{
            background: '#16182a',
            borderRadius: 6,
            padding: 8,
            margin: '4px 0',
            fontSize: 12,
            color: '#b9bdd1',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {draft}
          <span style={{ animation: 'claudia-pulse 1s step-end infinite' }}>▌</span>
        </div>
      )}
      <div ref={endRef} />
    </>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'user') {
    return (
      <div
        style={{
          background: '#221f31',
          borderLeft: '2px solid #796cbf',
          borderRadius: 4,
          padding: '6px 10px',
          margin: '4px 0',
          fontSize: 12,
          color: '#e4e7f5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          width: '100%',
        }}
      >
        {item.text}
      </div>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <div style={{ fontSize: 12, color: '#cfd3e5', margin: '4px 0' }}>
        <MarkdownBlock segments={renderMarkdown(item.text)} />
      </div>
    );
  }

  if (item.kind === 'thinking') {
    return (
      <CollapsibleRow
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
        label={`thinking · ${item.text.length} chars`}
        labelStyle={{ fontStyle: 'italic', color: '#75798c' }}
      >
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: '#75798c',
            fontStyle: 'italic',
            fontSize: 11,
            margin: '4px 0',
          }}
        >
          {item.text}
        </pre>
      </CollapsibleRow>
    );
  }

  // tool_use / tool_result
  const label = item.kind === 'tool_use' ? `⚙ ${item.toolName ?? 'tool'}` : `→ result · ${item.text.length} chars`;
  return (
    <CollapsibleRow expanded={expanded} onToggle={() => setExpanded((e) => !e)} label={label} mono>
      <pre
        className="mono"
        style={{
          maxHeight: 260,
          overflow: 'auto',
          fontSize: 11,
          background: '#16182a',
          borderRadius: 6,
          padding: 8,
          margin: '4px 0',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {item.text}
      </pre>
    </CollapsibleRow>
  );
}

interface CollapsibleRowProps {
  expanded: boolean;
  onToggle: () => void;
  label: string;
  mono?: boolean;
  labelStyle?: React.CSSProperties;
  children: React.ReactNode;
}

/** A one-line collapsed summary that expands to its full content on click. */
function CollapsibleRow({ expanded, onToggle, label, mono, labelStyle, children }: CollapsibleRowProps) {
  return (
    <div style={{ margin: '2px 0' }}>
      <button
        className={mono ? 'btn btn-ghost mono' : 'btn btn-ghost'}
        onClick={onToggle}
        style={{
          fontSize: 11,
          color: '#75798c',
          padding: 0,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          ...labelStyle,
        }}
      >
        {label}
      </button>
      {expanded && children}
    </div>
  );
}
