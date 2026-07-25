import { CLAUDIA_PORT } from '@claudia/shared';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { executeFinishAction, hostPlatform } from './finish-actions.js';
import { Gateway } from './gateway.js';
import { SessionManager } from './session-manager.js';
import { TriggerEngine } from './trigger-engine.js';
import { UsageService } from './usage-service.js';

const platform = hostPlatform();

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: manager.summaries().length, platform }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const gateway = new Gateway(wss, platform);

const trigger = new TriggerEngine({
  platform,
  execute: executeFinishAction,
  onChange: () => gateway.broadcast({ type: 'trigger_status', trigger: trigger.status() }),
});

const manager = new SessionManager({
  onUpdate: (session) => gateway.broadcast({ type: 'session_upsert', session }),
  onFeed: (sessionId, step) => gateway.broadcast({ type: 'feed_append', sessionId, step }),
  onFeedPatch: (sessionId, stepId, patch) =>
    gateway.broadcast({ type: 'feed_update', sessionId, stepId, patch }),
  onRemoved: (sessionId) => gateway.broadcast({ type: 'session_removed', sessionId }),
});

const usage = new UsageService(() => gateway.broadcast({ type: 'usage', usage: usage.snapshot() }));

gateway.attach(manager, trigger, usage);
usage.start();

// One clock drives the countdown; the engine decides whether anything happens.
const ticker = setInterval(() => trigger.tick(manager.summaries()), 1000);

httpServer.listen(CLAUDIA_PORT, '127.0.0.1', () => {
  console.log(`[claudia] server listening on http://127.0.0.1:${CLAUDIA_PORT} (ws at /ws) · ${platform}`);
});

// Wire teardown to real lifecycle signals, not atexit-style hooks.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[claudia] ${signal} — stopping sessions`);
    clearInterval(ticker);
    usage.stop();
    manager.stopAll();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
