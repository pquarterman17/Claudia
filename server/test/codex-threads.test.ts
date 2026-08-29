import { describe, expect, it } from 'vitest';
import type { Channel } from '../src/codex-client.js';
import { CodexNotInstalledError, type CodexProcess } from '../src/codex-process.js';
import { listCodexThreads } from '../src/codex-threads.js';

/**
 * Rows here are captured from a live `thread/list`, not invented: unix SECOND
 * timestamps, a `preview` holding the first prompt, and the same thread fields
 * `thread/start` returns.
 */

/** A fake app-server that answers initialize, then thread/list. */
function fakeCodex(rows: unknown[]): (cwd: string) => CodexProcess {
  return () => {
    let onLine: (line: string) => void = () => {};
    const channel: Channel = {
      send: (line) => {
        const frame = JSON.parse(line) as { id?: number; method?: string };
        if (frame.method === 'initialize') queueMicrotask(() => onLine(`${JSON.stringify({ id: frame.id, result: {} })}\n`));
        if (frame.method === 'thread/list') {
          queueMicrotask(() => onLine(`${JSON.stringify({ id: frame.id, result: { data: rows } })}\n`));
        }
      },
      onLine: (handler) => (onLine = handler),
      close: () => undefined,
    };
    return { channel, exited: new Promise(() => {}) };
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: '01a04e6d-015e-7c72-a4b9-268e84d27ea3',
  preview: 'Remember the number 8317. Reply with just: stored',
  recencyAt: 1788020657,
  cwd: 'C:/repo',
  ...over,
});

describe('listCodexThreads', () => {
  it('maps a captured thread row onto the picker shape', async () => {
    const [session] = await listCodexThreads('C:/repo', fakeCodex([row()]));
    expect(session).toMatchObject({
      sessionId: '01a04e6d-015e-7c72-a4b9-268e84d27ea3',
      summary: 'Remember the number 8317. Reply with just: stored',
      agent: 'codex',
      cwd: 'C:/repo',
    });
  });

  it('converts the unix SECOND timestamp to milliseconds', async () => {
    // Everything else in Claudia is in milliseconds; leaving this in seconds
    // would sort every Codex thread to 1970 in a merged list.
    const [session] = await listCodexThreads('C:/repo', fakeCodex([row({ recencyAt: 1788020657 })]));
    expect(session?.lastModified).toBe(1788020657000);
  });

  it('falls back to a label when a thread has no preview yet', async () => {
    const [session] = await listCodexThreads('C:/repo', fakeCodex([row({ preview: '', name: '' })]));
    expect(session?.summary).toBe('Codex thread');
  });

  it('drops a row with no id rather than inventing one', async () => {
    expect(await listCodexThreads('C:/repo', fakeCodex([{ preview: 'orphan' }]))).toEqual([]);
  });

  it('returns nothing when Codex is not installed, instead of rejecting', async () => {
    // Reached from a websocket handler: an unhandled rejection there ends the
    // whole server, and "no Codex history" is the correct answer anyway.
    const missing = () => {
      throw new CodexNotInstalledError();
    };
    await expect(listCodexThreads('C:/repo', missing)).resolves.toEqual([]);
  });

  it('returns nothing when the app-server never answers usefully', async () => {
    const broken = (): CodexProcess => ({
      channel: {
        send: () => {
          throw new Error('pipe closed');
        },
        onLine: () => undefined,
        close: () => undefined,
      },
      exited: new Promise(() => {}),
    });
    await expect(listCodexThreads('C:/repo', broken)).resolves.toEqual([]);
  });
});
