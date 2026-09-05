/**
 * Property names that must never be written from remote data.
 *
 * Every mirror and session map here is keyed by an id that arrived over the
 * socket. Writing `__proto__` into a plain object reaches the prototype and
 * poisons every object that inherits from it, so the id is checked at the point
 * it becomes a key rather than trusted because the server sent it.
 *
 * Shared between `store.ts` and `mirror-state.ts` because the guard has to live
 * with the WRITE, not with one caller. The store checked ids before its own
 * switch; `foldMirror` is a separate exported function, so a guard upstream of
 * it proves nothing about anyone else calling it — which is what CodeQL flagged
 * on `mirror-state.ts`, correctly.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A usable object key: a non-empty string that cannot reach the prototype. */
export function isSafeKey(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !UNSAFE_KEYS.has(value);
}
