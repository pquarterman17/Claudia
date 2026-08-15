import { resolveSettings, type McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { EffectiveSettings, McpServerInfo } from '@claudia/shared';

export type OperationalQuery = {
  mcpServerStatus?: () => Promise<McpServerStatus[]>;
  reconnectMcpServer?: (name: string) => Promise<void>;
  toggleMcpServer?: (name: string, enabled: boolean) => Promise<void>;
  stopTask?: (taskId: string) => Promise<void>;
};

/**
 * MCP status for one session, or an empty list if it cannot be obtained.
 *
 * Never rejects. This is called during the `hello` handshake for every live
 * session, and an unhandled rejection there kills the whole server process on
 * modern Node — taking every other session's supervision down with it. A
 * broken MCP server is exactly the state a user opens this panel to diagnose,
 * so it must degrade to "no data", never to a crash.
 */
export async function mcpStatus(query: OperationalQuery | null): Promise<McpServerInfo[]> {
  if (!query?.mcpServerStatus) return [];
  try {
    return await readMcpStatus(query);
  } catch {
    return [];
  }
}

async function readMcpStatus(query: OperationalQuery): Promise<McpServerInfo[]> {
  return (await query.mcpServerStatus!()).map((server) => ({
    name: server.name,
    status: server.status,
    scope: server.scope,
    error: server.error,
    toolCount: server.tools?.length ?? 0,
  }));
}

/** Resolved settings, or null when they cannot be read (malformed file, permissions). */
export async function resolvedSettings(cwd: string): Promise<EffectiveSettings | null> {
  try {
    return await readResolvedSettings(cwd);
  } catch {
    return null;
  }
}

async function readResolvedSettings(cwd: string): Promise<EffectiveSettings> {
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
