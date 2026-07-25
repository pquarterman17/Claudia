import { CLAUDIA_PORT } from '@claudia/shared';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Gateway } from './gateway.js';
import { SessionManager } from './session-manager.js';

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: manager.summaries().length }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const gateway = new Gateway(wss);

const manager = new SessionManager({
  onUpdate: (session) => gateway.broadcast({ type: 'session_upsert', session }),
  onFeed: (sessionId, step) => gateway.broadcast({ type: 'feed_append', sessionId, step }),
  onRemoved: (sessionId) => gateway.broadcast({ type: 'session_removed', sessionId }),
});

gateway.attach(manager);

httpServer.listen(CLAUDIA_PORT, '127.0.0.1', () => {
  console.log(`[claudia] server listening on http://127.0.0.1:${CLAUDIA_PORT} (ws at /ws)`);
});

// Wire teardown to real lifecycle signals, not atexit-style hooks.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[claudia] ${signal} — stopping sessions`);
    manager.stopAll();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
