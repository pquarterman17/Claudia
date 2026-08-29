import type { PendingQuestion } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../src/approval-gate.js';
import type { Channel, CodexApproval } from '../src/codex-client.js';
import { CodexDriver, decideCodexApproval } from '../src/codex-driver.js';
import { encodeDecision } from '../src/codex-protocol.js';
import { CodexNotInstalledError, type CodexProcess } from '../src/codex-process.js';
import type { GateCtx } from '../src/gate-actions.js';

/**
 * The seam this covers: a Codex approval must park on the exact same
 * ApprovalGate a Claude tool call uses (decideCodexApproval), and the driver
 * that hosts `codex app-server` must degrade a missing install — or any
 * transport failure — to a session error rather than a crash.
 */

function gateHarness(): { ctx: GateCtx; gate: ApprovalGate } {
  const gate = new ApprovalGate();
  let question: PendingQuestion | undefined;
  const ctx: GateCtx = {
    gate,
    feed: () => undefined,
    setState: () => undefined,
    getQuestion: () => question,
    setQuestion: (q) => (question = q),
    clearQuestion: () => (question = undefined),
  };
  return { ctx, gate };
}

describe('decideCodexApproval — the same gate a Claude tool call parks on', () => {
  it('approve resolves to the bare-string decision', async () => {
    const { ctx, gate } = gateHarness();
    const approval: CodexApproval = { kind: 'exec', summary: 'git status', params: { command: ['git', 'status'] } };
    const decision = decideCodexApproval(ctx, approval);
    expect(gate.isWaiting).toBe(true);
    gate.approve(gate.current!.requestId);
    await expect(decision).resolves.toEqual({ kind: 'approved' });
  });

  it('deny carries the user\'s message through to the {denied:{rejection}} wire shape', async () => {
    const { ctx, gate } = gateHarness();
    const approval: CodexApproval = { kind: 'patch', summary: '/repo/a.ts', params: { fileChanges: { '/repo/a.ts': {} } } };
    const decision = decideCodexApproval(ctx, approval);
    gate.deny(gate.current!.requestId, 'not on main');
    const result = await decision;
    expect(result).toEqual({ kind: 'denied', rejection: 'not on main' });
    // A bare "deny" string would hang the turn forever — must be an object.
    expect(encodeDecision(result)).toEqual({ denied: { rejection: 'not on main' } });
  });

  it('an unanswered approval still resolves when the session tears down (gate.abandon)', async () => {
    const { ctx, gate } = gateHarness();
    const decision = decideCodexApproval(ctx, { kind: 'exec', summary: 'rm -rf /', params: {} });
    gate.abandon('Session stopped');
    await expect(decision).resolves.toEqual({ kind: 'denied', rejection: 'Session stopped' });
  });

  it('shows the exec command as the approval summary, not a raw dump of params', async () => {
    const { ctx, gate } = gateHarness();
    void decideCodexApproval(ctx, { kind: 'exec', summary: 'npm test', params: { command: ['npm', 'test'], cwd: '/repo' } });
    expect(gate.current?.summary).toBe('npm test');
    gate.abandon('cleanup');
  });
});

// ---------- CodexDriver ----------

function fakeProcess(): {
  proc: CodexProcess;
  sent: Array<Record<string, unknown>>;
  emit: (frame: Record<string, unknown>) => void;
  settleExit: (result: { code: number | null; stderr: string }) => void;
  failExit: (err: unknown) => void;
  closed: boolean;
} {
  const sent: Array<Record<string, unknown>> = [];
  let onLine: (line: string) => void = () => {};
  let settleExit!: (result: { code: number | null; stderr: string }) => void;
  let failExit!: (err: unknown) => void;
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    settleExit = resolve;
    failExit = reject;
  });
  const state = { closed: false };
  const channel: Channel = {
    send: (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
    onLine: (handler) => (onLine = handler),
    close: () => (state.closed = true),
  };
  return {
    proc: { channel, exited },
    sent,
    emit: (frame) => onLine(`${JSON.stringify(frame)}\n`),
    settleExit,
    failExit,
    get closed() {
      return state.closed;
    },
  };
}

const noopApproval = async () => ({ kind: 'approved' as const });

describe('CodexDriver startup', () => {
  it('surfaces a missing install as a session error instead of throwing', async () => {
    const driver = new CodexDriver({
      cwd: '/repo',
      onApproval: noopApproval,
      spawn: () => {
        throw new CodexNotInstalledError();
      },
    });
    const iter = driver[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ state: 'error' });
    expect(first.value.errorMessage).toMatch(/npm install -g @openai\/codex/);
    // The stream ends there — nothing left to iterate once startup failed.
    await expect(iter.next()).resolves.toMatchObject({ done: true });
  });

  it('surfaces an async ENOENT from the child process the same way', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    fp.failExit(new CodexNotInstalledError());
    const { value } = await driver[Symbol.asyncIterator]().next();
    expect(value.errorMessage).toMatch(/not installed/i);
  });

  it('treats a nonzero exit as a session error but a clean exit as just ending', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    fp.settleExit({ code: 1, stderr: 'panic: thread crashed' });
    const { value } = await driver[Symbol.asyncIterator]().next();
    expect(value).toMatchObject({ state: 'error', errorMessage: 'panic: thread crashed' });
  });
});

describe('CodexDriver message flow', () => {
  it('forwards a server notification as a RoutedMessage, unmodified by the driver', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    const iter = driver[Symbol.asyncIterator]();
    fp.emit({ method: 'thread/started', params: { threadId: 'th_abc' } });
    const { value } = await iter.next();
    expect(value).toMatchObject({ state: 'working', claudeSessionId: 'th_abc' });
  });

  it('sendPrompt starts a thread, then the turn, once the thread id comes back', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });

    driver.sendPrompt('do the thing');
    await vi.waitFor(() => expect(fp.sent.some((f) => f['method'] === 'thread/start')).toBe(true));
    const startReq = fp.sent.find((f) => f['method'] === 'thread/start')!;
    expect(startReq['params']).toMatchObject({ workingDirectory: '/repo' });
    fp.emit({ id: startReq['id'], result: { threadId: 'th_9' } });

    await vi.waitFor(() => expect(fp.sent.some((f) => f['method'] === 'turn/start')).toBe(true));
    const turnReq = fp.sent.find((f) => f['method'] === 'turn/start');
    expect(turnReq).toMatchObject({ params: { threadId: 'th_9', input: [{ type: 'text', text: 'do the thing' }] } });
  });

  it('a second sendPrompt reuses the thread instead of starting another one', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    driver.sendPrompt('first');
    await vi.waitFor(() => expect(fp.sent.some((f) => f['method'] === 'thread/start')).toBe(true));
    const startReq = fp.sent.find((f) => f['method'] === 'thread/start')!;
    fp.emit({ id: startReq['id'], result: { threadId: 'th_1' } });
    await vi.waitFor(() => expect(fp.sent.some((f) => f['method'] === 'turn/start')).toBe(true));

    driver.sendPrompt('second');
    await vi.waitFor(() => expect(fp.sent.filter((f) => f['method'] === 'turn/start')).toHaveLength(2));
    expect(fp.sent.filter((f) => f['method'] === 'thread/start')).toHaveLength(1);
  });

  it('interrupt is a no-op before any turn has started', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    await expect(driver.interrupt()).resolves.toBeUndefined();
    // The constructor's handshake request is expected; no turn to cancel yet.
    expect(fp.sent.some((f) => f['method'] === 'turn/interrupt')).toBe(false);
  });

  it('close tears down the channel and ends the message stream', async () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    driver.close();
    expect(fp.closed).toBe(true);
    await expect(driver[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
  });

  it('exposes no raw query — every Claude-only operation degrades on its own', () => {
    const fp = fakeProcess();
    const driver = new CodexDriver({ cwd: '/repo', onApproval: noopApproval, spawn: () => fp.proc });
    expect(driver.raw).toBeUndefined();
  });
});
