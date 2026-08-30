import { CLAUDIA_PORT } from '@claudia/shared';

/**
 * Which port the server listens on.
 *
 * The default is fixed so a bookmark keeps working, but it has to be
 * overridable: a second instance cannot bind an occupied 4317, and the desktop
 * shell needs somewhere to go when another app already holds the default. `0`
 * asks the OS for an ephemeral port. The browser client builds its own URL from
 * `location.host`, so an override needs no client change.
 *
 * Pure, and separate from index.ts, so the parsing is testable — a bad value
 * must fall back rather than crash the supervisor at startup.
 */
export function resolvePort(raw: string | undefined): { port: number; warning?: string } {
  if (raw === undefined || raw.trim() === '') return { port: CLAUDIA_PORT };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return { port: CLAUDIA_PORT, warning: `ignoring CLAUDIA_PORT="${raw}": not a port number` };
  }
  return { port: parsed };
}
