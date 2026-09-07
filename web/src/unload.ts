import { store } from './store';

/**
 * Tell the server this page is going away, so it does not have to guess.
 *
 * A dropped socket alone is ambiguous — a closed tab, a sleeping laptop and a
 * page the browser froze all look the same from the other end — which is why
 * sessions get a grace period before they are stopped at all. Saying so out
 * loud narrows that to one question the server can answer quickly: does a
 * reload come back? On the same machine, that is well under a second, and the
 * difference is a tab you closed leaving a `claude` process running for half a
 * minute or for three seconds.
 *
 * `pagehide`, not `beforeunload`: `beforeunload` disqualifies the page from the
 * back/forward cache in every current browser, which would be a real
 * regression to buy a signal `pagehide` already gives. `persisted` is the
 * bfcache case — the page is frozen, not gone, and may be restored — which is
 * exactly when NOT to say this.
 *
 * Registered from the app's entry point rather than from the store, because
 * this is a fact about the PAGE's lifetime and the store is a socket.
 */
export function announceUnload(): void {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    store.announceClosing();
  });
}
