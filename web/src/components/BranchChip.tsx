import type { GitInfo } from '@claudia/shared';
import { COLORS } from '../status';

/**
 * The branch a session is working on, with a dot when the tree is dirty.
 *
 * This is identity, not decoration. A tile is labelled by its working
 * directory, but the usual workflow here is a branch per feature IN ONE REPO —
 * so parallel sessions all show the same path and are indistinguishable at a
 * glance, which is precisely the confusion this app exists to remove. The
 * branch is what actually tells them apart, so it sits beside the name rather
 * than after the path.
 *
 * Renders nothing when the directory is not a repository, which is an ordinary
 * thing for a session to be launched in.
 */
export function BranchChip({ git }: { git?: GitInfo }) {
  if (!git) return null;
  const dirty = git.dirtyFiles > 0;
  return (
    <span
      className="mono"
      title={
        dirty
          ? `On ${git.branch} · ${git.dirtyFiles} uncommitted file${git.dirtyFiles === 1 ? '' : 's'}`
          : `On ${git.branch} · working tree clean`
      }
      style={{
        flex: 'none',
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 10.5,
        color: '#8fb9a8',
      }}
    >
      {git.branch}
      {dirty && <span style={{ color: COLORS.warn }}> ●</span>}
    </span>
  );
}
