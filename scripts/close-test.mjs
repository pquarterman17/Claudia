// Connect, launch a session, disconnect, and see whether the server stops it.
const GRACE = 10;

function connect() {
  return new WebSocket('ws://127.0.0.1:4317/ws');
}

const a = connect();
let sessionId = null;

a.addEventListener('open', () => {
  // Beat like the real client does, so this socket counts as live until it closes.
  setInterval(() => {
    if (a.readyState === WebSocket.OPEN) a.send(JSON.stringify({ type: 'ping' }));
  }, 3000);
  a.send(JSON.stringify({ type: 'set_stop_on_close', seconds: GRACE }));
  a.send(
    JSON.stringify({
      type: 'launch_session',
      cwd: 'C:/Users/patri/git/Claudia',
      prompt: 'Reply with exactly: hello',
    }),
  );
});

a.addEventListener('message', (e) => {
  const v = JSON.parse(e.data);
  if (v.type === 'server_error') console.log('server_error:', v.message);
  if (v.type === 'session_upsert' && !sessionId) {
    sessionId = v.session.id;
    console.log('launched, state =', v.session.state);
    setTimeout(() => {
      console.log(`closing socket; expecting a stop within ~${GRACE}s`);
      a.close();
      // Poll with plain HTTP so we do not re-open a websocket and cancel the timer.
      const started = Date.now();
      const poll = setInterval(async () => {
        const r = await fetch('http://127.0.0.1:4317/health').then((x) => x.json());
        const secs = Math.round((Date.now() - started) / 1000);
        console.log(`  +${secs}s live=${r.live} total=${r.sessions}`);
        if (r.live === 0 || secs > GRACE + 25) {
          clearInterval(poll);
          console.log(r.live === 0 ? 'STOPPED as expected' : 'NOT STOPPED — feature broken');
          process.exit(0);
        }
      }, 3000);
    }, 4000);
  }
});
setTimeout(() => process.exit(1), 90000);
