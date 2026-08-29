import type { PromptImage } from '@claudia/shared';
import { AsyncQueue } from './async-queue.js';
import { CodexClient, type CodexApproval } from './codex-client.js';
import { codexPermissions, type CodexDecision } from './codex-protocol.js';
import { CodexNotInstalledError, spawnCodexAppServer, type CodexProcess } from './codex-process.js';
import { routeCodexMessage } from './codex-router.js';
import { errorStep } from './feed.js';
import * as gateActions from './gate-actions.js';
import type { RoutedMessage } from './message-router.js';
import type { SessionDriver } from './session-driver.js';

export interface CodexDriverOptions {
  cwd: string;
  /** Claudia's permission mode, mapped onto Codex's approvalPolicy + sandbox. */
  permissionMode: string;
  model?: string;
  /** A Codex thread id to reopen, for a relaunch that must keep the conversation. */
  resume?: string;
  onApproval: (approval: CodexApproval) => Promise<CodexDecision>;
  /** Overridable so tests can drive this without a Codex install. */
  spawn?: (cwd: string) => CodexProcess;
}

/**
 * Drives a Codex session through `codex app-server`, translating its
 * notifications into the same RoutedMessage shape the Claude driver produces.
 *
 * Wire correctness (handshake, framing, approval encoding) is already proven
 * by codex-client.test.ts; this file's job is only the parts that are new
 * here: turning push notifications into a pull-based RoutedMessage stream,
 * and surfacing a missing Codex install as a session error instead of a
 * crash — the one failure mode guaranteed to be hit on a machine without it.
 */
export class CodexDriver implements SessionDriver {
  private readonly outbox = new AsyncQueue<RoutedMessage>();
  private readonly client: CodexClient | null;
  private threadId: string | undefined;
  private failed = false;
  private readonly cwd: string;
  private readonly resume: string | undefined;
  private readonly permissionMode: string;
  private readonly model: string | undefined;

  constructor(opts: CodexDriverOptions) {
    this.cwd = opts.cwd;
    this.resume = opts.resume;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    const spawn = opts.spawn ?? spawnCodexAppServer;
    try {
      const { channel, exited } = spawn(opts.cwd);
      this.client = new CodexClient(channel, {
        onNotify: (method, params) => this.outbox.push(routeCodexMessage(method, params)),
        onApproval: opts.onApproval,
        onClose: (reason) => this.fail(reason ?? 'Codex disconnected'),
      });
      exited
        .then(({ code, stderr }) => {
          if (code !== 0 && code !== null) this.fail(stderr.trim() || `Codex exited with code ${code}`);
          else this.outbox.close();
        })
        .catch((err: unknown) => this.fail(describeStartupError(err)));
      void this.client.initialize().catch((err: unknown) => this.fail(describeStartupError(err)));
    } catch (err) {
      this.client = null;
      this.fail(describeStartupError(err));
    }
  }

  get raw(): unknown {
    // No Claude-only operation (models, mcp status, rewind, /cost, /context…)
    // applies to Codex; every caller narrows this with `as X | null` and
    // already degrades to "unsupported" when the field it wants is missing.
    return undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<RoutedMessage> {
    return this.outbox[Symbol.asyncIterator]();
  }

  sendPrompt(text: string, _images: PromptImage[] = []): void {
    // app-server's turn/start only takes text; images silently drop rather
    // than failing the turn. describeAttachments (in query-factory.ts) still
    // tells the user in the transcript what was and wasn't sent.
    void this.send(text);
  }

  private async send(text: string): Promise<void> {
    if (!this.client) return;
    try {
      if (!this.threadId) {
        this.threadId = this.resume
          ? await this.client.resumeThread(this.resume)
          : await this.client.startThread(this.threadOptions());
      }
      if (this.threadId) await this.client.startTurn(this.threadId, text);
    } catch (err) {
      const errMsg = describeStartupError(err);
      this.outbox.push({ steps: [errorStep('Codex turn failed', errMsg)], state: 'error', errorMessage: errMsg });
    }
  }

  /**
   * Options for thread/start. The field is `cwd`, not `workingDirectory`:
   * an unknown key is ignored silently, so the wrong name merely inherits the
   * spawned process's directory and looks like it worked.
   */
  private threadOptions(): Record<string, unknown> {
    const permissions = codexPermissions(this.permissionMode);
    return {
      cwd: this.cwd,
      approvalPolicy: permissions.approvalPolicy,
      sandbox: permissions.sandbox,
      ...(this.model ? { model: this.model } : {}),
    };
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.threadId) return;
    await this.client.interrupt(this.threadId).catch(() => undefined);
  }

  close(): void {
    this.client?.close();
    this.outbox.close();
  }

  /** Settles the session as failed exactly once — startup, disconnect and turn errors all race for this. */
  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.outbox.push({ steps: [errorStep('Codex error', message)], state: 'error', errorMessage: message });
    this.outbox.close();
  }
}

function describeStartupError(err: unknown): string {
  // CodexNotInstalledError already carries the install instructions; anything
  // else keeps whatever message it arrived with.
  if (err instanceof CodexNotInstalledError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bridges a Codex approval into the same ApprovalGate a Claude tool call
 * parks on, so approve/deny in the browser needs no UI change.
 *
 * `summarizeToolInput` (feed.ts) reads an input's `command` field first, and
 * `approval.summary` is already the one-line description worth showing (a
 * joined exec command, or the changed path/count for a patch) — surfacing it
 * under that key reuses the existing summary logic instead of duplicating it.
 */
export async function decideCodexApproval(ctx: gateActions.GateCtx, approval: CodexApproval): Promise<CodexDecision> {
  const toolName = approval.kind === 'exec' ? 'Codex Command' : 'Codex Patch';
  const result = await gateActions.openPermissionRequest(ctx, toolName, { ...approval.params, command: approval.summary });
  return result.behavior === 'allow' ? { kind: 'approved' } : { kind: 'denied', rejection: result.message };
}
