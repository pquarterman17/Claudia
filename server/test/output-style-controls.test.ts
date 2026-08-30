import { describe, expect, it } from 'vitest';
import { fetchOutputStyles, type OutputStyleQuery } from '../src/output-style-controls.js';

describe('fetchOutputStyles', () => {
  it('is the fallback path: undefined when the query has no initializationResult (Codex, or an older SDK)', async () => {
    await expect(fetchOutputStyles(null)).resolves.toBeUndefined();
    await expect(fetchOutputStyles({})).resolves.toBeUndefined();
  });

  it('is the fallback path: undefined when initializationResult throws', async () => {
    const q: OutputStyleQuery = {
      initializationResult: async () => {
        throw new Error('control channel not ready');
      },
    };
    await expect(fetchOutputStyles(q)).resolves.toBeUndefined();
  });

  it('is the fallback path: undefined when the response is missing either field', async () => {
    const missingCurrent: OutputStyleQuery = {
      initializationResult: async () => ({ available_output_styles: ['default', 'concise'] }),
    };
    const missingList: OutputStyleQuery = {
      initializationResult: async () => ({ output_style: 'default' }),
    };
    await expect(fetchOutputStyles(missingCurrent)).resolves.toBeUndefined();
    await expect(fetchOutputStyles(missingList)).resolves.toBeUndefined();
  });

  it('maps the current style and the full list through untouched', async () => {
    const q: OutputStyleQuery = {
      initializationResult: async () => ({
        output_style: 'concise',
        available_output_styles: ['default', 'concise', 'explanatory'],
      }),
    };
    await expect(fetchOutputStyles(q)).resolves.toEqual({
      current: 'concise',
      available: ['default', 'concise', 'explanatory'],
    });
  });
});
