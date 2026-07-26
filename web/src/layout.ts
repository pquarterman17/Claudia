import { useCallback, useEffect, useState } from 'react';

/**
 * Board layout: column count, per-tile heights and sidebar width, persisted
 * locally so the arrangement survives a reload.
 *
 * Kept in localStorage rather than server settings: it describes this screen,
 * and the same server viewed on a laptop and a large monitor should not fight
 * over one shared column count.
 */
const KEY = 'claudia.layout.v1';

export const DEFAULT_TILE_HEIGHT = 420;
export const MIN_TILE_HEIGHT = 160;
export const MAX_TILE_HEIGHT = 1400;
export const DEFAULT_SIDEBAR = 300;
export const MIN_SIDEBAR = 220;
export const MAX_SIDEBAR = 620;

/** 0 means "fit as many as the window allows". */
export type ColumnMode = 0 | 1 | 2 | 3 | 4;

export interface Layout {
  columns: ColumnMode;
  sidebarWidth: number;
  /** Per-session overrides; anything absent uses the default height. */
  heights: Record<string, number>;
}

const DEFAULT_LAYOUT: Layout = { columns: 0, sidebarWidth: DEFAULT_SIDEBAR, heights: {} };

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

function load(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return {
      columns: (parsed.columns ?? 0) as ColumnMode,
      sidebarWidth: clamp(parsed.sidebarWidth ?? DEFAULT_SIDEBAR, MIN_SIDEBAR, MAX_SIDEBAR),
      heights: parsed.heights ?? {},
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** `grid-template-columns` for a column mode. */
export function gridTemplate(columns: ColumnMode): string {
  return columns === 0 ? 'repeat(auto-fill, minmax(440px, 1fr))' : `repeat(${columns}, minmax(0, 1fr))`;
}

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      // A full or blocked localStorage must not break the board.
    }
  }, [layout]);

  const setColumns = useCallback((columns: ColumnMode) => setLayout((l) => ({ ...l, columns })), []);

  const setSidebarWidth = useCallback(
    (px: number) => setLayout((l) => ({ ...l, sidebarWidth: clamp(px, MIN_SIDEBAR, MAX_SIDEBAR) })),
    [],
  );

  const setHeight = useCallback(
    (id: string, px: number) =>
      setLayout((l) => ({
        ...l,
        heights: { ...l.heights, [id]: clamp(px, MIN_TILE_HEIGHT, MAX_TILE_HEIGHT) },
      })),
    [],
  );

  /** Arrange all: forget every per-tile height so the board is uniform again. */
  const arrangeAll = useCallback(() => setLayout((l) => ({ ...l, heights: {} })), []);

  const isArranged = Object.keys(layout.heights).length === 0;

  return { layout, setColumns, setSidebarWidth, setHeight, arrangeAll, isArranged };
}
