import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Channel } from './codex-client.js';

/**
 * Hosts `codex app-server` and exposes it as a Channel.
 *
 * Kept apart from the protocol client so the wire behaviour stays testable
 * without a Codex install. This half is the part that cannot be unit tested:
 * it needs the real binary.
 */

/** Thrown when the CLI is missing, so the UI can say what to install. */
export class CodexNotInstalledError extends Error {
  constructor() {
    super('Codex is not installed. Install it with: npm install -g @openai/codex');
    this.name = 'CodexNotInstalledError';
  }
}

export interface CodexProcess {
  channel: Channel;
  /** Resolves when the process exits, with its stderr tail for diagnosis. */
  exited: Promise<{ code: number | null; stderr: string }>;
}

/**
 * Starts the app-server on stdio.
 *
 * `shell: false` throughout — the working directory is user-supplied and must
 * never reach a shell, matching how every other subprocess in this codebase is
 * launched.
 */
export function spawnCodexAppServer(cwd: string, command = 'codex'): CodexProcess {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, ['app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
  } catch (err) {
    throw isMissingBinary(err) ? new CodexNotInstalledError() : (err as Error);
  }

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Codex writes tracing here. Keep only a tail: a chatty RUST_LOG setting
    // should not grow unboundedly in memory for the life of a session.
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  child.stdout.setEncoding('utf8');

  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', (err) => {
      if (isMissingBinary(err)) reject(new CodexNotInstalledError());
      else reject(err);
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });

  const channel: Channel = {
    send: (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    onLine: (handler) => child.stdout.on('data', (chunk: string) => handler(chunk)),
    close: () => {
      child.stdin.end();
      // Give it a moment to exit cleanly before insisting.
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref?.();
      child.once('close', () => clearTimeout(timer));
      child.kill();
    },
  };

  return { channel, exited };
}

function isMissingBinary(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}
