// End-to-end smoke for a Codex session, to run once `codex` is installed.
//
// Nothing in the Codex driver has been exercised against the real binary — the
// machine it was written on has no Codex — so this is the test that actually
// matters. The protocol layer is unit-tested against shapes read from the codex
// source, but a field name that drifted between versions would only show here.
//
//   npm install -g @openai/codex   (then sign in)
//   node scripts/codex-smoke.mjs "C:/path/to/a/repo"
//
// Expect: a thread id, a streamed reply, a turn completing, and token counts.
// A dollar cost of 0 is CORRECT — Codex reports tokens but no cost.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node scripts/codex-smoke.mjs "<working directory>"');
  process.exit(1);
}

// Resolve the same way the server does. On Windows npm installs codex as a
// .cmd shim plus a POSIX script and puts no .exe on PATH, so a plain
// execFileSync('codex') fails with ENOENT even though the shell finds it.
const windows = process.platform === 'win32';
const candidates = windows ? ['codex.exe', 'codex.cmd'] : ['codex'];
let resolved = null;
for (const dir of (process.env.PATH ?? '').split(delimiter)) {
  for (const candidate of candidates) {
    const full = dir && join(dir, candidate);
    if (full && existsSync(full)) { resolved = full; break; }
  }
  if (resolved) break;
}
if (!resolved) {
  console.error('codex is not installed. Install it with:  npm install -g @openai/codex');
  process.exit(1);
}
try {
  const version = resolved.toLowerCase().endsWith('.cmd')
    ? execFileSync(`"${resolved}" --version`, { encoding: 'utf8', shell: true }).trim()
    : execFileSync(resolved, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`codex found: ${version}`);
} catch (err) {
  console.error(`codex was found at ${resolved} but would not run: ${err.message}`);
  process.exit(1);
}

const ws = new WebSocket('ws://127.0.0.1:4317/ws');
const send = (m) => ws.send(JSON.stringify(m));

let sessionId = null;
const states = [];
let threadId = null;
let draftChars = 0;
let tokens = 0;
let approvals = 0;

const finish = (verdict) => {
  console.log(`\nstates: ${states.join(' -> ')}`);
  console.log(`thread id: ${threadId ?? '(none reported)'}`);
  console.log(`streamed characters: ${draftChars}`);
  console.log(`tokens counted: ${tokens}`);
  console.log(`approvals brokered: ${approvals}`);
  console.log(`\n${verdict}`);
  if (sessionId) send({ type: 'remove_session', sessionId });
  setTimeout(() => process.exit(0), 500);
};

const timer = setTimeout(() => finish('TIMEOUT — see the states above for how far it got.'), 180_000);

ws.addEventListener('open', () => {
  console.log('launching a Codex session...');
  send({
    type: 'launch_session',
    agent: 'codex',
    cwd,
    permissionMode: 'default',
    prompt: 'Run the shell command `echo claudia-codex-smoke`, then reply with just: done',
  });
});

ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data);

  if (m.type === 'session_upsert') {
    const s = m.session;
    if (!sessionId) {
      sessionId = s.id;
      console.log(`session ${s.id} (agent=${s.agent ?? 'claude'})`);
    }
    if (s.id !== sessionId) return;
    if (states[states.length - 1] !== s.state) states.push(s.state);
    if (s.claudeSessionId && !threadId) threadId = s.claudeSessionId;
    tokens = (s.inputTokens ?? 0) + (s.outputTokens ?? 0);

    if (s.pendingApproval) {
      approvals += 1;
      console.log(`  approval asked: ${s.pendingApproval.toolName} - ${s.pendingApproval.summary}`);
      send({ type: 'approve', sessionId, requestId: s.pendingApproval.requestId });
      console.log('  -> approved');
    }

    if (s.state === 'error') {
      clearTimeout(timer);
      finish(`FAIL — session errored: ${s.errorMessage ?? '(no message)'}`);
    }
    if (s.state === 'idle' && states.includes('working')) {
      clearTimeout(timer);
      finish(tokens > 0 ? 'PASS — the turn completed and reported token usage.' : 'PARTIAL — turn completed but no tokens were reported.');
    }
  }

  if (m.type === 'draft' && m.sessionId === sessionId && m.text) draftChars = m.text.length;

  if (m.type === 'feed_append' && m.sessionId === sessionId) {
    console.log(`  feed: ${m.step.title}${m.step.meta ? ` - ${m.step.meta}` : ''}`);
  }
});

ws.addEventListener('error', () => {
  console.error('could not reach Claudia on 127.0.0.1:4317 — start it first.');
  process.exit(1);
});
