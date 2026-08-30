import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHookHandler } from '../src/hook-endpoint.js';
import { HookMonitor } from '../src/hook-monitor.js';

/**
 * Driven over a real HTTP server rather than fake req/res objects, because
 * what matters here is behaviour under a real socket: a body arriving in
 * several chunks, a body too large to want, and a body that is not JSON at all.
 *
 * The property worth protecting is that a hook runs INSIDE somebody's terminal
 * session. Every path must answer 200 and answer quickly — a Claudia that is
 * broken, restarting, or being probed by something else entirely must never be
 * something the user feels in a session that has nothing to do with it.
 */

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

interface Harness {
  url: string;
  monitor: HookMonitor;
  changes: number;
}

async function serve(limit?: number): Promise<Harness> {
  const monitor = new HookMonitor();
  const harness: Harness = { url: '', monitor, changes: 0 };
  const handle = createHookHandler(monitor, () => (harness.changes += 1), limit);
  server = createServer((req, res) => {
    if (handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  harness.url = `http://127.0.0.1:${port}`;
  return harness;
}

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/repo', prompt: 'hi', ...over });

describe('the /hooks endpoint', () => {
  it('records a posted hook event and reports the change', async () => {
    const h = await serve();
    const res = await fetch(`${h.url}/hooks`, { method: 'POST', body: payload() });
    expect(res.status).toBe(200);
    expect(h.monitor.list()[0]).toMatchObject({ id: 's1', cwd: '/repo', state: 'working' });
    expect(h.changes).toBe(1);
  });

  it('answers 200 to a body that is not JSON, rather than failing a session', async () => {
    const h = await serve();
    const res = await fetch(`${h.url}/hooks`, { method: 'POST', body: 'not json at all' });
    expect(res.status).toBe(200);
    expect(h.monitor.size).toBe(0);
    expect(h.changes).toBe(0);
  });

  it('answers 200 to valid JSON that is not a hook payload', async () => {
    const h = await serve();
    const res = await fetch(`${h.url}/hooks`, { method: 'POST', body: JSON.stringify({ hello: 'world' }) });
    expect(res.status).toBe(200);
    expect(h.monitor.size).toBe(0);
  });

  it('drops an oversized body but still answers', async () => {
    // PreToolUse carries the whole tool_input, so a Write of a large file
    // arrives in full. The tile only ever shows a tool name.
    const h = await serve(200);
    const big = payload({ tool_input: { content: 'x'.repeat(5000) } });
    const res = await fetch(`${h.url}/hooks`, { method: 'POST', body: big });
    expect(res.status).toBe(200);
    expect(h.monitor.size).toBe(0);
  });

  it('reassembles a body that arrives in several chunks', async () => {
    const h = await serve();
    const body = payload();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        const cut = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const res = await fetch(`${h.url}/hooks`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(200);
    expect(h.monitor.list()[0]).toMatchObject({ id: 's1' });
  });

  it('leaves other routes and methods alone', async () => {
    const h = await serve();
    expect((await fetch(`${h.url}/hooks`)).status).toBe(404);
    expect((await fetch(`${h.url}/health`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('still routes when a query string is appended', async () => {
    const h = await serve();
    const res = await fetch(`${h.url}/hooks?from=terminal`, { method: 'POST', body: payload() });
    expect(res.status).toBe(200);
    expect(h.monitor.size).toBe(1);
  });

  it('reports a change only when something visible moved', async () => {
    const h = await serve();
    await fetch(`${h.url}/hooks`, { method: 'POST', body: payload() });
    await fetch(`${h.url}/hooks`, { method: 'POST', body: payload() });
    expect(h.changes, 'the same event twice is not news').toBe(1);
  });
});
