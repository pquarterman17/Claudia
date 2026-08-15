import { describe, expect, it } from 'vitest';
import { folderPickerHint } from '../src/platform-copy';

describe('folder picker platform copy', () => {
  it('uses the macOS Command glyph rather than a Windows Ctrl-click instruction', () => {
    expect(folderPickerHint('darwin')).toBe('Pick a folder — ⌘-click several to start a session in each');
  });

  it('uses Ctrl-click on hosts that use Control for multi-select', () => {
    expect(folderPickerHint('win32')).toContain('Ctrl-click');
    expect(folderPickerHint('linux')).toContain('Ctrl-click');
  });
});
