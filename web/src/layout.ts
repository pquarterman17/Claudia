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

/**
 * 'fit' divides the visible area between the sessions — 2 become halves, 4
 * become quadrants — so the board always uses the whole window. 'scroll' keeps
 * tiles at a fixed height and lets the board scroll, which is better when there
 * are many sessions and each needs room to read.
 */
export type SizeMode = 'fit' | 'scroll';

export const defaultSidebarOpen = (viewportWidth: number): boolean => viewportWidth >= 1200;

export interface Layout {
  columns: ColumnMode;
  sizeMode: SizeMode;
  attentionFirst: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** Per-session overrides; anything absent uses the default height. */
  heights: Record<string, number>;
}

const DEFAULT_LAYOUT: Layout = {
  columns: 0,
  sizeMode: 'fit',
  attentionFirst: true,
  sidebarOpen: typeof window === 'undefined' ? true : defaultSidebarOpen(window.innerWidth),
  sidebarWidth: DEFAULT_SIDEBAR,
  heights: {},
};

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

function load(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return {
      columns: (parsed.columns ?? 0) as ColumnMode,
      sizeMode: parsed.sizeMode === 'scroll' ? 'scroll' : 'fit',
      attentionFirst: parsed.attentionFirst ?? true,
      sidebarOpen: parsed.sidebarOpen ?? DEFAULT_LAYOUT.sidebarOpen,
      sidebarWidth: clamp(parsed.sidebarWidth ?? DEFAULT_SIDEBAR, MIN_SIDEBAR, MAX_SIDEBAR),
      heights: parsed.heights ?? {},
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** `grid-template-columns` for a column mode. */
export function gridTemplate(columns: ColumnMode, sizeMode: SizeMode, count: number): string {
  if (columns !== 0) return `repeat(${columns}, minmax(0, 1fr))`;
  // Fitting the window means choosing a near-square arrangement: 2 side by
  // side, 4 as quadrants, 6 as 3x2 — rather than as many 440px columns as fit.
  if (sizeMode === 'fit') return `repeat(${autoColumns(count)}, minmax(0, 1fr))`;
  return 'repeat(auto-fill, minmax(440px, 1fr))';
}

/** Columns for a near-square grid of n tiles, capped so tiles stay readable. */
export function autoColumns(count: number): number {
  if (count <= 1) return 1;
  return Math.min(4, Math.ceil(Math.sqrt(count)));
}

/** Rows the fitted grid will occupy, so each can be given an equal share. */
export function autoRows(count: number, columns: ColumnMode): number {
  const cols = columns === 0 ? autoColumns(count) : columns;
  return Math.max(1, Math.ceil(count / cols));
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

  const setSizeMode = useCallback((sizeMode: SizeMode) => setLayout((l) => ({ ...l, sizeMode })), []);

  const setAttentionFirst = useCallback(
    (attentionFirst: boolean) => setLayout((l) => ({ ...l, attentionFirst })),
    [],
  );

  const setSidebarOpen = useCallback(
    (sidebarOpen: boolean) => setLayout((l) => ({ ...l, sidebarOpen })),
    [],
  );

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

  return {
    layout,
    setColumns,
    setSizeMode,
    setAttentionFirst,
    setSidebarOpen,
    setSidebarWidth,
    setHeight,
    arrangeAll,
    isArranged,
  };
}
