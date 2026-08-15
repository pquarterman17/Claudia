/** A deliberately small, serializable view of an SDK MCP server status. */
export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  scope?: string;
  error?: string;
  toolCount: number;
}

/** The settings cascade, with sensitive values omitted before transport. */
export interface EffectiveSettings {
  cwd: string;
  provenance: Record<string, string>;
  sources: Array<{ source: string; path?: string }>;
  effective: Record<string, unknown>;
}
