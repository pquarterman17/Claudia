// End-to-end smoke: launch a real session through Claudia's WS gateway and
// watch state transitions + an approval round-trip.


const ws = new WebSocket('ws://127.0.0.1:4317/ws');
const cwd = process.argv[2];
const prompt = process.argv[3];
let sessionId = null;
const seenStates = [];
const steps = new Map();

const done = setTimeout(() => {
  console.log('\n--- TIMEOUT --- states seen:', seenStates.join(' → '));
  process.exit(0);
}, 120000);

ws.addEventListener('open', () => {
  console.log('[ws] connected');
  ws.send(JSON.stringify({ type: 'launch_session', cwd, prompt, permissionMode: 'default' }));
});

ws.addEventListener('message', (raw) => {
  const ev = JSON.parse(String(raw.data));
  if (ev.type === 'session_upsert') {
    sessionId = ev.session.id;
    const last = seenStates[seenStates.length - 1];
    if (last !== ev.session.state) {
      seenStates.push(ev.session.state);
      console.log(`[state] ${ev.session.state}  cost=$${ev.session.costUsd.toFixed(4)} tok=${ev.session.inputTokens}/${ev.session.outputTokens} model=${ev.session.model ?? '?'}`);
    }
    if (ev.session.pendingApproval) {
      const p = ev.session.pendingApproval;
      console.log(`[APPROVAL] ${p.toolName}: ${p.summary}  → auto-approving`);
      ws.send(JSON.stringify({ type: 'approve', sessionId, requestId: p.requestId }));
    }
    if (ev.session.state === 'idle') {
      console.log('\n--- SETTLED --- states:', seenStates.join(' → '));
      clearTimeout(done);
      ws.send(JSON.stringify({ type: 'remove_session', sessionId }));
      setTimeout(() => process.exit(0), 300);
    }
    if (ev.session.state === 'error') {
      console.log('[ERROR]', ev.session.errorMessage);
      clearTimeout(done);
      setTimeout(() => process.exit(1), 300);
    }
  }
  if (ev.type === 'feed_append') {
    const s = ev.step;
    steps.set(s.id, s);
    console.log(`  [${s.kind}] ${s.title}${s.meta ? ' — ' + s.meta : ''}${s.status === 'running' ? ' …' : ''}`);
  }
  if (ev.type === 'feed_update') {
    const s = steps.get(ev.stepId);
    const p = ev.patch;
    const mark = p.status === 'ok' ? 'OK ' : p.status === 'error' ? 'ERR' : '   ';
    console.log(`     ↳ ${mark} ${s ? s.title + (s.meta ? ' — ' + s.meta : '') : ev.stepId} (${p.durMs}ms)`);
  }
  if (ev.type === 'server_error') console.log('[server_error]', ev.message);
});

ws.addEventListener('error', (e) => { console.log('[ws error]', 'connect failed'); process.exit(1); });
