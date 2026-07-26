/**
 * Who is allowed to talk to a loopback server.
 *
 * Binding to 127.0.0.1 keeps other machines out; it does nothing about other
 * pages on this one. Two gaps matter here, and for Claudia both are remote code
 * execution rather than mere information leaks, because a single `launch_session`
 * command starts a Claude Code session — optionally with permissions bypassed —
 * in any directory the sender names.
 *
 * 1. Browsers do not apply the same-origin policy to WebSockets. There is no
 *    preflight and no CORS: any page you visit can open ws://127.0.0.1:4317 and
 *    exchange messages. The browser does send `Origin`, so checking it is what
 *    separates our own UI from an attacker's page.
 *
 * 2. DNS rebinding survives an origin check on its own. The attacker points
 *    their domain at 127.0.0.1, so the browser believes their page is
 *    same-origin with us. The `Host` header still carries the attacker's name,
 *    so requiring a loopback literal there stops the page loading at all.
 *
 * Deliberately not a token or password. Anything already running as this user
 * can read a token file, and the threat being defended against is a remote page
 * with no filesystem access — so a secret adds ceremony without adding safety.
 */

/** Hostnames that can only ever mean this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1') return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Validates the `Host` header — the DNS-rebinding defence.
 *
 * A missing Host is malformed for HTTP/1.1 and is rejected rather than assumed
 * friendly.
 */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  // Bracketed IPv6 ("[::1]:4317") keeps its brackets; everything else splits on
  // the port separator.
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
  return isLoopbackHostname(hostname);
}

/**
 * Validates the `Origin` header — the cross-origin WebSocket defence.
 *
 * Any loopback origin passes, whatever its port: in development the UI is
 * served by Vite on a different port than the API, and both are equally "a page
 * served by this machine".
 *
 * An absent Origin is allowed, because it means no browser page is behind the
 * request at all — curl, a health probe, the test suite. Those already run with
 * this user's privileges, so refusing them protects nothing and breaks tooling.
 * A literal "null" origin is NOT absent: it is what a sandboxed iframe or a
 * file:// page sends, which is a browser context we have no reason to trust.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    // Unparseable, including the literal "null".
    return false;
  }
}
