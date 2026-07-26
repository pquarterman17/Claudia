import type { PendingApproval } from '@claudia/shared';
import { randomUUID } from 'node:crypto';

/**
 * The SDK's PermissionResult union: `allow` must carry updatedInput,
 * `deny` must carry a message. Mirrored here so the gate is testable
 * without importing the SDK.
 */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Holds a session's in-flight permission request. `canUseTool` parks here;
 * an approve/deny command from the UI resolves it. Exactly one request can
 * be outstanding per session — the SDK awaits the callback before continuing.
 */
export class ApprovalGate {
  private pending: PendingApproval | undefined;
  private resolver: ((r: PermissionResult) => void) | undefined;
  private input: Record<string, unknown> = {};

  get current(): PendingApproval | undefined {
    return this.pending;
  }

  get isWaiting(): boolean {
    return this.resolver !== undefined;
  }

  /** Park a request. Resolves when approve/deny/abandon is called. */
  request(toolName: string, summary: string, input: Record<string, unknown>): Promise<PermissionResult> {
    if (this.resolver) {
      // Defensive: the SDK serialises permission requests, so this shouldn't
      // happen. Fail the old one rather than leaking a dangling promise.
      this.resolver({ behavior: 'deny', message: 'Superseded by a newer permission request' });
    }
    this.pending = { requestId: randomUUID(), toolName, summary, requestedAt: Date.now() };
    this.input = input;
    return new Promise<PermissionResult>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Returns false if the id doesn't match the outstanding request (stale click). */
  approve(requestId: string): boolean {
    return this.settle(requestId, { behavior: 'allow', updatedInput: this.input });
  }

  /** Allows the call with extra input merged in — how a question is answered. */
  approveWith(requestId: string, extra: Record<string, unknown>): boolean {
    return this.settle(requestId, { behavior: 'allow', updatedInput: { ...this.input, ...extra } });
  }

  deny(requestId: string, message?: string): boolean {
    return this.settle(requestId, {
      behavior: 'deny',
      message: message ?? 'Denied by the user in Claudia',
    });
  }

  /** Unconditionally settle on teardown so the SDK promise never dangles. */
  abandon(reason: string): void {
    const resolve = this.resolver;
    this.pending = undefined;
    this.resolver = undefined;
    resolve?.({ behavior: 'deny', message: reason });
  }

  private settle(requestId: string, result: PermissionResult): boolean {
    if (!this.resolver || this.pending?.requestId !== requestId) return false;
    const resolve = this.resolver;
    this.pending = undefined;
    this.resolver = undefined;
    resolve(result);
    return true;
  }
}
