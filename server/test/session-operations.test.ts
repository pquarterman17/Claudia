import { describe, expect, it, vi } from 'vitest';
import { mcpStatus } from '../src/session-operations.js';

describe('mcpStatus', () => {
  it('maps only structured SDK MCP status fields', async () => {
    const query = { mcpServerStatus: vi.fn().mockResolvedValue([
      { name: 'repo', status: 'failed', scope: 'project', error: 'connection refused', tools: [{ name: 'search' }] },
      { name: 'disabled', status: 'disabled' },
    ]) };
    await expect(mcpStatus(query)).resolves.toEqual([
      { name: 'repo', status: 'failed', scope: 'project', error: 'connection refused', toolCount: 1 },
      { name: 'disabled', status: 'disabled', error: undefined, scope: undefined, toolCount: 0 },
    ]);
  });

  it('does not claim status before a query is initialized', async () => {
    await expect(mcpStatus(null)).resolves.toEqual([]);
  });
});
