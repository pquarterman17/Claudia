import type { ServerEvent } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { Orchestrators } from '../src/orchestrators.js';
import type { SessionManager } from '../src/session-manager.js';

/**
 * The facade the gateway talks to. Thin, but it owns two things that were
 * observed going wrong for real: which sessions the idle-stop must not kill,
 * and what a browser sees after a reload while a run is still going.
 */

/** Launches real-looking sessions whose turns never end, so runs stay running. */
function fakeManager(): SessionManager {
  let n = 0;
  const sessions = new Map<string, unknown>();
  return {
    launch: () => {
      const id = `s${(n += 1)}`;
      const session = {
        id,
        sendPrompt: () => undefined,
        summary: () => ({ id, state: 'idle' }),
        transcript: { list: () => [], cursor: () => 0, since: () => [] },
      };
      sessions.set(id, session);
      return session;
    },
    get: (id: string) => sessions.get(id),
    awaitSettled: () => new Promise(() => undefined),
  } as unknown as SessionManager;
}

const DEBATE = {
  type: 'start_debate',
  cwd: '/repo',
  objective: 'is this right',
  subject: 'plan',
  author: 'claude',
  reviewer: 'codex',
  rounds: 2,
} as const;

const CREW = {
  type: 'start_crew',
  cwd: '/repo',
  objective: 'build the thing',
  planner: 'claude',
  workers: ['claude', 'codex'],
  maxTasks: 2,
} as const;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('Orchestrators', () => {
  it('leaves commands it does not own to the caller', () => {
    const o = new Orchestrators(fakeManager(), () => undefined);
    expect(o.handle({ type: 'ping' })).toBe(false);
  });

  it('starts each kind of run and says it handled it', async () => {
    const events: ServerEvent[] = [];
    const o = new Orchestrators(fakeManager(), (e) => events.push(e));
    expect(o.handle({ ...DEBATE })).toBe(true);
    expect(o.handle({ ...CREW, workers: [...CREW.workers] })).toBe(true);
    await settle();
    expect(events.some((e) => e.type === 'debate')).toBe(true);
    expect(events.some((e) => e.type === 'crew')).toBe(true);
  });

  it('protects the sessions of both kinds of run from the idle-stop', async () => {
    // Observed live before this existed: both sides of a debate were stopped
    // between the critique and the answer, and the run reported that the
    // author had said nothing.
    const o = new Orchestrators(fakeManager(), () => undefined);
    o.handle({ ...DEBATE });
    o.handle({ ...CREW, workers: [...CREW.workers] });
    await settle();
    // Two for the debate, and the crew's planner while it is still splitting.
    expect(o.activeSessionIds().size).toBe(3);
  });

  it('owns nothing before a run is started', () => {
    const o = new Orchestrators(fakeManager(), () => undefined);
    expect(o.activeSessionIds().size).toBe(0);
  });

  it('replays every run to a browser that just connected', async () => {
    // A run outlives the socket that asked for it — that is the point of
    // starting one and walking away — so a reload must not show an empty panel.
    const o = new Orchestrators(fakeManager(), () => undefined);
    o.handle({ ...DEBATE });
    o.handle({ ...CREW, workers: [...CREW.workers] });
    await settle();

    const replayed: ServerEvent[] = [];
    o.replay((e) => replayed.push(e));
    expect(replayed.map((e) => e.type)).toEqual(['debate', 'crew']);
  });
});
