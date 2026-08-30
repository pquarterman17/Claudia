import { describe, expect, it } from 'vitest';
import { CLAUDIA_PORT } from '@claudia/shared';
import { resolvePort } from '../src/resolve-port.js';

describe('resolvePort', () => {
  it('uses the fixed default when nothing is set, so a bookmark keeps working', () => {
    expect(resolvePort(undefined)).toEqual({ port: CLAUDIA_PORT });
    expect(resolvePort('')).toEqual({ port: CLAUDIA_PORT });
    expect(resolvePort('   ')).toEqual({ port: CLAUDIA_PORT });
  });

  it('accepts an explicit port, which is how a second instance coexists', () => {
    expect(resolvePort('4321').port).toBe(4321);
  });

  it('accepts 0 — the desktop shell needs an OS-assigned ephemeral port', () => {
    expect(resolvePort('0').port).toBe(0);
  });

  it('falls back with a warning rather than crashing the supervisor', () => {
    // This process supervises other people's long-running work; a typo in an
    // env var must never be the reason it fails to start.
    for (const bad of ['notaport', '-1', '70000', '80.5', 'NaN', '4317; rm -rf /']) {
      const result = resolvePort(bad);
      expect(result.port).toBe(CLAUDIA_PORT);
      expect(result.warning).toContain('not a port number');
    }
  });
});
