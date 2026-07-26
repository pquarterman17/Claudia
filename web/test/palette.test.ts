import type { SessionSummary } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildPaletteActions, filterActions, type PaletteAction } from '../src/palette';

const action = (id: string, label: string, keywords = ''): PaletteAction => ({
  id,
  label,
  keywords,
  run: () => undefined,
});

describe('filterActions', () => {
  const actions = [
    action('a', 'Jump to quantized'),
    action('b', 'Toggle usage panel', 'tokens plan spend'),
    action('c', 'Columns: auto', 'board grid layout'),
    action('d', 'Arrange all tiles', 'reset uniform'),
  ];

  it('empty query returns everything in the given order', () => {
    expect(filterActions(actions, '')).toEqual(actions);
    expect(filterActions(actions, '   ')).toEqual(actions);
  });

  it('ranks label-start above word-start above substring above keywords-only', () => {
    const mixed = [
      action('kw', 'Something else', 'usage'),
      action('sub', 'Reusage panel'), // query only mid-word
      action('word', 'Panel usage view'), // second word starts with query
      action('start', 'Usage bars'),
    ];
    expect(filterActions(mixed, 'usage').map((a) => a.id)).toEqual(['start', 'word', 'sub', 'kw']);
  });

  it('is case-insensitive', () => {
    expect(filterActions(actions, 'JUMP')[0]?.id).toBe('a');
  });

  it('drops non-matches entirely', () => {
    expect(filterActions(actions, 'zzz')).toEqual([]);
  });

  it('is stable within a rank', () => {
    const same = [action('one', 'Columns: 1'), action('two', 'Columns: 2')];
    expect(filterActions(same, 'columns').map((a) => a.id)).toEqual(['one', 'two']);
  });
});

function session(id: string, name: string): SessionSummary {
  return {
    id,
    name,
    cwd: `C:\\Users\\x\\git\\${name}`,
    permissionMode: 'auto',
    state: 'idle',
    startedAt: 0,
    lastActivityAt: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    queuedPrompts: [],
  };
}

describe('buildPaletteActions', () => {
  const deps = {
    sessions: [session('s1', 'alpha'), session('s2', 'beta')],
    focusSession: vi.fn(),
    approveOldest: null as (() => void) | null,
    toggleUsage: vi.fn(),
    setSizeMode: vi.fn(),
    setColumns: vi.fn(),
    arrangeAll: vi.fn(),
    recentDirectories: ['C:\\Users\\x\\git\\alpha', 'C:\\Users\\x\\OneDrive\\Coding\\git\\quantized'],
    defaultPermissionMode: 'auto' as const,
    launch: vi.fn(),
  };

  it('offers a jump per session and launch per recent directory', () => {
    const labels = buildPaletteActions(deps).map((a) => a.label);
    expect(labels).toContain('Jump to alpha');
    expect(labels).toContain('Jump to beta');
    // Windows paths shorten to their last two segments.
    expect(labels).toContain('New session in git/alpha');
    expect(labels).toContain('New session in git/quantized');
  });

  it('omits approve when nothing is pending, includes it when something is', () => {
    expect(buildPaletteActions(deps).some((a) => a.id === 'approve-oldest')).toBe(false);
    const withApprove = { ...deps, approveOldest: vi.fn() };
    expect(buildPaletteActions(withApprove).some((a) => a.id === 'approve-oldest')).toBe(true);
  });

  it('launching uses the palette-chosen directory', () => {
    const launch = vi.fn();
    const actions = buildPaletteActions({ ...deps, launch });
    actions.find((a) => a.label === 'New session in git/quantized')?.run();
    expect(launch).toHaveBeenCalledWith('C:\\Users\\x\\OneDrive\\Coding\\git\\quantized');
  });
});
