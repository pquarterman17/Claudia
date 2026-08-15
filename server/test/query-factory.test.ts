import { describe, expect, it } from 'vitest';
import { userMessage } from '../src/query-factory.js';

describe('userMessage', () => {
  it('keeps a text-only prompt in the compact SDK shape', () => {
    expect(userMessage('hello', 'session-1')).toMatchObject({
      type: 'user',
      session_id: 'session-1',
      message: { role: 'user', content: 'hello' },
    });
  });

  it('adds valid images as Claude SDK base64 content blocks', () => {
    const envelope = userMessage('inspect this', 'session-1', [
      { name: 'screen.png', mediaType: 'image/png', data: 'aGVsbG8=' },
    ]) as { message: { content: unknown[] } };
    expect(envelope.message.content).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ]);
  });

  it('drops unsupported or malformed image input rather than passing it to the SDK', () => {
    const envelope = userMessage('safe', 'session-1', [
      { name: 'vector.svg', mediaType: 'image/svg+xml', data: 'aGVsbG8=' },
      { name: 'broken.png', mediaType: 'image/png', data: 'not base64!' },
    ]) as { message: { content: unknown } };
    expect(envelope.message.content).toBe('safe');
  });
});
