import { CLAUDIA_PORT } from '@claudia/shared';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { executeFinishAction, hostPlatform } from './finish-actions.js';
import { Gateway } from './gateway.js';
import { updateMemories } from './memory-action.js';
import { isAllowedHost, isAllowedOrigin } from './origin-guard.js';
import { SessionManager } from './session-manager.js';
import { createStaticHandler } from './static-files.js';
import { SettingsStore } from './settings-store.js';
import { TriggerEngine } from './trigger-engine.js';
import { UsageService } from './usage-service.js';

const platform = hostPlatform();

// Serves the built UI when web/dist exists, so production is one process on one
// port. In development Vite serves the UI on its own port instead.
const serveStatic = createStaticHandler(join(import.meta.dirname, '..', '..', 'web', 'dist'));

const httpServer = createServer((req, res) => {
  // Refuse before doing any work: a request naming a host that is not loopback
  // reached us through DNS rebinding, not through a link the user clicked.
  if (!isAllowedHost(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Claudia only serves loopback hosts\n');
    return;
  }
  if (req.url === '/health') {
    const all = manager.summaries();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        // `sessions` counts tiles on screen; `live` counts ones still holding a
        // process. Reporting only the total hid a bug where sessions were never
        // stopped, because a stopped session still has a tile.
        sessions: all.length,
        live: all.filter((s) => s.state !== 'stopped').length,
        platform,
      }),
    );
    return;
  }
  if (serveStatic(req, res)) return;
  res.writeHead(404).end();
});

// A Claudia command can launch a session with permissions bypassed in any
// directory, so an unchecked socket is remote code execution. Browsers exempt
// WebSockets from the same-origin policy, which makes this check — not the
// loopback bind — the thing that keeps a visited page out.
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => {
    if (isAllowedOrigin(origin) && isAllowedHost(req.headers.host)) return true;
    console.warn(`[claudia] refused a socket from origin=${origin ?? '(none)'} host=${req.headers.host ?? '(none)'}`);
    return false;
  },
});
const gateway = new Gateway(wss, platform);

const settings = new SettingsStore();
const saved = settings.get();

const trigger = new TriggerEngine({
  platform,
  execute: (key) =>
    executeFinishAction(key, {
      platform,
      // Non-command actions run where the work happened.
      cwd: settings.get().recentDirectories[0] ?? process.cwd(),
      runMemoryUpdate: updateMemories,
    }),
  onChange: () => gateway.broadcast({ type: 'trigger_status', trigger: trigger.status() }),
  countdownSec: saved.countdownSec,
});
// Restore the chain, but never restore an armed state — arming is a deliberate
// act, and silently re-arming a shutdown across a restart is exactly the kind of
// surprise this app should not have.
trigger.setChain(saved.finishChain);

const manager = new SessionManager({
  onUpdate: (session) => gateway.broadcast({ type: 'session_upsert', session }),
  onFeed: (sessionId, step) => gateway.broadcast({ type: 'feed_append', sessionId, step }),
  onFeedPatch: (sessionId, stepId, patch) =>
    gateway.broadcast({ type: 'feed_update', sessionId, stepId, patch }),
  onDraft: (sessionId, text) => gateway.broadcast({ type: 'draft', sessionId, text }),
  onCommands: (sessionId, commands) => gateway.broadcast({ type: 'session_commands', sessionId, commands }),
  onTranscript: (sessionId, item) => {
    // A `/cost` reply is just another assistant transcript item; this is the
    // one place every session's transcript already flows through, so it is
    // where the real-usage capture gets a look at each one.
    usage.captureReal(sessionId, item);
    gateway.broadcast({ type: 'transcript_append', sessionId, item });
  },
  onRemoved: (sessionId) => gateway.broadcast({ type: 'session_removed', sessionId }),
});

const usage = new UsageService(() => gateway.broadcast({ type: 'usage', usage: usage.snapshot() }));
usage.setTier(saved.planTier);
if (saved.customCeilings) usage.setCustomCeilings(saved.customCeilings);

gateway.attach(manager, trigger, usage, settings);
usage.start();

// One clock drives the countdown; the engine decides whether anything happens.
const ticker = setInterval(() => trigger.tick(manager.summaries()), 1000);

httpServer.listen(CLAUDIA_PORT, '127.0.0.1', () => {
  console.log(`[claudia] listening on http://127.0.0.1:${CLAUDIA_PORT} · ${platform}`);
});

// Backstop, not a substitute for handling rejections where they happen: this
// process supervises other people's long-running work, so dying over one stray
// rejection loses far more than it protects. Every known path is guarded at its
// source; this catches the unknown ones and says so loudly.
process.on('unhandledRejection', (reason) => {
  console.error('[claudia] unhandled rejection — surviving, but this is a bug:', reason);
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
