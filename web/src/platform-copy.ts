import type { HostPlatform } from '@claudia/shared';

/** Native multi-select gestures vary by host, so never show a Windows-only hint. */
export function folderPickerHint(platform: HostPlatform | undefined): string {
  return `Pick a folder — ${platform === 'darwin' ? '⌘-click' : 'Ctrl-click'} several to start a session in each`;
}
