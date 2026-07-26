import type { TranscriptItem } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { UsageService } from '../src/usage-service.js';

/**
 * Covers arming and capturing a `/cost` answer. The service is constructed
 * without ever calling start(), so no reader scan or timer runs — these
 * exercise the capture state machine only.
 */

const COST_REPLY = `You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Jul 26, 8:30pm (America/New_York)
Current week (all models): 27% used · resets Jul 29, 10pm (America/New_York)`;

const assistant = (text: string): TranscriptItem => ({ ts: 0, kind: 'assistant', text });

const service = () => new UsageService(() => {});

describe('real usage capture', () => {
  it('captures a reply that parses', () => {
    const s = service();
    s.requestReal('sess-1', () => {});
    s.captureReal('sess-1', assistant(COST_REPLY));
    const real = s.snapshot().real;
    expect(real?.windows).toHaveLength(2);
    expect(real?.sessionId).toBe('sess-1');
  });

  it('ignores replies from a different session', () => {
    const s = service();
    s.requestReal('sess-1', () => {});
    s.captureReal('sess-2', assistant(COST_REPLY));
    expect(s.snapshot().real).toBeNull();
  });

  it('stays armed through an unrelated reply, then captures the real one', () => {
    // The regression this guards: asking a session that is mid-turn. The
    // running turn's own reply arrives first. Consuming the arm on it left the
    // button finished and no data shown.
    const s = service();
    s.requestReal('sess-1', () => {});
    s.captureReal('sess-1', assistant('Done — I updated three files.'));
    expect(s.snapshot().real).toBeNull();
    expect(s.snapshot().realPending).toBe(true);

    s.captureReal('sess-1', assistant(COST_REPLY));
    expect(s.snapshot().real?.windows).toHaveLength(2);
    expect(s.snapshot().realPending).toBe(false);
  });

  it('ignores non-assistant transcript items', () => {
    const s = service();
    s.requestReal('sess-1', () => {});
    s.captureReal('sess-1', { ts: 0, kind: 'user', text: COST_REPLY });
    expect(s.snapshot().real).toBeNull();
    expect(s.snapshot().realPending).toBe(true);
  });

  it('gives up after the arm expires, so the button is never stranded', () => {
    const s = service();
    const t0 = 1_000_000;
    s.requestReal('sess-1', () => {}, t0);
    const tooLate = t0 + 5 * 60_000 + 1;
    s.captureReal('sess-1', assistant(COST_REPLY), tooLate);
    expect(s.snapshot(tooLate).real).toBeNull();
    expect(s.snapshot(tooLate).realPending).toBe(false);
  });

  it('still captures just inside the expiry window', () => {
    const s = service();
    const t0 = 1_000_000;
    s.requestReal('sess-1', () => {}, t0);
    const justInTime = t0 + 5 * 60_000 - 1;
    s.captureReal('sess-1', assistant(COST_REPLY), justInTime);
    expect(s.snapshot(justInTime).real?.windows).toHaveLength(2);
  });

  it('runs the caller-supplied send exactly once', () => {
    const send = vi.fn();
    service().requestReal('sess-1', send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
