import { renderToStaticMarkup } from 'react-dom/server';
import type { ServerEvent, WorktreeCleanupEntry } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { WorktreeCleanup } from '../src/components/WorktreeCleanup';
import { foldFleet, NO_FLEET } from '../src/fleet-state';

/**
 * The preview half of managed cleanup.
 *
 * The plan requires cleanup to be previewable and refuses unsafe deletion, so
 * what matters in the UI is that the reasons for the KEPT worktrees are shown
 * at all — a list of what will be deleted answers the wrong question — and
 * that nothing offers to remove one the server did not mark removable.
 */

function entry(over: Partial<WorktreeCleanupEntry> = {}): WorktreeCleanupEntry {
  return { worktreeId: 'w1', path: '/repo-worktrees/t1', branch: 'claudia/t1', state: 'idle', removable: true, reason: 'merged and clean', ...over };
}

const html = (plan: Parameters<typeof WorktreeCleanup>[0]['plan']) =>
  renderToStaticMarkup(<WorktreeCleanup missionId="m1" plan={plan} />);

describe('worktree cleanup panel', () => {
  it('says nothing is automatic before a preview is asked for', () => {
    const markup = html(undefined);
    expect(markup).toContain('preview cleanup');
    expect(markup).toContain('Nothing is removed automatically');
    expect(markup).not.toContain('Worktree cleanup plan');
  });

  it('gives a reason for a worktree it is keeping', () => {
    const markup = html({ phase: 'preview', entries: [entry({ removable: false, reason: 'it has uncommitted work' })] });
    expect(markup).toContain('kept: it has uncommitted work');
    // No checkbox: the server did not mark it removable, so the UI must not
    // offer to select it.
    expect(markup).not.toContain('type="checkbox"');
  });

  it('offers a removable one for selection', () => {
    const markup = html({ phase: 'preview', entries: [entry()] });
    expect(markup).toContain('can be removed: merged and clean');
    expect(markup).toContain('type="checkbox"');
  });

  it('asks for confirmation separately for an unmerged branch', () => {
    const markup = html({ phase: 'preview', entries: [entry({ removable: false, reason: 'claudia/t1 is not merged into its base' })] });
    expect(markup).toContain('confirm claudia/t1');
    expect(markup).toContain('it confirms only that one');
  });

  it('reports what did not go, not only what did', () => {
    const markup = html({ phase: 'applied', entries: [entry({ removed: false, error: 'contains modified or untracked files' })] });
    expect(markup).toContain('not removed: contains modified or untracked files');
    // Applied is a report, so nothing is selectable in it.
    expect(markup).not.toContain('type="checkbox"');
  });
});

describe('folding a cleanup answer', () => {
  it('keeps the plan under its mission', () => {
    const event: ServerEvent = { type: 'worktree_cleanup', missionId: 'm1', phase: 'preview', entries: [entry()] };
    expect(foldFleet(NO_FLEET, event)?.cleanup.get('m1')).toEqual({ phase: 'preview', entries: [entry()] });
  });

  it('replaces rather than merges, because two plans are two moments', () => {
    const first = foldFleet(NO_FLEET, { type: 'worktree_cleanup', missionId: 'm1', phase: 'preview', entries: [entry(), entry({ worktreeId: 'w2' })] });
    const second = foldFleet(first ?? NO_FLEET, { type: 'worktree_cleanup', missionId: 'm1', phase: 'applied', entries: [entry({ removed: true })] });
    expect(second?.cleanup.get('m1')?.entries).toHaveLength(1);
    expect(second?.cleanup.get('m1')?.phase).toBe('applied');
  });
});
