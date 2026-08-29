import type { AgentKind } from '@claudia/shared';

/** UI copy for one agent kind — shared by the launch bar and the per-tile badge. */
export interface AgentKindOption {
  key: AgentKind;
  label: string;
  title: string;
}

/**
 * Every agent a session can launch as. Claude leads because it is Claudia's
 * origin and the default; picking it requires no action from the user.
 */
export const AGENT_KINDS: AgentKindOption[] = [
  { key: 'claude', label: 'Claude Code', title: "Anthropic's coding agent — Claudia's default" },
  { key: 'codex', label: 'Codex', title: 'OpenAI Codex, driven through codex app-server — approvals and model choice work; see the tile badge for what does not' },
];

export const agentKindLabel = (agent?: AgentKind): string =>
  AGENT_KINDS.find((a) => a.key === (agent ?? 'claude'))?.label ?? agent ?? 'Claude Code';

/**
 * What a session can actually do, keyed by agent. These are measured gaps, not
 * guesses: Codex reports token counts but no dollar cost, and has no /context,
 * model picker, MCP panel, effective-settings inspector, or file-checkpoint
 * rewind. A control this struct marks false must be hidden or disabled with a
 * reason attached — never left in place to silently do nothing.
 */
export interface AgentCapabilities {
  cost: boolean;
  context: boolean;
  modelPicker: boolean;
  mcpPanel: boolean;
  effectiveSettings: boolean;
  fileCheckpoints: boolean;
}

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  cost: true,
  context: true,
  modelPicker: true,
  mcpPanel: true,
  effectiveSettings: true,
  fileCheckpoints: true,
};

const CODEX_CAPABILITIES: AgentCapabilities = {
  cost: false,
  context: false,
  // Codex does have models: `model/list` enumerates them and `turn/start`
  // takes a per-turn `model`, so a switch lands on the next turn exactly as it
  // does for Claude. Verified against a live codex-cli.
  modelPicker: true,
  mcpPanel: false,
  effectiveSettings: false,
  fileCheckpoints: false,
};

export const capabilitiesFor = (agent?: AgentKind): AgentCapabilities =>
  agent === 'codex' ? CODEX_CAPABILITIES : CLAUDE_CAPABILITIES;
