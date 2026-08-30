import type { FileMatch } from '@claudia/shared';

interface Props {
  matches: FileMatch[];
  onSelect: (path: string) => void;
}

/**
 * Dropdown shown above the composer input while typing an @-mention. Same
 * positioning and styling as the slash-command dropdown it sits beside in
 * Composer.tsx, kept as its own component only because the pair of dropdowns
 * plus the token-tracking logic no longer fit in one file under the size
 * ratchet.
 */
export function MentionDropdown({ matches, onSelect }: Props) {
  if (matches.length === 0) return null;
  return (
    <div
      className="mono"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        zIndex: 5,
        minWidth: 180,
        maxWidth: 420,
        background: '#1d1f2c',
        border: '1px solid #33364a',
        borderRadius: 6,
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
        overflow: 'hidden',
      }}
    >
      {matches.map((m) => (
        <div
          key={m.path}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(m.path);
          }}
          style={{
            padding: '4px 9px',
            fontSize: 11,
            cursor: 'pointer',
            color: '#cfd3e5',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {m.path}
        </div>
      ))}
      <div
        style={{
          padding: '3px 9px',
          fontSize: 9,
          color: '#595d6c',
          borderTop: '1px solid #2c2f3d',
          fontFamily: 'var(--font-body)',
        }}
      >
        inserts the file path
      </div>
    </div>
  );
}
