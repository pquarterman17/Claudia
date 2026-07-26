import { describe, expect, it } from 'vitest';
import { autoColumns, autoRows, defaultSidebarOpen, gridTemplate } from '../src/layout';

describe('defaultSidebarOpen', () => {
  it('keeps the board wide on laptop-sized viewports', () => {
    expect(defaultSidebarOpen(1024)).toBe(false);
    expect(defaultSidebarOpen(1199)).toBe(false);
  });

  it('shows the digest by default on wide screens', () => {
    expect(defaultSidebarOpen(1200)).toBe(true);
    expect(defaultSidebarOpen(1600)).toBe(true);
  });
});

describe('autoColumns — fill the window', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
    [5, 3],
    [9, 3],
  ])('%i sessions -> %i columns', (count, cols) => {
    expect(autoColumns(count)).toBe(cols);
  });

  it('caps columns so tiles stay readable on a wide screen', () => {
    expect(autoColumns(50)).toBe(4);
  });

  it('treats an empty board as one column rather than zero', () => {
    expect(autoColumns(0)).toBe(1);
  });
});

describe('autoRows', () => {
  it('gives quadrants for four sessions', () => {
    expect(autoColumns(4)).toBe(2);
    expect(autoRows(4, 0)).toBe(2);
  });

  it('halves the window for two sessions', () => {
    expect(autoColumns(2)).toBe(2);
    expect(autoRows(2, 0)).toBe(1);
  });

  it('respects an explicit column choice', () => {
    expect(autoRows(6, 3)).toBe(2);
    expect(autoRows(6, 1)).toBe(6);
  });

  it('never returns zero rows', () => {
    expect(autoRows(0, 0)).toBe(1);
  });
});

describe('gridTemplate', () => {
  it('fills with a near-square grid, ignoring the 440px minimum', () => {
    expect(gridTemplate(0, 'fit', 4)).toBe('repeat(2, minmax(0, 1fr))');
  });

  it('falls back to as-many-as-fit when scrolling', () => {
    expect(gridTemplate(0, 'scroll', 4)).toContain('auto-fill');
  });

  it('honours an explicit column count in either mode', () => {
    expect(gridTemplate(3, 'fit', 9)).toBe('repeat(3, minmax(0, 1fr))');
    expect(gridTemplate(3, 'scroll', 9)).toBe('repeat(3, minmax(0, 1fr))');
  });
});
