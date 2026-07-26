// Rebuild the UI only when sources are newer than the last build.
//
// The launcher used to run a full build every time, which turned a ~2s start
// into ~76s. Skipping an up-to-date build is the difference between "opens
// instantly" and "why is this so slow".
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'web', 'dist', 'index.html');

/** Newest mtime under a file or directory, ignoring build output. */
function newest(path, seen = { ms: 0 }) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return seen.ms;
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-types') continue;
      newest(join(path, entry), seen);
    }
  } else if (info.mtimeMs > seen.ms) {
    seen.ms = info.mtimeMs;
  }
  return seen.ms;
}

const sources = ['web/src', 'web/index.html', 'web/vite.config.ts', 'shared/src', 'web/package.json'];
const newestSource = sources.reduce((max, rel) => Math.max(max, newest(join(root, rel))), 0);
const builtAt = existsSync(built) ? statSync(built).mtimeMs : 0;

if (builtAt >= newestSource && builtAt > 0) {
  console.log('[claudia] UI build is current — skipping rebuild');
  process.exit(0);
}

console.log(existsSync(built) ? '[claudia] sources changed — rebuilding UI' : '[claudia] first run — building UI');
const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
