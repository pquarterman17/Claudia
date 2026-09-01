import { posix, win32 } from 'node:path';

/**
 * The identity of a directory, as one string.
 *
 * Ownership is defined in terms of "is this the same directory", and that
 * question had two different answers: the claim policy folded case and
 * separators while the store compared raw text, so `C:\Repo\Work` and
 * `c:/repo/work` were one directory to the code deciding who may write there
 * and two rows to the index that makes ownership provable.
 *
 * Written against `node:path` rather than by hand, after a review found four
 * ways the hand-rolled version was wrong: `C:../foo` collided with `C:foo`
 * (drive-RELATIVE is not drive-ROOTED), `..` popped a UNC share out of its own
 * root, `C://repo` differed from `C:/repo`, and `a:` parsed as a drive on
 * POSIX, where it is an ordinary filename. Every one of those either merges two
 * directories into one ownership key or lets one directory take two live
 * claims. `path.win32` and `path.posix` already model this, including the parts
 * that are not obvious, and a second implementation of it is a second thing to
 * be wrong.
 *
 * Lives here rather than in the shared contract because both callers are
 * server-side and `node:path` is not available to the browser bundle — and
 * because being one implementation matters more than which package holds it.
 * `openFleetDb` registers this as a SQLite function so the database enforces
 * the same answer it does.
 *
 * Always compute a key from a PATH, never from another key. `win32.normalize`
 * is not itself a fixed point on the odd shapes — `a/C:/..` gives `.\a`, which
 * normalises again to `a` — so a key fed back through here can come out
 * different. Nothing needs to: the repository keys `path` on the way in and
 * the caller's path on the way out, and the trigger keys `NEW.path`.
 */
export function worktreePathKey(input: string, platform: PathPlatform = HOST_PLATFORM): string {
  if (platform === 'posix') return trimTrailing(posix.normalize(input), 'posix');
  // Separators folded AFTER normalising, so `win32.normalize` sees the input in
  // the form it understands, and case folded because the filesystem does.
  return trimTrailing(win32.normalize(input).replace(/\\/g, '/'), 'win32').toLowerCase();
}

export type PathPlatform = 'win32' | 'posix';

/** This machine's spelling rules. */
export const HOST_PLATFORM: PathPlatform = process.platform === 'win32' ? 'win32' : 'posix';

/**
 * Drops trailing separators without eating a root.
 *
 * `/` must stay `/` rather than becoming the empty string, and `C:/` must stay
 * a drive ROOT rather than collapsing to the drive-RELATIVE `C:` — which means
 * "wherever the process happens to be on that drive" and is a different place.
 * A scan rather than a regex: CodeQL flagged the anchored `(.)\/+$` form on
 * this branch as polynomial on a path of many separators, which is input that
 * arrives from a record or a request.
 *
 * The drive test is the WHOLE prefix, not just the colon. Found fuzzing this
 * against `win32.resolve`: testing only for a colon read any component ending
 * in one as a root, so `/wt/build:` and `/wt/build:/` — the same directory, and
 * a perfectly legal name on POSIX, where `:` is an ordinary character — kept
 * their trailing separator inconsistently and came out with two keys. Two live
 * claims on one checkout is the exact failure this key exists to prevent, so
 * the guard that was meant to protect a root was reintroducing it.
 *
 * `//srv/share` needs no guard of its own: `win32.normalize` gives a bare UNC
 * root a trailing separator, so both spellings arrive here and leave as one.
 */
function trimTrailing(path: string, platform: PathPlatform): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  const rootedOnADrive = platform === 'win32' && end === 2 && path[1] === ':' && isDriveLetter(path[0]);
  if (rootedOnADrive && end < path.length) end += 1;
  return path.slice(0, end);
}

function isDriveLetter(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
