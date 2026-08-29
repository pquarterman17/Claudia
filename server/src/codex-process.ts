import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Channel } from './codex-client.js';

/**
 * Hosts `codex app-server` and exposes it as a Channel.
 *
 * Kept apart from the protocol client so the wire behaviour stays testable
 * without a Codex install. This half is the part that needs the real binary.
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

interface Resolved {
  /** Either an executable path, or a full command line when a shell is needed. */
  file: string;
  args: string[];
  shell: boolean;
}

/**
 * Finds how to actually start Codex on this machine.
 *
 * Resolving on the filesystem rather than letting `spawn` search PATH is not
 * belt-and-braces, it is required. On Windows npm installs `codex` as a `.cmd`
 * shim plus an extensionless POSIX script; the real `.exe` lives inside a
 * nested platform package and is not on PATH. `spawn('codex')` therefore fails
 * with ENOENT even though `codex --version` works in a shell, and Node refuses
 * to execute a `.cmd` without one at all. Measured, not assumed: verified
 * against a real install where the shell-less spawn returned ENOENT and the
 * `.cmd` through a shell returned "codex-cli 0.151.0".
 *
 * Resolving first also keeps "not installed" a deterministic answer. Through a
 * shell a missing command surfaces as exit code 1, indistinguishable from the
 * program failing for its own reasons.
 */
export function resolveCodexCommand(command = 'codex'): Resolved | null {
  const windows = process.platform === 'win32';
  // Prefer a real executable; fall back to the shim that needs a shell.
  const candidates = windows ? [`${command}.exe`, `${command}.cmd`] : [command];

  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (!existsSync(full)) continue;
      return full.toLowerCase().endsWith('.cmd')
        ? // Quoted resolved path, not a user-supplied string, and the only
          // argument is a constant — nothing here reaches the shell as data.
          { file: `"${full}" app-server`, args: [], shell: true }
        : { file: full, args: ['app-server'], shell: false };
    }
  }
  return null;
}

/** Starts the app-server on stdio. Throws if Codex is not installed. */
export function spawnCodexAppServer(cwd: string, command = 'codex'): CodexProcess {
  const resolved = resolveCodexCommand(command);
  if (!resolved) throw new CodexNotInstalledError();

  const child: ChildProcess = spawn(resolved.file, resolved.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: resolved.shell,
    windowsHide: true,
  });

  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderrStream = child.stderr;

  let stderr = '';
  stderrStream?.setEncoding('utf8');
  stderrStream?.on('data', (chunk: string) => {
    // Codex writes tracing here. Keep only a tail: a chatty RUST_LOG setting
    // should not grow unboundedly for the life of a session.
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  stdout?.setEncoding('utf8');

  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stderr }));
  });

  const channel: Channel = {
    send: (line) => {
      if (stdin?.writable) stdin.write(line);
    },
    onLine: (handler) => stdout?.on('data', (chunk: string) => handler(chunk)),
    close: () => {
      stdin?.end();
      // Give it a moment to exit cleanly before insisting.
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref?.();
      child.once('close', () => clearTimeout(timer));
      child.kill();
    },
  };

  return { channel, exited };
}
