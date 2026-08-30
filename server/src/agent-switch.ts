import type { AgentKind } from '@claudia/shared';
import { AsyncQueue } from './async-queue.js';
import type { SwitchCtx } from './permission-switch.js';
import { agentLabel } from './agent-labels.js';

/**
 * Everything switching agents needs, which is the permission switch's context
 * plus the agent itself. Deliberately the same object: both operations do the
 * same underlying thing — replace this session's driver, keeping its tile —
 * and having one context proves they cannot drift apart on how a relaunch is
 * performed.
 */
export interface AgentSwitchCtx extends SwitchCtx {
  getAgent: () => AgentKind;
  setAgent: (agent: AgentKind) => void;
  /** Drops the ids that belong to the conversation being left behind. */
  forgetConversation: () => void;
}

export type AgentSwitchOutcome = 'unchanged' | 'recorded' | 'switched';

/**
 * Points a session at a different agent.
 *
 * A conversation cannot come along. Claude and Codex keep separate stores and
 * neither can resume the other's id, so this ALWAYS starts a fresh
 * conversation — the one thing that must not happen quietly. What makes that
 * acceptable is that nothing is destroyed: both agents' history is read from
 * disk per directory, so the conversation being left behind stays in the
 * resume picker and can be picked up in another tile.
 *
 * A session that has not started a driver yet (launched idle, never prompted)
 * has nothing to leave behind, so the agent is simply recorded for its first
 * prompt — the same shape as the permission switch's empty-session path.
 */
export function applyAgentSwitch(ctx: AgentSwitchCtx, agent: AgentKind): AgentSwitchOutcome {
  if (ctx.getAgent() === agent) return 'unchanged';

  if (!ctx.getQuery()) {
    ctx.setAgent(agent);
    ctx.feedInfo('Agent switched', `${agentLabel(agent)} — this session has not started yet`);
    ctx.updated();
    return 'recorded';
  }

  const previous = ctx.getAgent();
  ctx.abandonForRestart();
  // The agent is set BEFORE the relaunch: the driver factory reads it to decide
  // which agent to construct, so setting it after would rebuild the old one.
  ctx.setAgent(agent);
  ctx.forgetConversation();

  // A fresh queue, because the old one belongs to a driver that is going away
  // and may still hold prompts meant for it.
  ctx.getInput().close();
  const input = new AsyncQueue<unknown>();
  ctx.setInput(input);
  ctx.bumpGeneration();
  // No resume id: that is the whole point. Passing one would hand a Claude
  // session id to Codex, which fails in a way that reads like corrupt history.
  ctx.replaceQuery(ctx.getMode(), undefined, input);

  ctx.feedInfo(
    'Agent switched',
    `${agentLabel(previous)} → ${agentLabel(agent)}. New conversation; the previous one is still in this directory's resume picker.`,
  );
  ctx.updated();
  return 'switched';
}
