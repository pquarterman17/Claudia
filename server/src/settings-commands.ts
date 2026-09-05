import { usableFleetLimits, type ClientCommand } from '@claudia/shared';
import type { SettingsStore } from './settings-store.js';
import type { TriggerEngine } from './trigger-engine.js';
import type { UsageService } from './usage-service.js';

export interface SettingsCommandCtx {
  settings: SettingsStore;
  trigger: TriggerEngine;
  usage: UsageService;
  /** Re-sends the whole settings record to every client. */
  broadcast: () => void;
}

/**
 * Commands that only change a stored preference and re-broadcast it.
 *
 * Seven cases with one shape — write, then tell everyone — which is a
 * different job from the dispatch in gateway.ts around them, where every other
 * case reaches into a live session. Pulled out for the same reason
 * `settings-event.ts` was: gateway.ts sits on the size ceiling, and this is a
 * real seam rather than a line-count trade.
 *
 * Returns false for anything it does not own, so the caller's switch can carry
 * on. The clamps live here with the writes they protect, not at the call site.
 */
export function handleSettingsCommand(cmd: ClientCommand, ctx: SettingsCommandCtx): boolean {
  switch (cmd.type) {
    case 'set_plan_tier':
      ctx.usage.setTier(cmd.tier);
      ctx.settings.update({ planTier: cmd.tier });
      return true;
    case 'set_custom_ceilings': {
      // A zero or negative ceiling is meaningless, so floor it above zero.
      const customCeilings = {
        sessionTokens: Math.max(1000, Math.round(cmd.sessionTokens)),
        weeklyTokens: Math.max(1000, Math.round(cmd.weeklyTokens)),
      };
      ctx.settings.update({ customCeilings });
      ctx.usage.setCustomCeilings(customCeilings);
      break;
    }
    case 'set_stop_on_close': {
      // Clamped: a few seconds is not enough to survive a page reload.
      const seconds = cmd.seconds <= 0 ? 0 : Math.max(10, Math.min(3600, Math.round(cmd.seconds)));
      ctx.settings.update({ stopSessionsWhenClosedSec: seconds });
      break;
    }
    case 'set_fleet_limits': {
      // Clamped, not refused. This is a preference dialog, not an API: a
      // client that sends 0 children means "as few as possible", and the
      // shared reader answers with the nearest limit the fleet can run on.
      ctx.settings.update({ fleetLimits: usableFleetLimits({ maxChildren: cmd.maxChildren, maxAttempts: cmd.maxAttempts }) });
      break;
    }
    case 'set_countdown':
      ctx.trigger.setCountdown(cmd.seconds);
      ctx.settings.update({ countdownSec: ctx.trigger.countdownLength });
      break;
    case 'save_toolkit_action':
      ctx.settings.saveToolkitAction(cmd.action);
      break;
    case 'delete_toolkit_action':
      ctx.settings.deleteToolkitAction(cmd.id);
      break;
    case 'save_template':
      ctx.settings.saveTemplate(cmd.template);
      break;
    case 'delete_template':
      ctx.settings.deleteTemplate(cmd.name);
      break;
    default:
      return false;
  }
  ctx.broadcast();
  return true;
}
