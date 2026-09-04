import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UsageReader } from '../src/usage-reader.js';

/**
 * Following a file that is still being written to.
 *
 * Every session Claudia watches is appending to its log while this reads it, so
 * "the last line is half-written" is the normal case rather than the edge one.
 * What is asserted here is that a record split across two scans survives — the
 * property the byte-offset resume exists to provide, and the one it did not
 * actually have.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-usage-reader-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function projects() {
  const root = join(dir, `projects-${counter++}`);
  const path = join(root, '-home-user-repo', 'session.jsonl');
  mkdirSync(join(root, '-home-user-repo'), { recursive: true });
  return { root, path };
}

const record = (outputTokens: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: outputTokens } },
  })}\n`;

const totals = (reader: UsageReader): number => reader.store.totals(0).outputTokens;

describe('reading a log that is still being appended to', () => {
  it('keeps a record that was half-written when the first scan ran', async () => {
    // The defect: the offset was advanced to the file size before reading, so
    // the fragment was dropped AND the next scan resumed from the middle of it.
    // The remainder then parsed as garbage too, and the record was gone for
    // good rather than merely deferred.
    const { root, path } = projects();
    const whole = record(500);
    const split = Math.floor(whole.length / 2);

    appendFileSync(path, whole.slice(0, split));
    const reader = new UsageReader(root);
    await reader.scan();
    // Nothing complete yet, so nothing counted — that much was always true.
    expect(totals(reader)).toBe(0);

    appendFileSync(path, whole.slice(split));
    await reader.scan();
    // And now the whole record, exactly once.
    expect(totals(reader)).toBe(500);
  });

  it('resumes correctly when the split lands inside a multi-byte character', async () => {
    // Found in review, and a defect the previous fix introduced: the resume
    // offset was derived by re-encoding the DECODED fragment. A read that ends
    // partway through a UTF-8 character has that trailing fragment replaced by
    // U+FFFD, which re-encodes to a different length than the bytes actually
    // read — so the arithmetic produced an offset that was wrong, and could go
    // NEGATIVE, after which `createReadStream` threw and the file could never
    // be scanned again.
    const { root, path } = projects();
    const whole = Buffer.from(
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        note: '🚀🚀🚀',
        message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 321 } },
      })}\n`,
      'utf8',
    );
    // Cut one byte into a four-byte emoji, so the tail is an incomplete character.
    const split = whole.indexOf(Buffer.from('🚀', 'utf8')) + 1;

    appendFileSync(path, whole.subarray(0, split));
    const reader = new UsageReader(root);
    await reader.scan();
    expect(totals(reader)).toBe(0);

    appendFileSync(path, whole.subarray(split));
    await reader.scan();
    expect(totals(reader)).toBe(321);
  });

  it('counts each record once across many scans', async () => {
    const { root, path } = projects();
    const reader = new UsageReader(root);
    for (let i = 0; i < 5; i++) {
      appendFileSync(path, record(100));
      await reader.scan();
    }
    // Re-scanning with nothing appended must add nothing.
    await reader.scan();
    expect(totals(reader)).toBe(500);
  });

  it('reads a complete line the moment it lands, without waiting for the next', async () => {
    // The lookahead must not hold a finished line hostage until a later one
    // arrives: a session that writes one message and goes quiet would never be
    // counted.
    const { root, path } = projects();
    appendFileSync(path, record(250));
    const reader = new UsageReader(root);
    await reader.scan();
    expect(totals(reader)).toBe(250);
  });

  it('starts over when the file shrinks', async () => {
    const { root, path } = projects();
    const reader = new UsageReader(root);
    appendFileSync(path, record(100) + record(100));
    await reader.scan();
    expect(totals(reader)).toBe(200);

    // Rotated or rewritten underneath us.
    rmSync(path);
    appendFileSync(path, record(70));
    await reader.scan();
    expect(totals(reader)).toBe(270);
  });
});
