import type { SessionSummary, ToolkitAction } from '@claudia/shared';
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
    action('a', 'Jump to gamma'),
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
    effortLevel: 'medium',
    thinkingMode: 'adaptive',
    contextPending: false,
    todos: [],
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
    recentDirectories: ['C:\\Users\\x\\git\\alpha', 'C:\\Users\\x\\Archive\\code\\git\\gamma'],
    defaultPermissionMode: 'auto' as const,
    launch: vi.fn(),
    toolkit: [] as ToolkitAction[],
    runToolkitAction: vi.fn(),
  };

  it('offers a jump per session and launch per recent directory', () => {
    const labels = buildPaletteActions(deps).map((a) => a.label);
    expect(labels).toContain('Jump to alpha');
    expect(labels).toContain('Jump to beta');
    // Windows paths shorten to their last two segments.
    expect(labels).toContain('New session in git/alpha');
    expect(labels).toContain('New session in git/gamma');
  });

  it('omits approve when nothing is pending, includes it when something is', () => {
    expect(buildPaletteActions(deps).some((a) => a.id === 'approve-oldest')).toBe(false);
    const withApprove = { ...deps, approveOldest: vi.fn() };
    expect(buildPaletteActions(withApprove).some((a) => a.id === 'approve-oldest')).toBe(true);
  });

  it('launching uses the palette-chosen directory', () => {
    const launch = vi.fn();
    const actions = buildPaletteActions({ ...deps, launch });
    actions.find((a) => a.label === 'New session in git/gamma')?.run();
    expect(launch).toHaveBeenCalledWith('C:\\Users\\x\\Archive\\code\\git\\gamma');
  });
});

describe('toolkit actions in the palette', () => {
  const tests: ToolkitAction = { id: 't1', name: 'Run & fix tests', prompt: 'run the tests' };
  const iosOnly: ToolkitAction = { id: 't2', name: 'Open Xcode', prompt: 'open xcode', cwd: '/ios' };

  const base = {
    focusSession: vi.fn(),
    approveOldest: null as (() => void) | null,
    toggleUsage: vi.fn(),
    setSizeMode: vi.fn(),
    setColumns: vi.fn(),
    arrangeAll: vi.fn(),
    recentDirectories: [],
    defaultPermissionMode: 'auto' as const,
    launch: vi.fn(),
  };

  it('offers them for the focused session', () => {
    const labels = buildPaletteActions({
      ...base,
      sessions: [session('s1', 'alpha'), session('s2', 'beta')],
      focusedSessionId: 's2',
      toolkit: [tests],
      runToolkitAction: vi.fn(),
    }).map((a) => a.label);
    expect(labels).toContain('Run & fix tests');
  });

  it('targets the only session when nothing is focused', () => {
    // Making someone pick a target when there is exactly one is pure ceremony.
    const run = vi.fn();
    const actions = buildPaletteActions({
      ...base,
      sessions: [session('s1', 'alpha')],
      toolkit: [tests],
      runToolkitAction: run,
    });
    actions.find((a) => a.label === 'Run & fix tests')?.run();
    expect(run).toHaveBeenCalledWith('s1', tests);
  });

  it('offers none when several sessions are open and none is focused', () => {
    // Firing a prompt at an arbitrary session is worse than offering nothing.
    const labels = buildPaletteActions({
      ...base,
      sessions: [session('s1', 'alpha'), session('s2', 'beta')],
      toolkit: [tests],
      runToolkitAction: vi.fn(),
    }).map((a) => a.label);
    expect(labels).not.toContain('Run & fix tests');
  });

  it('hides an action scoped to a different directory', () => {
    const labels = buildPaletteActions({
      ...base,
      sessions: [session('s1', 'alpha')],
      toolkit: [tests, iosOnly],
      runToolkitAction: vi.fn(),
    }).map((a) => a.label);
    expect(labels).toContain('Run & fix tests');
    expect(labels).not.toContain('Open Xcode');
  });

  it('matches on the prompt text too, not just the name', () => {
    const actions = buildPaletteActions({
      ...base,
      sessions: [session('s1', 'alpha')],
      toolkit: [tests],
      runToolkitAction: vi.fn(),
    });
    expect(filterActions(actions, 'run the tests').map((a) => a.label)).toContain('Run & fix tests');
  });
});
