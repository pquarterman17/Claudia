import type { AgentKind, PermissionLaunchMode } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../src/async-queue.js';
import { applyAgentSwitch, type AgentSwitchCtx } from '../src/agent-switch.js';

/**
 * The rule worth pinning is what a switch does to the CONVERSATION. Claude and
 * Codex keep separate stores and neither can resume the other's id, so a
 * switch must always start fresh and must never carry a resume id across —
 * handing a Claude session id to Codex fails in a way that reads like corrupt
 * history rather than a mismatch.
 */

interface Recorded {
  ctx: AgentSwitchCtx;
  agent: AgentKind;
  live: boolean;
  abandoned: number;
  generations: number;
  forgotten: number;
  relaunches: Array<{ mode: PermissionLaunchMode; resume: string | undefined }>;
  feed: Array<{ title: string; meta?: string }>;
  updates: number;
  inputs: AsyncQueue<unknown>[];
}

function harness(agent: AgentKind = 'claude', live = true): Recorded {
  const first = new AsyncQueue<unknown>();
  const rec: Recorded = {
    ctx: null as never,
    agent,
    live,
    abandoned: 0,
    generations: 0,
    forgotten: 0,
    relaunches: [],
    feed: [],
    updates: 0,
    inputs: [first],
  };
  rec.ctx = {
    getMode: () => 'auto',
    setMode: () => undefined,
    getAgent: () => rec.agent,
    setAgent: (a) => (rec.agent = a),
    forgetConversation: () => (rec.forgotten += 1),
    getQuery: () => (rec.live ? {} : null),
    getInput: () => rec.inputs[rec.inputs.length - 1] as AsyncQueue<unknown>,
    setInput: (q) => rec.inputs.push(q),
    bumpGeneration: () => (rec.generations += 1),
    resumeId: () => 'claude-session-1',
    abandonForRestart: () => (rec.abandoned += 1),
    feedInfo: (title, meta) => rec.feed.push({ title, ...(meta ? { meta } : {}) }),
    updated: () => (rec.updates += 1),
    replaceQuery: (mode, resume) => rec.relaunches.push({ mode, resume }),
  };
  return rec;
}

describe('applyAgentSwitch', () => {
  it('relaunches a live session with the new agent', () => {
    const rec = harness('claude');
    expect(applyAgentSwitch(rec.ctx, 'codex')).toBe('switched');
    expect(rec.agent).toBe('codex');
    expect(rec.relaunches).toHaveLength(1);
    expect(rec.abandoned).toBe(1);
    expect(rec.updates).toBe(1);
  });

  it('NEVER carries a resume id across agents', () => {
    // The whole point. A Claude session id handed to Codex fails in a way that
    // reads like corrupt history, and there is a resume id available here.
    const rec = harness('claude');
    applyAgentSwitch(rec.ctx, 'codex');
    expect(rec.relaunches[0]?.resume).toBeUndefined();
  });

  it('sets the agent BEFORE relaunching, since the driver factory reads it', () => {
    // Setting it afterwards would rebuild the agent being switched away from.
    const rec = harness('claude');
    const seen: AgentKind[] = [];
    rec.ctx.replaceQuery = () => seen.push(rec.agent);
    applyAgentSwitch(rec.ctx, 'codex');
    expect(seen).toEqual(['codex']);
  });

  it('forgets the conversation ids it is leaving behind', () => {
    const rec = harness('claude');
    applyAgentSwitch(rec.ctx, 'codex');
    expect(rec.forgotten).toBe(1);
  });

  it('gives the new driver a fresh input queue', () => {
    // The old queue belongs to a driver that is going away and may still hold
    // prompts meant for it.
    const rec = harness('claude');
    const original = rec.inputs[0];
    applyAgentSwitch(rec.ctx, 'codex');
    expect(rec.inputs).toHaveLength(2);
    expect(rec.inputs[1]).not.toBe(original);
    expect(rec.generations).toBe(1);
  });

  it('says what happened, and that the old conversation is not gone', () => {
    const rec = harness('claude');
    applyAgentSwitch(rec.ctx, 'codex');
    expect(rec.feed[0]?.title).toBe('Agent switched');
    expect(rec.feed[0]?.meta).toContain('Claude Code');
    expect(rec.feed[0]?.meta).toContain('Codex');
    expect(rec.feed[0]?.meta).toMatch(/resume picker/i);
  });

  it('only records the choice when the session never started', () => {
    // Launched idle and never prompted: there is no driver to replace and
    // nothing to leave behind, so the agent just waits for the first prompt.
    const rec = harness('claude', false);
    expect(applyAgentSwitch(rec.ctx, 'codex')).toBe('recorded');
    expect(rec.agent).toBe('codex');
    expect(rec.relaunches).toEqual([]);
    expect(rec.abandoned).toBe(0);
    expect(rec.feed[0]?.meta).toMatch(/has not started/i);
  });

  it('does nothing when the agent is already the one asked for', () => {
    const rec = harness('codex');
    expect(applyAgentSwitch(rec.ctx, 'codex')).toBe('unchanged');
    expect(rec.relaunches).toEqual([]);
    expect(rec.abandoned).toBe(0);
    expect(rec.updates).toBe(0);
    expect(rec.feed).toEqual([]);
  });

  it('switches back the other way just as readily', () => {
    const rec = harness('codex');
    expect(applyAgentSwitch(rec.ctx, 'claude')).toBe('switched');
    expect(rec.agent).toBe('claude');
    expect(rec.feed[0]?.meta).toContain('Codex → Claude Code');
  });

  it('keeps the permission mode the session already had', () => {
    // Switching agent is not a place to quietly widen or narrow permissions.
    const rec = harness('claude');
    applyAgentSwitch(rec.ctx, 'codex');
    expect(rec.relaunches[0]?.mode).toBe('auto');
  });
});
