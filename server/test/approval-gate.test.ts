import { describe, expect, it } from 'vitest';
import { ApprovalGate } from '../src/approval-gate.js';

describe('ApprovalGate', () => {
  it('parks a request and resolves allow with the original input', async () => {
    const gate = new ApprovalGate();
    const input = { command: 'git push' };
    const promise = gate.request('Bash', 'git push', input);

    expect(gate.isWaiting).toBe(true);
    expect(gate.current?.toolName).toBe('Bash');

    expect(gate.approve(gate.current!.requestId)).toBe(true);
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(gate.isWaiting).toBe(false);
    expect(gate.current).toBeUndefined();
  });

  it('resolves deny with a message', async () => {
    const gate = new ApprovalGate();
    const promise = gate.request('Bash', 'rm -rf /', {});
    gate.deny(gate.current!.requestId, 'absolutely not');
    await expect(promise).resolves.toEqual({ behavior: 'deny', message: 'absolutely not' });
  });

  it('supplies a default deny message', async () => {
    const gate = new ApprovalGate();
    const promise = gate.request('Bash', 'x', {});
    gate.deny(gate.current!.requestId);
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('ignores a stale request id and keeps waiting', async () => {
    const gate = new ApprovalGate();
    const promise = gate.request('Bash', 'x', {});
    expect(gate.approve('not-the-id')).toBe(false);
    expect(gate.deny('not-the-id')).toBe(false);
    expect(gate.isWaiting).toBe(true);

    gate.approve(gate.current!.requestId);
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('returns false when nothing is pending', () => {
    const gate = new ApprovalGate();
    expect(gate.approve('anything')).toBe(false);
  });

  it('abandon settles the promise so the SDK never hangs on teardown', async () => {
    const gate = new ApprovalGate();
    const promise = gate.request('Bash', 'x', {});
    gate.abandon('Session stopped');
    await expect(promise).resolves.toEqual({ behavior: 'deny', message: 'Session stopped' });
    expect(gate.isWaiting).toBe(false);
  });

  it('abandon is safe with nothing pending', () => {
    expect(() => new ApprovalGate().abandon('nothing')).not.toThrow();
  });

  it('a superseding request denies the previous one rather than leaking it', async () => {
    const gate = new ApprovalGate();
    const first = gate.request('Bash', 'one', {});
    const second = gate.request('Bash', 'two', { command: 'two' });
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });

    gate.approve(gate.current!.requestId);
    await expect(second).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'two' } });
  });
});

describe('AsyncQueue drain', () => {
  it('hands over buffered items and leaves the queue empty', async () => {
    const { AsyncQueue } = await import('../src/async-queue.js');
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(q.drain()).toEqual([1, 2]);
    expect(q.drain()).toEqual([]);
  });

  it('does not return items a consumer already took', async () => {
    const { AsyncQueue } = await import('../src/async-queue.js');
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    const it = q[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(1);
    expect(q.drain()).toEqual([2]);
  });
});
