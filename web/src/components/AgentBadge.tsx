import type { AgentKind } from '@claudia/shared';

/**
 * The owner runs several tiles at once, so a Codex tile has to read as Codex
 * without opening anything — a wrong assumption about which agent is running
 * costs more than the menu click a hidden indicator would save. Claude tiles
 * render nothing: Claude is the default and the unmarked case.
 *
 * Split out of SessionTile so this stays a one-line addition there instead of
 * pushing that file against its size ratchet.
 */
export function AgentBadge({ agent }: { agent?: AgentKind }) {
  if (agent !== 'codex') return null;
  return (
    <span
      title="Codex session — no dollar cost, /context, model picker, MCP panel, effective-settings inspector, or file-checkpoint rewind"
      style={{
        flex: 'none',
        fontSize: 10,
        fontWeight: 600,
        border: '1px solid #3d5a80',
        background: '#1c2b3d',
        borderRadius: 4,
        padding: '1px 6px',
        color: '#8ec1e8',
      }}
    >
      Codex
    </span>
  );
}
