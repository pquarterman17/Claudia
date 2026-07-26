import { describe, expect, it } from 'vitest';
import { listCommands, mergeCommands, modelMatches, type ParityQuery, UNADVERTISED_COMMANDS } from '../src/parity-controls.js';

describe('mergeCommands', () => {
  it('adds the built-ins the CLI does not advertise', () => {
    // Measured against a live session: the init message listed 65 commands,
    // mostly custom skills, and included neither /cost nor /context even though
    // both run.
    const advertised = ['compact', 'context', 'clear', 'model', 'agents', 'init'];
    const merged = mergeCommands(advertised);
    expect(merged).toContain('cost');
    expect(merged).toContain('context');
  });

  it('does not duplicate one that was already advertised', () => {
    const merged = mergeCommands(['context', 'clear']);
    expect(merged.filter((c) => c === 'context')).toHaveLength(1);
  });

  it('keeps every advertised command and sorts the result', () => {
    const advertised = ['zzz-skill', 'aaa-skill'];
    const merged = mergeCommands(advertised);
    for (const c of advertised) expect(merged).toContain(c);
    expect(merged).toEqual([...merged].sort());
  });

  it('lists only built-ins verified to run in an SDK session', () => {
    // /todos answers "Unknown command"; /status and /help reply that they are
    // not available in this environment. Advertising a dead command is worse
    // than omitting it.
    for (const dead of ['todos', 'status', 'help']) {
      expect(UNADVERTISED_COMMANDS as readonly string[]).not.toContain(dead);
    }
  });
});

describe('modelMatches', () => {
  it('matches a short pick against the full name a turn reports', () => {
    expect(modelMatches('haiku', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(modelMatches('sonnet', 'claude-sonnet-5')).toBe(true);
  });

  it('matches a long-context pick by family', () => {
    expect(modelMatches('opus[1m]', 'claude-opus-5')).toBe(true);
  });

  it('treats "default" as satisfied by whatever ran', () => {
    expect(modelMatches('default', 'claude-fable-5')).toBe(true);
  });

  it('does not match a different family', () => {
    // The case that made the switch look broken: a turn already in flight
    // reports its own model, which must not clear a pending pick.
    expect(modelMatches('haiku', 'claude-fable-5')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(modelMatches(undefined, 'claude-fable-5')).toBe(false);
    expect(modelMatches('haiku', undefined)).toBe(false);
  });
});

describe('listCommands', () => {
  it('is the fallback path: [] when the query has no supportedCommands (older SDK, or not started)', async () => {
    await expect(listCommands(null)).resolves.toEqual([]);
    await expect(listCommands({})).resolves.toEqual([]);
  });

  it('is the fallback path: [] when supportedCommands throws, so the caller keeps the init-message list', async () => {
    const q: ParityQuery = {
      supportedCommands: async () => {
        throw new Error('control channel not ready');
      },
    };
    await expect(listCommands(q)).resolves.toEqual([]);
  });

  it('carries name, description and argumentHint through untouched', async () => {
    const q: ParityQuery = {
      supportedCommands: async () => [{ name: 'compact', description: 'Free up context', argumentHint: '<instructions>' }],
    };
    expect(await listCommands(q)).toEqual([
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
    ]);
  });

  it('surfaces aliases as their own entries — how /cost shows up at all', async () => {
    // Measured against a live session: supportedCommands() never returns a
    // bare "cost" entry. /cost is an alias of /usage, exactly as the SDK's
    // own SlashCommand.aliases doc comment says ("/cost and /stats both
    // resolve to /usage"). Without flattening, the composer would still
    // never offer /cost even with the live call wired up.
    const q: ParityQuery = {
      supportedCommands: async () => [
        {
          name: 'usage',
          description: 'Show session cost, plan usage, and what is contributing to your limits',
          argumentHint: '',
          aliases: ['cost', 'stats'],
        },
      ],
    };
    const commands = await listCommands(q);
    const names = commands.map((c) => c.name);
    expect(names).toEqual(['cost', 'stats', 'usage']); // sorted
    expect(commands.find((c) => c.name === 'cost')?.description).toContain('alias for /usage');
  });
});
