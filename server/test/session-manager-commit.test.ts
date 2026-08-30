import { describe, expect, it, vi } from 'vitest';
import { FakeQuery, tick, toolResultMsg, toolUseMsg } from './fake-query.js';

/**
 * What the "commit + push" finish action is handed.
 *
 * Grouping is by DIRECTORY rather than by session because that is the unit git
 * works in, and the owner's normal shape is several sessions in one repository.
 * Driven through the same fake query seam as the lifecycle vectors, since the
 * only honest way to know what a session wrote is to make it write something.
 */

const fakes: FakeQuery[] = [];

vi.mock('../src/query-factory.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/query-factory.js')>();
  return {
    ...real,
    createSessionQuery: (spec: import('../src/query-factory.js').QuerySpec) => {
      const fake = new FakeQuery(spec);
      fakes.push(fake);
      return fake as never;
    },
  };
});

const { SessionManager } = await import('../src/session-manager.js');

const silent = {
  onUpdate: () => {},
  onFeed: () => {},
  onFeedPatch: () => {},
  onDraft: () => {},
  onCommands: () => {},
  onTranscript: () => {},
  onRemoved: () => {},
};

/** Runs one Edit to completion in the newest session. */
async function edit(path: string, id: string): Promise<void> {
  const fake = fakes[fakes.length - 1];
  fake?.emit(toolUseMsg('Edit', { file_path: path }, id));
  fake?.emit(toolResultMsg(id));
  await tick();
}

describe('SessionManager.touchedByDirectory', () => {
  it('merges sessions sharing a directory into one entry', async () => {
    const manager = new SessionManager(silent);
    manager.launch({ cwd: '/repo', permissionMode: 'auto', prompt: 'one' });
    await tick();
    await edit('/repo/a.ts', 'a');
    manager.launch({ cwd: '/repo', permissionMode: 'auto', prompt: 'two' });
    await tick();
    await edit('/repo/b.ts', 'b');

    expect(manager.touchedByDirectory()).toEqual([{ cwd: '/repo', files: ['/repo/a.ts', '/repo/b.ts'], titles: [] }]);
  });

  it('keeps separate directories apart', async () => {
    const manager = new SessionManager(silent);
    manager.launch({ cwd: '/one', permissionMode: 'auto', prompt: 'x' });
    await tick();
    await edit('/one/a.ts', 'a');
    manager.launch({ cwd: '/two', permissionMode: 'auto', prompt: 'x' });
    await tick();
    await edit('/two/b.ts', 'b');

    expect(manager.touchedByDirectory().map((w) => w.cwd)).toEqual(['/one', '/two']);
  });

  it('leaves out a session that wrote nothing', async () => {
    // A read-only session must not put its title on another session's commit,
    // nor drag its directory into the branch check for no reason.
    const manager = new SessionManager(silent);
    manager.launch({ cwd: '/repo', permissionMode: 'auto', prompt: 'just looking' });
    await tick();
    expect(manager.touchedByDirectory()).toEqual([]);
  });

  it('names the same file once however many times it was written', async () => {
    const manager = new SessionManager(silent);
    manager.launch({ cwd: '/repo', permissionMode: 'auto', prompt: 'x' });
    await tick();
    await edit('/repo/a.ts', 'first');
    await edit('/repo/a.ts', 'second');
    expect(manager.touchedByDirectory()[0]?.files).toEqual(['/repo/a.ts']);
  });

  it('carries the session title through for the commit message', async () => {
    const manager = new SessionManager(silent);
    const session = manager.launch({ cwd: '/repo', permissionMode: 'auto', prompt: 'x' });
    await tick();
    await edit('/repo/a.ts', 'a');
    session.rename('Add the commit action');
    expect(manager.touchedByDirectory()[0]?.titles).toEqual(['Add the commit action']);
  });
});
