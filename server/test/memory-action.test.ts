import { describe, expect, it } from 'vitest';
import { firstProseLine } from '../src/memory-action.js';

describe('firstProseLine', () => {
  it('skips decorative rules and headings', () => {
    // A real reply that produced "— ★ ─────" as its reported outcome.
    const text = [
      '`★ Insight ─────────────────────────────────────`',
      '',
      'Updated two memory files with the usage-ceiling lesson.',
    ].join('\n');
    expect(firstProseLine(text)).toBe('Updated two memory files with the usage-ceiling lesson.');
  });

  it('strips leading markdown markers', () => {
    expect(firstProseLine('## Wrote a note about the session limits')).toBe(
      'Wrote a note about the session limits',
    );
    expect(firstProseLine('- Nothing worth saving was found this time')).toBe(
      'Nothing worth saving was found this time',
    );
  });

  it('ignores short lines that are not sentences', () => {
    expect(firstProseLine('Done\n\nRecorded the SDK version trap in a new memory file.')).toBe(
      'Recorded the SDK version trap in a new memory file.',
    );
  });

  it('truncates with an ellipsis rather than running on', () => {
    const long = `${'a'.repeat(300)} end`;
    const out = firstProseLine(long, 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty when there is no prose at all', () => {
    expect(firstProseLine('')).toBe('');
    expect(firstProseLine('---\n***\n###')).toBe('');
  });
});
