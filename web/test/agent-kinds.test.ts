import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, agentKindLabel, capabilitiesFor } from '../src/agent-kinds';

describe('AGENT_KINDS', () => {
  it('leads with Claude, since it is the default agent', () => {
    expect(AGENT_KINDS[0]?.key).toBe('claude');
  });

  it('lists Codex as a second, distinct agent', () => {
    const keys = AGENT_KINDS.map((a) => a.key);
    expect(keys).toContain('codex');
  });

  it('has exactly one entry per agent — no duplicates', () => {
    const keys = AGENT_KINDS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('agentKindLabel', () => {
  it('labels Claude and Codex', () => {
    expect(agentKindLabel('claude')).toBe('Claude Code');
    expect(agentKindLabel('codex')).toBe('Codex');
  });

  it('treats an absent agent as Claude — older sessions never named one', () => {
    expect(agentKindLabel(undefined)).toBe('Claude Code');
  });
});

describe('capabilitiesFor', () => {
  it('grants Claude every capability', () => {
    const caps = capabilitiesFor('claude');
    expect(Object.values(caps).every(Boolean)).toBe(true);
  });

  it('treats an absent agent the same as Claude', () => {
    expect(capabilitiesFor(undefined)).toEqual(capabilitiesFor('claude'));
  });

  it('withholds every measured-gap capability from Codex', () => {
    const caps = capabilitiesFor('codex');
    expect(caps).toEqual({
      cost: false,
      context: false,
      modelPicker: false,
      mcpPanel: false,
      effectiveSettings: false,
      fileCheckpoints: false,
    });
  });
});
