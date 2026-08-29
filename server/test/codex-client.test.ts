import { describe, expect, it, vi } from 'vitest';
import { CodexClient, describeApproval, type Channel, type CodexApproval } from '../src/codex-client.js';
import type { CodexDecision } from '../src/codex-protocol.js';

/**
 * Drives the whole client through a fake channel. No Codex install, no child
 * process — which is the point: this driver cannot be exercised end-to-end on a
 * machine without Codex and an OpenAI login, so the protocol behaviour has to
 * be provable without one.
 */

interface Harness {
  client: CodexClient;
  /** Frames the client wrote, already parsed. */
  sent: Array<Record<string, unknown>>;
  /** Feeds a line to the client as if it came from Codex stdout. */
  emit: (frame: Record<string, unknown>) => void;
  /** Feeds raw text, for partial-line and garbage cases. */
  emitRaw: (text: string) => void;
  approvals: CodexApproval[];
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
  closed: boolean;
}

function harness(decide: (a: CodexApproval) => Promise<CodexDecision> = async () => ({ kind: 'approved' })): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const approvals: CodexApproval[] = [];
  let onLine: (line: string) => void = () => {};
  const state = { closed: false };

  const channel: Channel = {
    send: (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
    onLine: (handler) => (onLine = handler),
    close: () => (state.closed = true),
  };

  const client = new CodexClient(channel, {
    onNotify: (method, params) => notifications.push({ method, params }),
    onApproval: async (a) => {
      approvals.push(a);
      return decide(a);
    },
    onClose: () => undefined,
  });

  return {
    client,
    sent,
    notifications,
    approvals,
    emit: (frame) => onLine(`${JSON.stringify(frame)}\n`),
    emitRaw: (text) => onLine(text),
    get closed() {
      return state.closed;
    },
  };
}

/** Replies to whichever request the client sent last. */
const replyToLast = (h: Harness, result: unknown) => {
  const last = h.sent[h.sent.length - 1];
  h.emit({ id: last?.['id'], result });
};

describe('wire format', () => {
  it('omits the jsonrpc member, which app-server does not use', () => {
    const h = harness();
    void h.client.initialize();
    expect(h.sent[0]).not.toHaveProperty('jsonrpc');
    expect(h.sent[0]).toMatchObject({ method: 'initialize' });
  });

  it('completes the mandated handshake: initialize, then an initialized notification', async () => {
    const h = harness();
    const started = h.client.initialize();
    replyToLast(h, { userAgent: 'codex', codexHome: '/home/.codex' });
    await started;
    expect(h.sent.map((f) => f['method'])).toEqual(['initialize', 'initialized']);
    // The notification carries no id; only requests do.
    expect(h.sent[1]).not.toHaveProperty('id');
  });

  it('correlates responses to their own request, not by arrival order', async () => {
    const h = harness();
    const first = h.client.startThread({ workingDirectory: '/a' });
    const second = h.client.startThread({ workingDirectory: '/b' });
    const [idA, idB] = h.sent.map((f) => f['id']);
    // Answer out of order, which a concurrent server is free to do.
    h.emit({ id: idB, result: { threadId: 'th_b' } });
    h.emit({ id: idA, result: { threadId: 'th_a' } });
    expect(await first).toBe('th_a');
    expect(await second).toBe('th_b');
  });

  it('rejects the caller when the server returns an error', async () => {
    const h = harness();
    const started = h.client.startThread({});
    replyToLast(h, undefined);
    const last = h.sent[h.sent.length - 1];
    h.emit({ id: last?.['id'], error: { code: -32001, message: 'Server overloaded; retry later.' } });
    await expect(started).resolves.toBeUndefined();
  });
});

describe('framing', () => {
  it('handles a frame split across two chunks', async () => {
    const h = harness();
    const started = h.client.startThread({});
    const id = h.sent[0]?.['id'];
    h.emitRaw(`{"id":${JSON.stringify(id)},"result":{"thre`);
    h.emitRaw('adId":"th_split"}}\n');
    expect(await started).toBe('th_split');
  });

  it('handles two frames arriving in one chunk', () => {
    const h = harness();
    h.emitRaw('{"method":"turn/started","params":{}}\n{"method":"turn/completed","params":{}}\n');
    expect(h.notifications.map((n) => n.method)).toEqual(['turn/started', 'turn/completed']);
  });

  it('ignores a non-JSON line rather than killing the session', () => {
    // Codex logs to stderr, but a stray line on stdout must not be fatal.
    const h = harness();
    h.emitRaw('some stray log line\n');
    h.emit({ method: 'turn/started', params: {} });
    expect(h.notifications).toHaveLength(1);
  });
});

describe('approvals — the reason this uses app-server at all', () => {
  it('asks the handler and answers with the decision', async () => {
    const h = harness();
    h.emit({
      id: 41,
      method: 'execCommandApproval',
      params: { conversationId: 'th_1', callId: 'call_1', command: ['bash', '-lc', 'git status'], cwd: '/repo' },
    });
    await vi.waitFor(() => expect(h.approvals).toHaveLength(1));
    expect(h.approvals[0]).toMatchObject({ kind: 'exec', summary: 'bash -lc git status' });
    await vi.waitFor(() => expect(h.sent.some((f) => f['id'] === 41)).toBe(true));
    expect(h.sent.find((f) => f['id'] === 41)).toMatchObject({ result: { decision: 'approved' } });
  });

  it('sends deny as an object, because a bare string would hang the turn', async () => {
    const h = harness(async () => ({ kind: 'denied', rejection: 'not on main' }));
    h.emit({ id: 7, method: 'applyPatchApproval', params: { fileChanges: { '/repo/a.ts': {} } } });
    await vi.waitFor(() => expect(h.sent.some((f) => f['id'] === 7)).toBe(true));
    expect(h.sent.find((f) => f['id'] === 7)).toMatchObject({
      result: { decision: { denied: { rejection: 'not on main' } } },
    });
  });

  it('always answers, even when the handler throws — an unanswered request stalls Codex forever', async () => {
    const h = harness(async () => {
      throw new Error('gate exploded');
    });
    h.emit({ id: 9, method: 'execCommandApproval', params: { command: ['ls'] } });
    await vi.waitFor(() => expect(h.sent.some((f) => f['id'] === 9)).toBe(true));
    const reply = h.sent.find((f) => f['id'] === 9) as { result?: { decision?: unknown } };
    expect(reply.result?.decision).toMatchObject({ denied: {} });
  });

  it('answers an unknown server request with an error instead of silence', async () => {
    const h = harness();
    h.emit({ id: 12, method: 'someFutureRequest', params: {} });
    await vi.waitFor(() => expect(h.sent.some((f) => f['id'] === 12)).toBe(true));
    expect(h.sent.find((f) => f['id'] === 12)).toHaveProperty('error');
  });
});

describe('describeApproval', () => {
  it('summarises a single-file patch by its path', () => {
    const a = describeApproval('applyPatchApproval', { fileChanges: { '/repo/only.ts': {} } });
    expect(a?.summary).toBe('/repo/only.ts');
  });

  it('counts a multi-file patch', () => {
    const a = describeApproval('applyPatchApproval', {
      fileChanges: { '/a.ts': {}, '/b.ts': {}, '/c.ts': {} },
    });
    expect(a?.summary).toContain('3 files');
  });

  it('is null for anything that is not an approval', () => {
    expect(describeApproval('turn/started', {})).toBeNull();
  });
});

describe('shutdown', () => {
  it('rejects in-flight requests and closes the channel', async () => {
    const h = harness();
    const inflight = h.client.startThread({});
    h.client.close();
    await expect(inflight).rejects.toThrow(/closed/i);
    expect(h.closed).toBe(true);
  });
});
