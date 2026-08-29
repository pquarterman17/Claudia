import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStaticHandler } from '../src/static-files.js';

/**
 * The static handler serves the built UI on a public port, so path containment
 * is the property here that actually matters.
 *
 * What is asserted is "a file outside the root is never served" — deliberately
 * NOT which status says so. `normalize` differs by platform: the same traversal
 * collapses to a missing path inside root on Linux (answered 404) and escapes
 * to be refused on Windows (answered 403). Both are safe; only one is a 403.
 * An earlier version of this file asserted the status and so passed on Windows
 * and failed on Linux — the OS matrix doing exactly its job.
 */

const root = mkdtempSync(join(tmpdir(), 'claudia-static-'));
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'index.html'), '<!doctype html>');
writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');

// A sibling sharing the root's leading characters — the case a naive
// startsWith check on the joined path would wrongly admit.
const sibling = `${root}-evil`;
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, 'secret.txt'), 'do not serve me');

const serve = createStaticHandler(root);

/** Minimal req/res pair, capturing what the handler decided. */
function request(url: string): { handled: boolean; status: number } {
  const res = {
    statusCode: 0,
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      return this;
    },
    // createReadStream(...).pipe(res) needs a writable-looking object.
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

/** Served means handled with a 200; a 403 or a fall-through both kept it in. */
const neverServed = (url: string): boolean => {
  const { handled, status } = request(url);
  return !(handled && status === 200);
};

const lastSegment = (p: string): string => p.split(/[\\/]/).pop() ?? '';

describe('static file containment', () => {
  it('serves a file that really is inside the root', () => {
    expect(request('/assets/app.js')).toMatchObject({ handled: true, status: 200 });
  });

  it('never serves through a classic traversal', () => {
    expect(neverServed('/../secret.txt')).toBe(true);
  });

  it('never serves through an encoded traversal', () => {
    expect(neverServed('/%2e%2e/%2e%2e/secret.txt')).toBe(true);
  });

  it('never serves through a backslash traversal', () => {
    // A separator on Windows, an ordinary filename character on Linux.
    expect(neverServed('/..%5C..%5Csecret.txt')).toBe(true);
  });

  it('never serves a sibling directory whose name merely starts with the root', () => {
    // Why containment uses `relative` rather than a prefix test: "<root>-evil"
    // starts with "<root>" as a string but is not inside it.
    expect(neverServed(`/../${lastSegment(sibling)}/secret.txt`)).toBe(true);
  });

  it('never serves an absolute path pointing outside the root', () => {
    expect(neverServed(`/${sibling.split(/[\\/]/).join('/')}/secret.txt`)).toBe(true);
  });
});
