// Drive a real chain run end to end: build it, arm it, launch a trivial
// session, and watch each step transition.
// The directory to run the test session in. Defaults to the current one so the
// script works from any checkout, on any machine.
const cwd = (process.argv[2] ?? process.cwd()).split('\\').join('/');

const ws = new WebSocket('ws://127.0.0.1:4317/ws');
let armed = false;
const seen = [];

const snap = (chain) => chain.map(s => `${s.key}:${s.state}`).join(' ');

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'clear_finish_chain' }));
  ws.send(JSON.stringify({ type: 'toggle_finish_action', action: 'notify' }));
  ws.send(JSON.stringify({ type: 'toggle_finish_action', action: 'memory' }));
  ws.send(JSON.stringify({ type: 'set_countdown', seconds: 5 }));
});

ws.addEventListener('message', (e) => {
  const v = JSON.parse(e.data);
  if (v.type === 'server_error') console.log('SERVER ERROR:', v.message);
  if (v.type === 'session_upsert') console.log('  session:', v.session.name, v.session.state, v.session.errorMessage ?? '');
  if (v.type === 'trigger_status') {
    const line = `${v.trigger.state} [${snap(v.trigger.chain)}]${v.trigger.countdownSec !== undefined ? ' ' + v.trigger.countdownSec + 's' : ''}${v.trigger.blockedBy ? ' held:' + v.trigger.blockedBy : ''}`;
    if (seen[seen.length - 1] !== line) { seen.push(line); console.log(line); }
    if (!armed && v.trigger.chain.length === 2) {
      armed = true;
      ws.send(JSON.stringify({ type: 'arm_trigger' }));
      // Forward slashes on purpose: valid on Windows and they survive shells.
      ws.send(JSON.stringify({ type: 'launch_session', cwd, prompt: 'Reply with exactly: ready' }));
    }
    if (v.trigger.state === 'fired') {
      console.log('\nRESULT:', v.trigger.lastResult);
      v.trigger.chain.forEach(s => console.log(`  ${s.key}: ${s.state} (${s.durMs}ms) — ${s.detail ?? ''}`));
      process.exit(0);
    }
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 400000);
