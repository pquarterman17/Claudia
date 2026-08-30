import type { AgentKind } from '@claudia/shared';

/**
 * Human names for the agents, server-side.
 *
 * The web has its own copy in `agent-kinds.ts` because it also carries UI-only
 * concerns (per-agent capability flags, tooltip copy). This is deliberately
 * just the names: the server needs them for feed lines, and importing a web
 * module into the server to get two strings would be the wrong dependency.
 */
const LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const agentLabel = (agent?: AgentKind): string => (agent ? (LABELS[agent] ?? agent) : LABELS.claude);
