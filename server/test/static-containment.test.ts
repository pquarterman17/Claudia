import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStaticHandler } from '../src/static-files.js';

/**
 * The static handler serves the built UI from a public port, so path
 * containment is the one property here that actually matters. These drive the
 * real handler against a real directory rather than asserting on a string
 * helper, because the bug this prevents lives in how the pieces compose.
 */

const root = mkdtempSync(join(tmpdir(), 'claudia-static-'));
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'index.html'), '<!doctype html>');
writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
// A sibling that shares the root's leading characters — the case a naive
// startsWith check on the joined path would wrongly admit.
const sibling = `${root}-evil`;
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, 'secret.txt'), 'do not serve me');

const serve = createStaticHandler(root);

/** Minimal req/res pair, capturing what the handler decided. */
function request(url: string) {
  const res = {
    statusCode: 0,
    ended: false,
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    // createReadStream(...).pipe(res) needs these to exist.
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
    },
    write() {
      return true;
    },
  };
  const handled = serve({ method: 'GET', url } as never, res as never);
  return { handled, status: res.statusCode };
}

describe('static file containment', () => {
  it('serves a file inside the root', () => {
    expect(request('/assets/app.js').handled).toBe(true);
  });

  it('refuses a classic traversal', () => {
    expect(request('/../secret.txt')).toMatchObject({ handled: true, status: 403 });
  });

  it('refuses an encoded traversal', () => {
    expect(request('/%2e%2e/%2e%2e/secret.txt')).toMatchObject({ handled: true, status: 403 });
  });

  it('refuses a traversal using backslashes', () => {
    // Windows treats these as separators, so a POSIX-only guard would miss it.
    expect(request('/..%5C..%5Csecret.txt')).toMatchObject({ handled: true, status: 403 });
  });

  it('refuses a sibling directory whose name merely starts with the root', () => {
    // The reason containment is expressed with `relative` rather than a prefix
    // test: "<root>-evil" starts with "<root>" as a string but is not inside it.
    expect(request('/../' + sibling.split(/[\\/]/).pop() + '/secret.txt')).toMatchObject({ status: 403 });
  });
});
