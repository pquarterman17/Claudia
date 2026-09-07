import { CLAUDIA_PORT } from '@claudia/shared';

/**
 * Talk to the server directly on its own port rather than through Vite's dev
 * proxy. The proxy silently stops forwarding the WS upgrade once the upstream
 * has restarted a few times, which looks exactly like a dead server; going
 * direct removes that failure mode and behaves identically in a built app.
 */
export function serverUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // In production the server serves the UI too, so it is simply this origin.
  // In dev the UI comes from Vite on another port, so aim at the server's.
  const host = import.meta.env.DEV ? `${location.hostname}:${CLAUDIA_PORT}` : location.host;
  return `${scheme}://${host}/ws`;
}
