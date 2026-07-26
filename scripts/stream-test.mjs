// Does the draft stream? Count draft events and confirm the clear.
const ws = new WebSocket('ws://127.0.0.1:4317/ws');
let id = null, draftEvents = 0, cleared = false, firstDraftAt = 0, launchedAt = 0;
ws.addEventListener('open', () => {
  launchedAt = Date.now();
  ws.send(JSON.stringify({
    type: 'launch_session',
    cwd: 'C:/Users/patri/git/Claudia',
    permissionMode: 'bypassPermissions',
    prompt: 'Write three sentences about supervision. No tools.',
  }));
});
ws.addEventListener('message', (e) => {
  const v = JSON.parse(e.data);
  if (v.type === 'draft') {
    if (v.text === null) cleared = true;
    else {
      draftEvents++;
      if (draftEvents === 1) {
        firstDraftAt = Date.now();
        console.log(`first visible text after ${firstDraftAt - launchedAt}ms: "${v.text.slice(0, 40)}..."`);
      }
    }
  }
  if (v.type === 'session_upsert') {
    id = v.session.id;
    if (v.session.state === 'idle' && draftEvents > 0) {
      console.log(`draft events: ${draftEvents}, cleared on completion: ${cleared}`);
      ws.send(JSON.stringify({ type: 'remove_session', sessionId: id }));
      setTimeout(() => process.exit(0), 300);
    }
  }
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 120000);
