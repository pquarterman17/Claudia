import { describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedOrigin, isAllowedRequest, isLoopbackHostname } from '../src/origin-guard.js';

describe('isLoopbackHostname', () => {
  it('accepts every spelling of this machine', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });

  it('rejects anything that could resolve elsewhere', () => {
    // 0.0.0.0 is "all interfaces", not loopback, and a page served from it is
    // reachable from the network.
    for (const h of ['evil.example', '0.0.0.0', '192.168.1.4', '10.0.0.1', 'localhost.evil.example', '']) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});

describe('isAllowedHost — DNS-rebinding defence', () => {
  it('accepts the ways our own launchers reach us', () => {
    for (const h of ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317', 'localhost']) {
      expect(isAllowedHost(h), h).toBe(true);
    }
  });

  it('rejects an attacker domain rebound to 127.0.0.1', () => {
    // The whole point: the socket arrives on loopback, but the browser still
    // tells us which name it dialled.
    expect(isAllowedHost('totally-evil.example:4317')).toBe(false);
  });

  it('rejects a missing Host rather than assuming it is friendly', () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
  });
});

describe('isAllowedOrigin — cross-origin WebSocket defence', () => {
  it('accepts loopback pages on any port, since dev serves the UI elsewhere', () => {
    for (const o of ['http://127.0.0.1:4317', 'http://localhost:4318', 'https://localhost', 'http://[::1]:4317']) {
      expect(isAllowedOrigin(o), o).toBe(true);
    }
  });

  it('rejects a remote page opening a socket to us', () => {
    // Browsers do not enforce same-origin on WebSockets, so this check is the
    // only thing standing between a visited page and launch_session.
    expect(isAllowedOrigin('https://totally-evil.example')).toBe(false);
    expect(isAllowedOrigin('http://evil.example:4317')).toBe(false);
  });

  it('allows a request with no Origin at all — not a browser page', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('rejects the "null" origin of a sandboxed iframe or file:// page', () => {
    // "null" is a browser context we cannot attribute, which is different from
    // having no browser behind the request.
    expect(isAllowedOrigin('null')).toBe(false);
  });
});

/**
 * The two checks together, which is how both doors must ask.
 *
 * Wiring, not arithmetic: the socket asked for both from the start and the
 * HTTP server asked only about Host, so `POST /hooks` — which mutates state
 * and needs no preflight at a CORS-safelisted content type — was reachable
 * from any page the user happened to visit. Reproduced against a running
 * server before the fix: a POST bearing `Origin: https://evil.example.com`
 * put a session on the board with a `cwd` of the attacker's choosing.
 *
 * The Host check cannot catch that on its own. An attacking page targets the
 * loopback LITERAL, so the Host header reads `127.0.0.1:4317` and passes.
 */
describe('isAllowedRequest', () => {
  it('turns away a page that posted straight at the loopback literal', () => {
    // Exactly what the Host check waves through, which is the point.
    expect(isAllowedHost('127.0.0.1:4317')).toBe(true);
    expect(isAllowedRequest({ host: '127.0.0.1:4317', origin: 'https://evil.example.com' })).toBe(false);
  });

  it('still lets a real hook in, which carries no Origin at all', () => {
    // The CLI posts these, not a browser. Refusing them would break the
    // feature this endpoint exists for.
    expect(isAllowedRequest({ host: '127.0.0.1:4317' })).toBe(true);
  });

  it('lets our own UI through, including the dev server on its own port', () => {
    expect(isAllowedRequest({ host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4318' })).toBe(true);
    expect(isAllowedRequest({ host: 'localhost:4317', origin: 'http://localhost:4317' })).toBe(true);
  });

  it('needs both: a rebound domain fails on Host even with no Origin', () => {
    expect(isAllowedRequest({ host: 'attacker.test:4317' })).toBe(false);
    expect(isAllowedRequest({ origin: 'http://127.0.0.1:4317' })).toBe(false);
  });
});
