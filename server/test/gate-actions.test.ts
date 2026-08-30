import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingQuestion } from '@claudia/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ApprovalGate } from '../src/approval-gate.js';
import { alwaysAllowProject, approve, type GateCtx } from '../src/gate-actions.js';

const root = mkdtempSync(join(tmpdir(), 'claudia-gate-actions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project(): string {
  return join(root, `p${n++}`);
}

/**
 * Same harness shape as codex-driver.test.ts's gateHarness — this is the
 * seam every approve/deny/always-allow path is orchestrated through.
 */
function harness(): { ctx: GateCtx; gate: ApprovalGate; feed: unknown[] } {
  const gate = new ApprovalGate();
  const feed: unknown[] = [];
  let question: PendingQuestion | undefined;
  const ctx: GateCtx = {
    gate,
    feed: (step) => feed.push(step),
    setState: () => undefined,
    getQuestion: () => question,
    setQuestion: (q) => (question = q),
    clearQuestion: () => (question = undefined),
  };
  return { ctx, gate, feed };
}

describe('alwaysAllowProject', () => {
  it('writes the derived rule and approves the call it came from', async () => {
    const { ctx, gate } = harness();
    const promise = gate.request('Bash', 'npm test', { command: 'npm test' });
    const requestId = gate.current!.requestId;
    const cwd = project();

    const result = await alwaysAllowProject(ctx, requestId, cwd);

    expect(result).toEqual({ ok: true, message: 'Bash(npm test)' });
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(gate.isWaiting).toBe(false);

    const written = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash(npm test)']);
  });

  it('reports failure and leaves the request pending when no safe rule can be derived', async () => {
    const { ctx, gate } = harness();
    const promise = gate.request('WebFetch', 'https://example.com', { url: 'https://example.com' });
    const requestId = gate.current!.requestId;

    const result = await alwaysAllowProject(ctx, requestId, project());

    expect(result.ok).toBe(false);
    expect(gate.isWaiting).toBe(true); // still parked — the caller can still Approve/Deny by hand
    // Settle it so the promise doesn't dangle past the test.
    gate.deny(requestId);
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('refuses a stale request id and touches nothing', async () => {
    const { ctx, gate } = harness();
    gate.request('Bash', 'ls', { command: 'ls' });
    const cwd = project();

    const result = await alwaysAllowProject(ctx, 'not-the-real-id', cwd);

    expect(result.ok).toBe(false);
    expect(gate.isWaiting).toBe(true);
    expect(() => readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')).toThrow();
  });

  it('does not approve when the write itself fails', async () => {
    const { ctx, gate } = harness();
    const promise = gate.request('Bash', 'ls', { command: 'ls' });
    const requestId = gate.current!.requestId;
    const cwd = project();
    // A settings.local.json that exists but fails to parse — addAllowRule must abort.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json');

    const result = await alwaysAllowProject(ctx, requestId, cwd);

    expect(result.ok).toBe(false);
    expect(gate.isWaiting).toBe(true); // the call was never approved
    gate.deny(requestId);
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('reuses the ordinary approve() feed/state path on success', async () => {
    const { ctx, gate, feed } = harness();
    gate.request('Bash', 'npm test', { command: 'npm test' });
    const requestId = gate.current!.requestId;

    await alwaysAllowProject(ctx, requestId, project());

    // approve() feeds an "Approved" step; alwaysAllowProject adds its own
    // "Always allowed" step on top rather than replacing that path.
    expect(feed.some((s) => (s as { title: string }).title === 'Approved')).toBe(true);
    expect(feed.some((s) => (s as { title: string }).title === 'Always allowed in this project')).toBe(true);
  });
});

describe('approve (regression guard for the shared path alwaysAllowProject reuses)', () => {
  it('returns false for a stale id without side effects', () => {
    const { ctx } = harness();
    expect(approve(ctx, 'nope')).toBe(false);
  });
});
