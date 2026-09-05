import { MAX_CHILDREN_CEILING, type SessionState } from '@claudia/shared';
import { resolvePort } from './resolve-port.js';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from './command-fields.js';
import { commitAndPush } from './commit-action.js';
import { startFleet } from './fleet/boot.js';
import { FleetPulser, type SessionFacts } from './fleet/pulse.js';
import { Orchestrators } from './orchestrators.js';
import { executeFinishAction, hostPlatform } from './finish-actions.js';
import { Gateway } from './gateway.js';
import { createHookHandler } from './hook-endpoint.js';
import { isInstalled } from './hook-install.js';
import { openBrowser, shouldOpenBrowser } from './open-browser.js';
import { HookMonitor } from './hook-monitor.js';
import { updateMemories } from './memory-action.js';
import { isAllowedHost, isAllowedOrigin } from './origin-guard.js';
import { SessionManager } from './session-manager.js';
import { createStaticHandler } from './static-files.js';
import { SettingsStore } from './settings-store.js';
import { TriggerEngine } from './trigger-engine.js';
import { UsageService } from './usage-service.js';

const platform = hostPlatform();
const requested = resolvePort(process.env['CLAUDIA_PORT']);

// Terminal sessions Claudia did not launch, fed by the global hook. Declared
// before the HTTP server because the /hooks route closes over it.
const monitor = new HookMonitor();

// Serves the built UI when web/dist exists, so production is one process on one
// port. In development Vite serves the UI on its own port instead.
const serveStatic = createStaticHandler(join(import.meta.dirname, '..', '..', 'web', 'dist'));

const handleHook = createHookHandler(monitor, () => gateway.broadcastObserved());

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
  if (handleHook(req, res)) return;
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
  // The outermost of the three size limits, and the only one that acts before
  // the bytes become a message at all: ws refuses an oversized frame during
  // reassembly, so a client cannot make the server allocate and parse
  // megabytes just to have the command rejected afterwards.
  maxPayload: MAX_FRAME_BYTES,
  verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => {
    if (isAllowedOrigin(origin) && isAllowedHost(req.headers.host)) return true;
    console.warn(`[claudia] refused a socket from origin=${origin ?? '(none)'} host=${req.headers.host ?? '(none)'}`);
    return false;
  },
});
const gateway = new Gateway(wss, platform, requested.port);

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
      runCommitPush: () => commitAndPush(manager.touchedByDirectory()),
    }),
  onChange: () => gateway.broadcast({ type: 'trigger_status', trigger: trigger.status() }),
  countdownSec: saved.countdownSec,
});
// Restore the chain, but never restore an armed state — arming is a deliberate
// act, and silently re-arming a shutdown across a restart is exactly the kind of
// surprise this app should not have.
trigger.setChain(saved.finishChain);

const manager = new SessionManager({
  onUpdate: (session) => {
    // Before the broadcast: a session owned by an unattended run and parked on
    // an approval has no other signal, and a run that waits for a human it does
    // not have is deadlocked rather than slow.
    orchestrators.onSessionUpdate(session);
    gateway.broadcast({ type: 'session_upsert', session });
  },
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

const orchestrators = new Orchestrators(manager, (event) => gateway.broadcast(event));

// After the manager, because reconciliation is a comparison against the
// sessions that actually exist: a run row saying `running` is adopted when its
// session is still there and orphaned when it is not. On a cold start there are
// none, and orphaning every stale run is the right answer — the alternative is
// a file that believes it is busy and will not dispatch again.
//
// Opened here rather than lazily on first use so that the reconciliation
// happens exactly once, before anything reads the rows it fixes.
const fleet = startFleet(new Set(manager.summaries().map((session) => session.id)));
console.log(`[claudia] ${fleet.summary}`);
gateway.attachFleet(fleet.store);
// Published AFTER the transaction commits, which is what `onAppended`
// subscribes to. A sequence number announced from inside a transaction that
// then rolls back is a number the log will hand to a different event, and a
// client holding it would never be shown the real one.
fleet.store?.events.onAppended((event) => gateway.broadcast({ type: 'fleet_event', event }));

// The clock the reconciler and the watchdog have been missing. It fires often
// and decides little: each mission carries its own `pulseSec`, and the pulser
// skips the ones whose interval has not elapsed. Unref'd, because a fleet with
// nothing to decide must not be the reason the process refuses to exit.
//
// No launcher is passed. Dispatch decisions are recorded as deferred rather
// than carried out — starting a child means claiming a worktree and going
// through the session manager, which is its own change. The pulse still
// applies everything that costs nothing: blocks, unblocks, escalations, and
// giving up on a task that has run out of attempts.
/**
 * What the watchdog gets to see, built from the sessions themselves.
 *
 * Two things it needs beyond "is this id known". `lastActivityAt`, or `assess`
 * falls back to the run's START time and calls any live run older than
 * `silentAfterMs` silent — failing or retrying work that is still producing
 * output. And the approval fields, or a run parked on a human is retried,
 * spending a fresh turn that parks on the same approval, instead of escalated.
 *
 * Built from an ALLOWLIST of live states rather than by excluding the dead
 * ones. `stopped` was excluded first, and review caught the other half:
 * `Session.fail()` retains a tile in state `error` after its driver has
 * terminated, so a dead process was still reported alive and its run waited
 * out the whole silence threshold instead of being recognised as an orphan
 * immediately. Naming what IS alive means the next terminal state added to the
 * union cannot quietly join the living.
 */
const LIVE_SESSION_STATES: ReadonlySet<SessionState> = new Set([
  'starting',
  'working',
  'awaiting_approval',
  'idle',
]);

function liveSessionFacts(): ReadonlyMap<string, SessionFacts> {
  const facts = new Map<string, SessionFacts>();
  for (const session of manager.summaries()) {
    if (!LIVE_SESSION_STATES.has(session.state)) continue;
    facts.set(session.id, {
      lastActivityAt: session.lastActivityAt,
      ...(session.pendingApproval
        ? { pendingApproval: session.pendingApproval.toolName, pendingSince: session.pendingApproval.requestedAt }
        : {}),
    });
  }
  return facts;
}

const pulser = fleet.store
  ? new FleetPulser({
      store: fleet.store,
      policy: { maxChildren: MAX_CHILDREN_CEILING, maxAttempts: 3 },
      observeSessions: liveSessionFacts,
    })
  : undefined;
const pulseTicker = setInterval(() => void pulser?.tick(), 15_000);
pulseTicker.unref?.();

// Mirrored transcripts, read only while somebody is watching one. Faster than
// the pulse because this is a human reading a conversation rather than a fleet
// deciding what to spend, and it costs nothing when nothing is mirrored: the
// service returns immediately with no watches.
const mirrorTicker = setInterval(() => void gateway.pollMirrors(), 2_000);
mirrorTicker.unref?.();

const usage = new UsageService(() => gateway.broadcast({ type: 'usage', usage: usage.snapshot() }));
usage.setTier(saved.planTier);
if (saved.customCeilings) usage.setCustomCeilings(saved.customCeilings);

gateway.attach(manager, trigger, usage, settings, monitor, orchestrators);
usage.start();

// One clock drives the countdown; the engine decides whether anything happens.
const ticker = setInterval(() => trigger.tick(manager.summaries()), 1000);

// Branch and dirty state, on a slower clock than the trigger: it spawns `git`,
// and a branch changes on a human timescale. Failures are already swallowed
// inside, so an unhandled rejection cannot reach the process from here.
// A terminal killed with Ctrl+C sends no SessionEnd, so observed tiles are
// aged out rather than trusted to say goodbye. Twelve hours is deliberately
// generous: a session idle overnight is still a real session.
const OBSERVED_MAX_IDLE_MS = 12 * 60 * 60_000;
const pruneTicker = setInterval(() => {
  if (monitor.prune(OBSERVED_MAX_IDLE_MS)) gateway.broadcastObserved();
}, 60_000);
pruneTicker.unref?.();

const gitTicker = setInterval(() => void manager.refreshGit(), 15_000);
gitTicker.unref?.();
void manager.refreshGit();

// The overwhelmingly likely failure here is that Claudia is ALREADY running:
// it is a supervisor meant to stay up, and it is normally started by
// double-clicking a launcher, so an unhandled 'error' event prints a Node
// stack trace into a console window that may close before it can be read.
//
// The listener has to go on BOTH emitters. `ws` was constructed with
// `{ server: httpServer }`, so it forwards the HTTP server's errors onto the
// WebSocketServer — with a listener only on httpServer, that re-emit is the
// unhandled one and the process still dies on the same stack trace.
const onListenError = (err: NodeJS.ErrnoException): void => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`[claudia] port ${requested.port} is already in use.`);
  console.error(`[claudia] Claudia is probably running already — open http://127.0.0.1:${requested.port}`);
  console.error('[claudia] To run a second instance, set CLAUDIA_PORT to a free port (or 0 to pick one).');
  process.exit(1);
};
httpServer.on('error', onListenError);
wss.on('error', onListenError);
if (requested.warning) console.warn(`[claudia] ${requested.warning}`);
httpServer.listen(requested.port, '127.0.0.1', () => {
  // Report what was actually bound, not what was asked for: with port 0 the
  // requested value is meaningless and a log saying "0" helps nobody.
  const bound = httpServer.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : requested.port;
  gateway.setPort(port);
  // 127.0.0.1, not localhost: this server binds IPv4 only, and on Windows
  // localhost resolves to ::1 first — the mismatch that made the launcher's
  // old browser-open wait out its whole timeout instead of opening anything.
  if (shouldOpenBrowser(process.env)) openBrowser(`http://127.0.0.1:${port}`, platform);
  // Establish whether the global hook is already installed, so a later
  // broadcast cannot flip the UI toggle off just because nobody had asked yet.
  void isInstalled(port).then((on) => gateway.broadcastObserved(on)).catch(() => undefined);
  console.log(`[claudia] listening on http://127.0.0.1:${port} · ${platform}`);
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
    clearInterval(gitTicker);
    clearInterval(pruneTicker);
    clearInterval(pulseTicker);
    clearInterval(mirrorTicker);
    usage.stop();
    manager.stopAll();
    // Closed on the way out so the file is not left locked by a connection
    // nobody holds — the next start has to be able to take the write lock.
    fleet.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
