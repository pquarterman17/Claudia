import type { ServerEvent } from '@claudia/shared';
import type { Settings } from './settings-store.js';

/**
 * Builds the `settings` broadcast event from the persisted record.
 *
 * Pulled out of gateway.ts (previously a private method there) rather than
 * left inline: gateway.ts sits at the size-ratchet ceiling, and this shape
 * has no reason to live inline in a dispatch-heavy file — factoring it out
 * is a real module boundary (settings serialization vs. WS fan-out), not
 * just a line-count trade to make room for the always-allow-project case
 * added alongside it.
 */
export function buildSettingsEvent(s: Settings): Extract<ServerEvent, { type: 'settings' }> {
  return {
    type: 'settings',
    recentDirectories: s.recentDirectories,
    toolkit: s.toolkit,
    countdownSec: s.countdownSec,
    stopSessionsWhenClosedSec: s.stopSessionsWhenClosedSec,
    defaultPermissionMode: s.defaultPermissionMode,
    templates: s.templates,
    customCeilings: s.customCeilings,
  };
}
