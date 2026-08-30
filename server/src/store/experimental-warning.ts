/**
 * node:sqlite announces itself on first load, and this drops that one line.
 *
 * Lives in its own module, imported by db.ts ahead of node:sqlite, because the
 * filter has to be installed before the module that emits the warning is
 * loaded. process.emitWarning defers to the next tick, so an install in db.ts
 * itself usually wins the race too — but "usually" depends on whether the
 * loader awaits between imports, and a bundler or test runner is free to.
 */

/**
 * Marks our filter so re-importing this module cannot nest one filter inside
 * another for the lifetime of the process.
 */
const FILTERED = Symbol.for('claudia.sqliteWarningFilter');

/** The one warning that is dropped. Exported so a test can pin exactly which. */
export function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === 'ExperimentalWarning' && /\bsqlite\b/i.test(warning.message);
}

/**
 * Drops node:sqlite's "SQLite is an experimental feature" warning and nothing
 * else.
 *
 * The warning is true but useless here: it is about a dependency the user did
 * not choose, printed to the sidecar's stderr, where it reads as a fault in
 * Claudia. The blunt fix is --no-warnings on the process, which would also hide
 * deprecations and unhandled-rejection warnings that do mean something, so
 * instead the existing warning listeners are captured and re-invoked for every
 * warning except this one.
 *
 * Idempotent, so importing this module from more than one place cannot leave a
 * chain of filters wrapping each other.
 */
export function filterSqliteExperimentalWarning(): void {
  const existing = process.listeners('warning');
  if (existing.some((listener) => (listener as { [FILTERED]?: boolean })[FILTERED])) return;
  const filter = (warning: Error): void => {
    if (isSqliteExperimentalWarning(warning)) return;
    for (const listener of existing) listener.call(process, warning);
  };
  (filter as { [FILTERED]?: boolean })[FILTERED] = true;
  process.removeAllListeners('warning');
  process.on('warning', filter);
}

filterSqliteExperimentalWarning();
