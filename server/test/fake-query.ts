import { AsyncQueue } from '../src/async-queue.js';
import type { QuerySpec } from '../src/query-factory.js';

/**
 * A stand-in for the Agent SDK's query object, driving ClaudiaSession through
 * lifecycle vectors deterministically.
 *
 * It mirrors the surface the session actually uses: it is an AsyncIterable of
 * SDK messages (push via emit), it consumes the session's input stream the way
 * the real CLI does (recording what it receives), and it exposes close /
 * interrupt / setPermissionMode. Loosening rejects by default with the SDK's
 * real error, because that refusal is what forces the relaunch path this
 * harness exists to test.
 */
export class FakeQuery implements AsyncIterable<Record<string, unknown>> {
  readonly spec: QuerySpec;
  /** User messages this query consumed from the session's input stream. */
  readonly received: string[] = [];
  closed = false;
  interrupted = false;
  /** When true, setPermissionMode resolves (tightening); else it rejects. */
  allowInPlaceSwitch = false;
  readonly flagSettings: Array<{ effortLevel?: string; alwaysThinkingEnabled?: boolean }> = [];

  private readonly out = new AsyncQueue<Record<string, unknown>>();
  private reading = true;
  private failure: Error | null = null;

  constructor(spec: QuerySpec) {
    this.spec = spec;
    void this.readInput();
  }

  /** Push an SDK message into the session's consume loop. */
  emit(message: Record<string, unknown>): void {
    this.out.push(message);
  }

  /** End the message stream, as the CLI exiting would. */
  close(): void {
    this.closed = true;
    this.out.close();
  }

  /** Make the message stream throw, as a transport error would. */
  fail(error: Error): void {
    this.failure = error;
    this.out.close();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  setPermissionMode(mode: string): Promise<void> {
    if (this.allowInPlaceSwitch) return Promise.resolve();
    return Promise.reject(
      new Error(
        `Cannot set permission mode to ${mode} because the session was not launched with --dangerously-skip-permissions`,
      ),
    );
  }

  applyFlagSettings(settings: { effortLevel?: string; alwaysThinkingEnabled?: boolean }): Promise<void> {
    this.flagSettings.push(settings);
    return Promise.resolve();
  }

  /** Simulates the CLI being busy: stops draining the session's input queue. */
  stopReading(): void {
    this.reading = false;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    for await (const message of this.out) {
      yield message;
    }
    if (this.failure) throw this.failure;
  }

  private async readInput(): Promise<void> {
    for await (const item of this.spec.input) {
      if (!this.reading) {
        // Busy CLI: the prompt stays queued rather than being consumed. The
        // live mid-turn repro showed a prompt queued behind a running turn
        // survives a relaunch, i.e. it was still drainable from our queue —
        // so the fake must not swallow it either.
        (this.spec.input as AsyncQueue<unknown>).push(item);
        return;
      }
      const env = item as { message?: { content?: unknown } };
      if (typeof env.message?.content === 'string') this.received.push(env.message.content);
    }
  }
}

// ---------- SDK message builders, matching what message-router reads ----------

export const initMsg = (sessionId = 'claude-sess-1', model = 'claude-opus-5'): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model,
  cwd: 'C:/x',
});

export const assistantText = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

export const resultMsg = (costUsd = 0.01): Record<string, unknown> => ({
  type: 'result',
  subtype: 'success',
  total_cost_usd: costUsd,
});

export const streamDelta = (text: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

/** Waits for queued microtasks/timers so the consume loop can observe events. */
export const tick = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};
