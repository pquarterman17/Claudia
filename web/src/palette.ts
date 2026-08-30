/**
 * Command palette model — pure, no React, so ranking and the action list are
 * testable on their own.
 */
import type { PermissionLaunchMode, SessionSummary, ToolkitAction } from '@claudia/shared';

export interface PaletteAction {
  id: string;
  label: string;
  /** Right-aligned context, e.g. a session's state. */
  hint?: string;
  /** Extra match terms not worth showing. */
  keywords?: string;
  run: () => void;
}

/**
 * Filters and ranks actions for a query. Empty query returns everything in the
 * given order. Ranks: label starts with the query, then a word in the label
 * starts with it, then the label contains it, then only the keywords match.
 * Stable within each rank so the caller's ordering is meaningful.
 */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...actions];

  const ranked: Array<{ action: PaletteAction; rank: number }> = [];
  for (const action of actions) {
    const label = action.label.toLowerCase();
    const keywords = action.keywords?.toLowerCase() ?? '';
    let rank: number | null = null;
    if (label.startsWith(q)) rank = 0;
    else if (label.split(/\s+/).some((w) => w.startsWith(q))) rank = 1;
    else if (label.includes(q)) rank = 2;
    else if (keywords.includes(q)) rank = 3;
    if (rank !== null) ranked.push({ action, rank });
  }
  // Array.prototype.sort is stable, so equal ranks keep their input order.
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.action);
}

export interface PaletteDeps {
  sessions: SessionSummary[];
  /** Saved prompts that can be fired at a running session. */
  toolkit: ToolkitAction[];
  /** The session a toolkit action targets when one is focused. */
  focusedSessionId?: string;
  /** Sends a toolkit action's prompt to a session. */
  runToolkitAction: (sessionId: string, action: ToolkitAction) => void;
  focusSession: (id: string) => void;
  approveOldest: (() => void) | null;
  toggleUsage: () => void;
  setSizeMode: (mode: 'fit' | 'scroll') => void;
  setColumns: (columns: 0 | 1 | 2 | 3 | 4) => void;
  arrangeAll: () => void;
  recentDirectories: string[];
  defaultPermissionMode: PermissionLaunchMode;
  launch: (cwd: string) => void;
}

/** The palette's action list, rebuilt from current state each time it opens. */
export function buildPaletteActions(deps: PaletteDeps): PaletteAction[] {
  const actions: PaletteAction[] = [];

  for (const session of deps.sessions) {
    actions.push({
      id: `jump-${session.id}`,
      label: `Jump to ${session.name}`,
      hint: session.state,
      keywords: `session focus go ${session.cwd}`,
      run: () => deps.focusSession(session.id),
    });
  }

  // Toolkit actions target the focused session, falling back to the only one
  // when a single session is open — the common case, where making the user pick
  // a target first would be pure ceremony.
  const target =
    deps.sessions.find((s) => s.id === deps.focusedSessionId) ??
    (deps.sessions.length === 1 ? deps.sessions[0] : undefined);
  if (target) {
    for (const action of deps.toolkit) {
      // An action scoped to a directory is noise everywhere else.
      if (action.cwd && action.cwd !== target.cwd) continue;
      actions.push({
        id: `toolkit-${action.id}`,
        label: action.name,
        hint: target.title ?? target.name,
        keywords: `toolkit run prompt ${action.prompt}`,
        run: () => deps.runToolkitAction(target.id, action),
      });
    }
  }

  if (deps.approveOldest) {
    actions.push({
      id: 'approve-oldest',
      label: 'Approve oldest pending approval',
      keywords: 'permission allow yes',
      run: deps.approveOldest,
    });
  }

  actions.push(
    { id: 'toggle-usage', label: 'Toggle usage panel', keywords: 'tokens plan spend', run: deps.toggleUsage },
    { id: 'fill', label: 'Fill layout', hint: 'divide the window', keywords: 'board grid', run: () => deps.setSizeMode('fit') },
    { id: 'scroll', label: 'Scroll layout', hint: 'fixed tile heights', keywords: 'board grid', run: () => deps.setSizeMode('scroll') },
    { id: 'arrange', label: 'Arrange all tiles', keywords: 'reset uniform layout', run: deps.arrangeAll },
  );

  for (const columns of [0, 1, 2, 3, 4] as const) {
    actions.push({
      id: `cols-${columns}`,
      label: columns === 0 ? 'Columns: auto' : `Columns: ${columns}`,
      keywords: 'board grid layout',
      run: () => deps.setColumns(columns),
    });
  }

  for (const dir of deps.recentDirectories.slice(0, 5)) {
    const tail = dir.split(/[\\/]/).slice(-2).join('/');
    actions.push({
      id: `launch-${dir}`,
      label: `New session in ${tail}`,
      hint: 'launches idle',
      keywords: `start open ${dir}`,
      run: () => deps.launch(dir),
    });
  }

  return actions;
}
