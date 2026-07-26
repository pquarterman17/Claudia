import type { ColumnMode, SizeMode } from '../layout';

const MODES: Array<{ value: ColumnMode; label: string; title: string }> = [
  { value: 0, label: 'Auto', title: 'Fit as many columns as the window allows' },
  { value: 1, label: '1', title: 'One column' },
  { value: 2, label: '2', title: 'Two columns' },
  { value: 3, label: '3', title: 'Three columns' },
  { value: 4, label: '4', title: 'Four columns' },
];

interface Props {
  columns: ColumnMode;
  onColumns: (c: ColumnMode) => void;
  sizeMode: SizeMode;
  onSizeMode: (m: SizeMode) => void;
  onArrangeAll: () => void;
  /** True when no tile has been resized, so Arrange all would do nothing. */
  arranged: boolean;
  sessionCount: number;
}

/** Column choice and the reset that puts every tile back to a uniform size. */
export function BoardControls({
  columns,
  onColumns,
  sizeMode,
  onSizeMode,
  onArrangeAll,
  arranged,
  sessionCount,
}: Props) {
  const fitting = sizeMode === 'fit';
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderBottom: '1px solid #2c2f3d',
        background: '#191b28',
      }}
    >
      <span className="kicker">Board</span>
      <span style={{ display: 'flex', gap: 2, border: '1px solid #33364a', borderRadius: 7, padding: 2 }}>
        {MODES.map((m) => {
          const on = columns === m.value;
          return (
            <button
              key={m.label}
              title={m.title}
              onClick={() => onColumns(m.value)}
              style={{
                cursor: 'pointer',
                border: 0,
                borderRadius: 5,
                padding: '2px 9px',
                fontFamily: 'var(--font-body)',
                fontSize: 11,
                background: on ? '#2b2741' : 'transparent',
                color: on ? '#d2cefd' : '#9397ab',
              }}
            >
              {m.label}
            </button>
          );
        })}
      </span>

      <span style={{ display: 'flex', gap: 2, border: '1px solid #33364a', borderRadius: 7, padding: 2 }}>
        {(
          [
            { m: 'fit' as SizeMode, label: 'Fill', title: 'Divide the window between the sessions' },
            { m: 'scroll' as SizeMode, label: 'Scroll', title: 'Fixed tile heights; the board scrolls' },
          ]
        ).map((o) => {
          const on = sizeMode === o.m;
          return (
            <button
              key={o.m}
              title={o.title}
              onClick={() => onSizeMode(o.m)}
              style={{
                cursor: 'pointer',
                border: 0,
                borderRadius: 5,
                padding: '2px 9px',
                fontFamily: 'var(--font-body)',
                fontSize: 11,
                background: on ? '#2b2741' : 'transparent',
                color: on ? '#d2cefd' : '#9397ab',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </span>

      <button
        onClick={onArrangeAll}
        disabled={arranged || fitting}
        title={
          fitting
            ? 'Fill mode already sizes every tile equally'
            : arranged
              ? 'Every tile is already the default size'
              : 'Reset all tiles to a uniform height'
        }
        className="btn btn-secondary"
        style={{
          fontSize: 11,
          padding: '3px 10px',
          borderColor: '#3f424d',
          color: arranged || fitting ? '#4f5364' : '#9397ab',
        }}
      >
        Arrange all
      </button>

      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 10.5, color: '#595d6c' }}>
        {sessionCount === 0 ? 'no sessions' : `${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
        {fitting ? ' · filling the window' : ' · drag a tile’s bottom edge to resize'}
      </span>
    </div>
  );
}
