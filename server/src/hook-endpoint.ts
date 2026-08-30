import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HookMonitor } from './hook-monitor.js';

/**
 * Biggest hook payload worth reading.
 *
 * PreToolUse carries the whole `tool_input`, so a Write of a large file arrives
 * in full. Nothing here needs that — the tile shows a tool NAME — so an
 * oversized body is drained and dropped rather than buffered.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Receives hook payloads from Claude Code sessions Claudia did not launch.
 *
 * Two rules shape this. It ALWAYS answers 200, and answers before doing any
 * work of its own: a hook runs inside the user's session, and a Claudia that
 * is slow, broken or mid-restart must never be something the user feels in a
 * terminal that has nothing to do with it. And it never throws — a malformed
 * body is somebody else's POST to a port we happen to own, not an event.
 *
 * The loopback host check in index.ts applies to this route like any other,
 * which is what keeps it off the network.
 */
export function createHookHandler(
  monitor: HookMonitor,
  onChange: () => void,
  limit = MAX_BODY_BYTES,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    if (req.method !== 'POST') return false;
    // Query strings are not used, but a stray one must not miss the route.
    if ((req.url ?? '').split('?')[0] !== '/hooks') return false;

    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      // Answer first: the session on the other end is waiting on this.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      if (oversized) return;
      try {
        if (monitor.record(JSON.parse(Buffer.concat(chunks).toString('utf8')))) onChange();
      } catch {
        // Not JSON, or not a payload we understand. Nothing to report to a
        // hook, which has no way to show an error to anyone anyway.
      }
    });

    // A connection that dies mid-body leaves nothing to record, and there is
    // no one to tell; the listener exists so the error is not unhandled.
    req.on('error', () => undefined);
    return true;
  };
}
