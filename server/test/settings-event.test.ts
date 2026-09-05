import { DEFAULT_FLEET_LIMITS } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { buildSettingsEvent } from '../src/settings-event.js';
import type { Settings } from '../src/settings-store.js';

const BASE: Settings = {
  planTier: 'auto',
  finishChain: ['notify'],
  countdownSec: 30,
  stopSessionsWhenClosedSec: 30,
  recentDirectories: ['/a'],
  defaultPermissionMode: 'auto',
  templates: [],
  toolkit: [],
  fleetLimits: DEFAULT_FLEET_LIMITS,
};

describe('buildSettingsEvent', () => {
  it('projects exactly the fields the settings event carries', () => {
    expect(buildSettingsEvent(BASE)).toEqual({
      type: 'settings',
      recentDirectories: ['/a'],
      toolkit: [],
      countdownSec: 30,
      stopSessionsWhenClosedSec: 30,
      defaultPermissionMode: 'auto',
      templates: [],
      customCeilings: undefined,
      fleetLimits: DEFAULT_FLEET_LIMITS,
    });
  });

  it('carries customCeilings through when set', () => {
    const withCeilings: Settings = { ...BASE, customCeilings: { sessionTokens: 1000, weeklyTokens: 5000 } };
    expect(buildSettingsEvent(withCeilings).customCeilings).toEqual({ sessionTokens: 1000, weeklyTokens: 5000 });
  });
});
