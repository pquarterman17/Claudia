import type { ServerEvent } from '@claudia/shared';
import type { HookMonitor } from './hook-monitor.js';
import { isInstalled } from './hook-install.js';
import type { SessionManager } from './session-manager.js';
import type { SettingsStore } from './settings-store.js';
import type { TriggerEngine } from './trigger-engine.js';
import type { UsageService } from './usage-service.js';
import type { HostPlatform } from '@claudia/shared';

export interface HelloDeps {
  manager: SessionManager;
  trigger: TriggerEngine;
  usage: UsageService;
  settings: SettingsStore;
  monitor: HookMonitor;
  platform: HostPlatform;
  port: number;
}

/**
 * The whole board, as one message to a browser that just connected.
 *
 * Extracted from gateway.ts, which was at the size ceiling with no room to add
 * the observed-session fields — the same move `settings-event.ts` was, and a
 * real boundary rather than a line-count trade: this is the only place that
 * knows how to describe the complete state of the app to a client that knows
 * nothing yet.
 *
 * Never rejects. It is awaited inside a websocket 'connection' handler, where
 * an unhandled rejection ends the supervisor — a failing MCP server on page
 * load once did exactly that.
 */
export async function buildHello(deps: HelloDeps): Promise<ServerEvent> {
  const { manager, trigger, usage, settings, monitor, platform, port } = deps;
  const [mcp, monitoring] = await Promise.all([
    manager.mcpSnapshot().catch(() => ({})),
    isInstalled(port).catch(() => false),
  ]);
  const saved = settings.get();
  return {
    type: 'hello',
    sessions: manager.summaries(),
    feeds: manager.feedSnapshot(),
    trigger: trigger.status(),
    platform,
    usage: usage.snapshot(),
    recentDirectories: saved.recentDirectories,
    countdownSec: saved.countdownSec,
    stopSessionsWhenClosedSec: saved.stopSessionsWhenClosedSec,
    defaultPermissionMode: saved.defaultPermissionMode,
    templates: saved.templates,
    toolkit: saved.toolkit,
    customCeilings: saved.customCeilings,
    mcp,
    observed: monitor.list(ownedSessionIds(manager)),
    monitoring,
  };
}

/**
 * The CLI session ids Claudia already owns a tile for.
 *
 * A session Claudia launched fires the same global hooks as any other, so
 * without this every owned session would show twice — once live, once as a
 * read-only ghost of itself.
 */
export function ownedSessionIds(manager: SessionManager): Set<string> {
  const ids = new Set<string>();
  for (const summary of manager.summaries()) {
    if (summary.claudeSessionId) ids.add(summary.claudeSessionId);
  }
  return ids;
}
