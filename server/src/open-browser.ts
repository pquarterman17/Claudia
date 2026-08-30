import { execFile } from 'node:child_process';
import type { HostPlatform } from '@claudia/shared';

/**
 * Opening the UI, from the process that knows when it is actually ready.
 *
 * This used to live in the launchers: each polled the port from outside and
 * opened a browser once something answered. That is three implementations of
 * the same guess (PowerShell, curl, and a port check), and the Windows one was
 * the reported bug — it polled `http://localhost:4317` while the server binds
 * 127.0.0.1 only. On Windows `localhost` resolves to `::1` first, so nothing
 * was listening at the address being polled and every attempt burned its full
 * one-second timeout. A hundred and twenty of those is over two minutes, by
 * which time the URL has been copied by hand and the eventual tab is a
 * nuisance rather than a convenience.
 *
 * The server cannot be wrong about this: it opens the browser inside its own
 * `listen` callback, at the port it actually bound, which is also the only way
 * to get this right when CLAUDIA_PORT is 0 and the port is not known in
 * advance.
 */

/** A command as an argv array — never a shell string, so nothing is interpolated. */
export interface OpenCommand {
  file: string;
  args: string[];
}

/**
 * What opens a URL on each platform.
 *
 * Windows has no `open` binary; `start` is a cmd builtin, so it has to be
 * reached through `cmd /c`. The empty string after it is not padding — `start`
 * reads its first quoted argument as a window TITLE, so omitting it makes the
 * URL the title and opens nothing.
 */
export function openCommand(url: string, platform: HostPlatform): OpenCommand {
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { file: 'open', args: [url] };
  return { file: 'xdg-open', args: [url] };
}

/**
 * Opens the UI, and never lets that failure matter.
 *
 * A headless box has no `xdg-open`, and a locked-down Windows may refuse the
 * spawn outright. Neither is a reason to take down a server that is otherwise
 * working — the URL is on stdout either way, which is exactly the fallback the
 * user is left with.
 */
export function openBrowser(url: string, platform: HostPlatform): void {
  const { file, args } = openCommand(url, platform);
  try {
    const child = execFile(file, args, { windowsHide: true }, () => undefined);
    child.on('error', () => undefined);
  } catch {
    // Spawning itself refused. The banner already printed the URL.
  }
}

/**
 * Whether this start should open a browser.
 *
 * Opt-in rather than automatic: `npm start` is also how a server gets run from
 * a terminal, over SSH, or by a script, and stealing focus there would be
 * wrong. The launchers — whose entire purpose is to open the app — set it.
 */
export function shouldOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  const flag = env['CLAUDIA_OPEN'];
  return flag === '1' || flag?.toLowerCase() === 'true';
}
