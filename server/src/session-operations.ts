import { resolveSettings, type McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { EffectiveSettings, McpServerInfo } from '@claudia/shared';

export type OperationalQuery = {
  mcpServerStatus?: () => Promise<McpServerStatus[]>;
  reconnectMcpServer?: (name: string) => Promise<void>;
  toggleMcpServer?: (name: string, enabled: boolean) => Promise<void>;
  stopTask?: (taskId: string) => Promise<void>;
};

export async function mcpStatus(query: OperationalQuery | null): Promise<McpServerInfo[]> {
  if (!query?.mcpServerStatus) return [];
  return (await query.mcpServerStatus()).map((server) => ({
    name: server.name,
    status: server.status,
    scope: server.scope,
    error: server.error,
    toolCount: server.tools?.length ?? 0,
  }));
}

export async function resolvedSettings(cwd: string): Promise<EffectiveSettings> {
  const resolved = await resolveSettings({ cwd });
  // Environment, hook commands, and helpers may contain secrets. The inspector
  // answers configuration provenance without copying those sensitive values.
  const blocked = new Set(['env', 'apiKeyHelper', 'proxyAuthHelper', 'awsCredentialExport', 'hooks']);
  const effective = Object.fromEntries(Object.entries(resolved.effective).filter(([key]) => !blocked.has(key)));
  return {
    cwd,
    effective,
    provenance: Object.fromEntries(Object.entries(resolved.provenance).flatMap(([key, value]) => value ? [[key, value.source]] : [])),
    sources: resolved.sources.map(({ source, path }) => ({ source, ...(path ? { path } : {}) })),
  };
}
