import { defineConfig } from 'vitest/config';

/**
 * The one thing this suite needs that vitest's defaults do not give it: time.
 *
 * Vitest's 5s `testTimeout` is sized for unit tests. Most of this suite is not
 * one — it drives real `git` subprocesses, writes real SQLite files, and builds
 * real temp trees, because the bugs worth catching here live in the places
 * where the code meets the filesystem.
 *
 * Found on a Windows runner: three store tests failed with `Test timed out in
 * 5000ms`, each the first test in its file, in three files that have nothing to
 * do with each other. Measured, rather than assumed: the fixtures they timed
 * out in cost 8ms to open a migrated database and 25ms to append 250 events —
 * three orders of magnitude under the budget they blew. Nothing in them was
 * slow; the worker simply was not scheduled, on a four-core runner also running
 * a 23-second suite of git subprocesses. The whole run came in 36% slower than
 * the one before it, and the same commit passed on the other Windows leg.
 *
 * A deadline that a stalled scheduler can trip is measuring the runner, not the
 * code. 30s is roughly twelve times the slowest test this suite legitimately
 * has (a push-and-pull git case, at 2.5s), so a real hang still fails quickly
 * while a stall no longer decides whether the build is green.
 *
 * `hookTimeout` moves with it: the teardown in these files closes database
 * handles and removes a temp tree, and is exposed to exactly the same stall.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
