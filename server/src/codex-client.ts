import { APPROVAL_METHOD, METHOD, encodeDecision, type CodexDecision, type CodexFrame } from './codex-protocol.js';

/**
 * A JSON-RPC client for `codex app-server`.
 *
 * Split from the process that hosts it: the client takes a `Channel`, so every
 * protocol behaviour — the handshake, request correlation, approval replies —
 * is testable by feeding it lines, with no Codex install and no spawning. That
 * matters more than usual here, because this driver cannot be exercised
 * end-to-end on a machine without Codex and an OpenAI login.
 */

export interface Channel {
  send: (line: string) => void;
  onLine: (handler: (line: string) => void) => void;
  close: () => void;
}

/** A parked approval, mirroring how Claudia parks a Claude `canUseTool` call. */
export interface CodexApproval {
  /** 'exec' for a shell command, 'patch' for a file write. */
  kind: 'exec' | 'patch';
  /** One-line summary for the approval banner. */
  summary: string;
  /** Raw params, so the UI can show detail without this file knowing about it. */
  params: Record<string, unknown>;
}

export interface CodexHandlers {
  /** A notification arrived: method plus params, straight off the wire. */
  onNotify: (method: string, params: Record<string, unknown>) => void;
  /**
   * Codex wants permission. The turn HANGS until this resolves — there is no
   * server-side timeout — which is precisely why it is routed to a human
   * rather than auto-answered.
   */
  onApproval: (approval: CodexApproval) => Promise<CodexDecision>;
  /** The transport ended. */
  onClose: (reason?: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CodexClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly channel: Channel,
    private readonly handlers: CodexHandlers,
  ) {
    channel.onLine((line) => this.receive(line));
  }

  /**
   * The mandated opening exchange: one `initialize` request, then an
   * `initialized` notification. Anything sent before that is refused with
   * "Not initialized", and a second initialize with "Already initialized".
   */
  async initialize(clientName = 'Claudia', clientVersion = '0.1.0'): Promise<Record<string, unknown>> {
    const result = (await this.request(METHOD.initialize, {
      clientInfo: { name: clientName, version: clientVersion, title: 'Claudia' },
      capabilities: {},
    })) as Record<string, unknown>;
    this.notify(METHOD.initialized, {});
    return result ?? {};
  }

  /** Starts a thread and returns its id. */
  async startThread(options: Record<string, unknown>): Promise<string | undefined> {
    const result = (await this.request(METHOD.threadStart, options)) as Record<string, unknown> | undefined;
    return readThreadId(result);
  }

  /** Reopens a stored thread, restoring its history server-side. */
  async resumeThread(threadId: string, options: Record<string, unknown> = {}): Promise<string | undefined> {
    const result = (await this.request(METHOD.threadResume, { threadId, ...options })) as
      | Record<string, unknown>
      | undefined;
    return readThreadId(result) ?? threadId;
  }

  /** Submits user input. Resolves when the turn is accepted, not when it ends. */
  async startTurn(threadId: string, text: string): Promise<void> {
    await this.request(METHOD.turnStart, { threadId, input: [{ type: 'text', text }] });
  }

  /** Cancels an in-flight turn. */
  async interrupt(threadId: string, turnId?: string): Promise<void> {
    await this.request(METHOD.turnInterrupt, { threadId, ...(turnId ? { turnId } : {}) }).catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error('Codex connection closed'));
    this.pending.clear();
    this.channel.close();
  }

  /** Sends a request and waits for its matching response. */
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  /**
   * Writes one frame. The `"jsonrpc": "2.0"` member is deliberately absent:
   * app-server omits it on the wire, unlike ordinary JSON-RPC.
   */
  private write(frame: Record<string, unknown>): void {
    this.channel.send(`${JSON.stringify(frame)}\n`);
  }

  /** Accumulates stdout and dispatches each complete line. */
  private receive(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let frame: CodexFrame;
    try {
      frame = JSON.parse(line) as CodexFrame;
    } catch {
      // Codex writes tracing output to stderr, so a non-JSON line on stdout is
      // unexpected but not worth killing a session over.
      return;
    }

    // A response to something we asked.
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.pending.get(Number(frame.id));
      if (!pending) return;
      this.pending.delete(Number(frame.id));
      if (frame.error) pending.reject(new Error(frame.error.message ?? 'Codex request failed'));
      else pending.resolve(frame.result);
      return;
    }

    // A request FROM the server. Only approvals matter to us, and they must be
    // answered or the agent's turn stalls indefinitely.
    if (frame.id !== undefined && frame.method) {
      void this.answerRequest(frame);
      return;
    }

    if (frame.method) this.handlers.onNotify(frame.method, frame.params ?? {});
  }

  private async answerRequest(frame: CodexFrame): Promise<void> {
    const approval = describeApproval(frame.method ?? '', frame.params ?? {});
    if (!approval) {
      // An unknown server request still needs an answer, or Codex waits on us.
      this.write({ id: frame.id, error: { code: -32601, message: `Unsupported request: ${frame.method}` } });
      return;
    }
    try {
      const decision = await this.handlers.onApproval(approval);
      this.write({ id: frame.id, result: { decision: encodeDecision(decision) } });
    } catch {
      // Never leave the turn parked because our own handler failed.
      this.write({ id: frame.id, result: { decision: encodeDecision({ kind: 'denied', rejection: 'Claudia could not ask' }) } });
    }
  }
}

function readThreadId(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const direct = result['threadId'] ?? result['thread_id'];
  if (typeof direct === 'string') return direct;
  const thread = result['thread'] as Record<string, unknown> | undefined;
  const nested = thread?.['id'] ?? thread?.['threadId'];
  return typeof nested === 'string' ? nested : undefined;
}

/** Turns an approval request into something a human can decide on. */
export function describeApproval(method: string, params: Record<string, unknown>): CodexApproval | null {
  if (method === APPROVAL_METHOD.exec) {
    const command = Array.isArray(params['command'])
      ? (params['command'] as unknown[]).filter((c): c is string => typeof c === 'string').join(' ')
      : String(params['command'] ?? '');
    return { kind: 'exec', summary: command || 'a command', params };
  }
  if (method === APPROVAL_METHOD.patch) {
    const changes = (params['fileChanges'] ?? {}) as Record<string, unknown>;
    const paths = Object.keys(changes);
    const summary =
      paths.length === 0
        ? 'file changes'
        : paths.length === 1
          ? (paths[0] as string)
          : `${paths.length} files: ${paths.slice(0, 2).join(', ')}`;
    return { kind: 'patch', summary, params };
  }
  return null;
}
