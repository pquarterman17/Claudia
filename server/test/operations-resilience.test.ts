import { describe, expect, it } from 'vitest';
import { rewindFiles } from '../src/file-checkpoints.js';
import { acceptedImages } from '../src/query-factory.js';
import { mcpStatus, type OperationalQuery } from '../src/session-operations.js';

/**
 * These guard a proven crash, not a hypothetical one.
 *
 * Every one of these calls is reached from a websocket handler. An unhandled
 * rejection there ends the whole process on modern Node, and this process
 * supervises other people's long-running sessions. Reproduced before the fix by
 * making mcpStatus reject: connecting a single browser killed the server, and a
 * second client could not connect at all.
 */

const rejecting: OperationalQuery = {
  mcpServerStatus: () => Promise.reject(new Error('MCP server unreachable')),
};

describe('mcpStatus never rejects', () => {
  it('degrades to an empty list when the SDK call fails', async () => {
    // The failing case IS the case a user opens this panel to diagnose.
    await expect(mcpStatus(rejecting)).resolves.toEqual([]);
  });

  it('returns an empty list when the session has no query yet', async () => {
    await expect(mcpStatus(null)).resolves.toEqual([]);
    await expect(mcpStatus({})).resolves.toEqual([]);
  });

  it('still maps a successful reply', async () => {
    const ok: OperationalQuery = {
      mcpServerStatus: async () => [
        { name: 'gmail', status: 'connected', scope: 'user', tools: [{ name: 'a' }, { name: 'b' }] },
      ] as never,
    };
    const [server] = await mcpStatus(ok);
    expect(server).toMatchObject({ name: 'gmail', status: 'connected', toolCount: 2 });
  });
});

describe('rewindFiles never rejects', () => {
  it('reports a failed restore as a value', async () => {
    const q = { rewindFiles: () => Promise.reject(new Error('checkpoint is gone')) };
    await expect(rewindFiles(q, 'cp-1')).resolves.toMatchObject({
      canRewind: false,
      error: 'checkpoint is gone',
    });
  });

  it('explains itself when the session has not started', async () => {
    const result = await rewindFiles(null, 'cp-1');
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/not started/i);
  });
});

describe('acceptedImages is the single source of truth for what is sent', () => {
  const image = (mb: number) => ({
    mediaType: 'image/png' as const,
    // 4 base64 chars per 3 bytes, no padding, so the decoded size is predictable.
    data: 'A'.repeat(Math.ceil((mb * 1024 * 1024 * 4) / 3)),
  });

  it('drops the image that busts the 10MB total even though each passes the 5MB rule', () => {
    // The reported bug: three 4MB photos each pass per-image validation, the
    // third exceeds the total budget, and the transcript claimed all three.
    const three = [image(4), image(4), image(4)];
    expect(acceptedImages(three)).toHaveLength(2);
  });

  it('caps the count at four', () => {
    expect(acceptedImages([image(0.1), image(0.1), image(0.1), image(0.1), image(0.1)])).toHaveLength(4);
  });

  it('rejects a non-image media type', () => {
    expect(acceptedImages([{ mediaType: 'application/pdf', data: 'AAAA' } as never])).toHaveLength(0);
  });

  it('rejects a single image over the per-image limit', () => {
    expect(acceptedImages([image(6)])).toHaveLength(0);
  });

  it('rejects data that is not base64', () => {
    expect(acceptedImages([{ mediaType: 'image/png', data: 'not base64!!' }])).toHaveLength(0);
  });
});
