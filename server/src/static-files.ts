import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the built UI from the same server as the API.
 *
 * With this the app is one process on one port: no Vite in the loop, assets
 * bundled rather than fetched module by module. `npm run dev` still runs the
 * two-process setup for development.
 */
export function createStaticHandler(rootDir: string) {
  const root = resolve(rootDir);

  return function serve(req: IncomingMessage, res: ServerResponse): boolean {
    if (!existsSync(root)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    let filePath = join(root, normalize(urlPath));

    // Never let a crafted path escape the build directory.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403).end();
      return true;
    }

    if (!isFile(filePath)) {
      // Single-page app: unknown paths fall back to the shell so client-side
      // routes work on a hard refresh. Missing assets stay a 404.
      if (extname(urlPath)) return false;
      filePath = join(root, 'index.html');
      if (!isFile(filePath)) return false;
    }

    const type = TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    // Vite fingerprints asset filenames, so they can be cached hard; index.html
    // must not be, or a rebuild would never reach the browser.
    const cache = filePath.endsWith('index.html')
      ? 'no-cache'
      : filePath.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';

    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
