import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WORKTREE_TRANSITIONS, isLegalRoute, type WorktreeState } from '@claudia/shared';
import { claimWorktree, cleanupWorktree } from '../src/fleet/worktree-owner.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

const dir = mkdtempSync(join(tmpdir(), 'zz-audit-1-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const f of opened) f.close();
  rmSync(dir, { recursive: true, force: true });
});
let counter = 0;
function store(): FleetStore {
  const r = openFleetStore(join(dir, `db-${counter++}`, 'fleet.db'));
  if (!r.ok) throw new Error(r.message);
  opened.push(r.value);
  return r.value;
}
function unwrap<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** A worktree row driven to `state`, owned by ownerTask. */
function seed(fleet: FleetStore, state: WorktreeState, opts: { path?: string; branch?: string } = {}) {
  const mission = unwrap(fleet.missions.create({ name: 'm', body: '', cwd: '/repo' }));
  const owner = unwrap(fleet.tasks.create({ missionId: mission.id, title: 'owner', description: '', cwd: '/repo', acceptance: '' }));
  const wt = unwrap(fleet.worktrees.create({
    repo: '/repo', path: opts.path ?? '/wt/one', branch: opts.branch ?? 'claudia/task-1',
    baseSha: 'a', ownerMissionId: mission.id, ownerTaskId: owner.id, dirty: false,
  }));
  if (state === 'archived' || state === 'removed') unwrap(fleet.worktrees.setState(wt.id, 'idle'));
  if (state === 'removed') unwrap(fleet.worktrees.setState(wt.id, 'archived'));
  if (state !== 'active') unwrap(fleet.worktrees.setState(wt.id, state));
  const record = unwrap(fleet.worktrees.get(wt.id));
  if (!record) throw new Error('setup');
  return { fleet, mission, owner, record };
}

const ALL: WorktreeState[] = ['active', 'idle', 'stale', 'archived', 'removed'];

describe('A: every emitted claim route is legal and applies against a real store', () => {
  it.each(ALL)('missing-from-disk, record %s', (state) => {
    const fleet = store();
    const { mission, owner, record } = seed(fleet, state);
    const verdict = claimWorktree(
      { repo: '/repo', path: '/wt/one', branch: 'claudia/task-1', missionId: mission.id, taskId: owner.id },
      record,
      { exists: false },
    );
    console.log(`[missing] state=${state} ->`, JSON.stringify(verdict));
    if (verdict.kind !== 'adopt') return;
    expect(isLegalRoute(record.state, verdict.path, WORKTREE_TRANSITIONS), `route ${record.state}->${verdict.path}`).toBe(true);
    for (const step of verdict.path) {
      const applied = fleet.worktrees.setState(record.id, step);
      expect(applied.ok, `${state}->${step}: ${applied.ok ? '' : applied.message}`).toBe(true);
    }
  });

  it.each(ALL)('directory-present same-owner, record %s', (state) => {
    const fleet = store();
    const { mission, owner, record } = seed(fleet, state);
    const verdict = claimWorktree(
      { repo: '/repo', path: '/wt/one', branch: 'claudia/task-1', missionId: mission.id, taskId: owner.id },
      record,
      { exists: true, repo: '/repo', branch: 'claudia/task-1', dirty: false },
    );
    console.log(`[present] state=${state} ->`, JSON.stringify(verdict));
    if (verdict.kind !== 'adopt') return;
    expect(isLegalRoute(record.state, verdict.path, WORKTREE_TRANSITIONS)).toBe(true);
    for (const step of verdict.path) {
      const applied = fleet.worktrees.setState(record.id, step);
      expect(applied.ok, `${state}->${step}: ${applied.ok ? '' : applied.message}`).toBe(true);
    }
  });
});

describe('B: adopt with an empty path is indistinguishable from "no work"', () => {
  it('active record, directory gone: adopt says createDirectory but path is []', () => {
    const fleet = store();
    const { mission, owner, record } = seed(fleet, 'active');
    const v = claimWorktree(
      { repo: '/repo', path: '/wt/one', branch: 'claudia/task-1', missionId: mission.id, taskId: owner.id },
      record, { exists: false },
    );
    console.log('[B] active+missing ->', JSON.stringify(v));
    expect(v).toMatchObject({ kind: 'adopt', createDirectory: true });
    if (v.kind === 'adopt') expect(v.path).toEqual([]);
  });
});

describe('C: does the missing-from-disk adopt skip the identity/ownership vetoes?', () => {
  it('another task adopts a row it does not own, on a branch that is not its own', () => {
    const fleet = store();
    // record: owned by task "owner", branch claudia/task-1, idle, directory gone
    const { mission, owner, record } = seed(fleet, 'idle');
    const intruder = unwrap(fleet.tasks.create({ missionId: mission.id, title: 'intruder', description: '', cwd: '/repo', acceptance: '' }));

    const verdict = claimWorktree(
      // different task, different branch, different repo
      { repo: '/other-repo', path: '/wt/one', branch: 'claudia/task-99', missionId: mission.id, taskId: intruder.id },
      record,
      { exists: false },
    );
    console.log('[C] intruder verdict ->', JSON.stringify(verdict));
    console.log('[C] record was owned by', record.ownerTaskId, 'on branch', record.branch, 'repo', record.repo);

    // Same request, but with the directory PRESENT — the checked path.
    const withDir = claimWorktree(
      { repo: '/other-repo', path: '/wt/one', branch: 'claudia/task-99', missionId: mission.id, taskId: intruder.id },
      record,
      { exists: true, repo: '/other-repo', branch: 'claudia/task-99', dirty: false },
    );
    console.log('[C] same request, directory present ->', JSON.stringify(withDir));

    if (verdict.kind === 'adopt') {
      for (const step of verdict.path) {
        const applied = fleet.worktrees.setState(record.id, step);
        expect(applied.ok, applied.ok ? '' : applied.message).toBe(true);
      }
      const after = unwrap(fleet.worktrees.get(record.id));
      console.log('[C] after applying:', JSON.stringify({ state: after?.state, owner: after?.ownerTaskId, branch: after?.branch, repo: after?.repo }));
    }
  });
});

describe('D: cleanup tri-state — can any absent field still authorise a delete?', () => {
  const base = { repo: '/repo', branch: 'claudia/task-1' };
  it('sweeps the unknown-field matrix', () => {
    const fleet = store();
    const { record } = seed(fleet, 'idle');
    const cases: Array<[string, Parameters<typeof cleanupWorktree>[1]]> = [
      ['everything unknown', {}],
      ['exists undefined, dirty false, merged true', { repo: '/repo', branch: 'claudia/task-1', dirty: false, merged: true }],
      ['exists true, repo undefined', { exists: true, branch: 'claudia/task-1', dirty: false, merged: true }],
      ['exists true, branch undefined', { exists: true, repo: '/repo', dirty: false, merged: true }],
      ['exists true, dirty undefined', { exists: true, ...base, merged: true }],
      ['exists true, merged undefined', { exists: true, ...base, dirty: false }],
      ['exists false only', { exists: false }],
      ['exists false, dirty true', { exists: false, dirty: true }],
      ['exists false, repo/branch wrong', { exists: false, repo: '/elsewhere', branch: 'other' }],
    ];
    for (const [name, observed] of cases) {
      const v = cleanupWorktree(record, observed, { busyTaskIds: new Set() });
      console.log(`[D] ${name} -> ${v.kind}: ${v.reason}`);
    }
  });

  it('an unowned record and a confirmedUnmerged entry', () => {
    const fleet = store();
    const { record } = seed(fleet, 'idle');
    const unowned = { ...record, ownerTaskId: undefined };
    console.log('[D2] unowned, everything unknown ->', JSON.stringify(cleanupWorktree(unowned, {}, { busyTaskIds: new Set() })));
    console.log('[D2] unowned, exists false ->', JSON.stringify(cleanupWorktree(unowned, { exists: false }, { busyTaskIds: new Set() })));
    // confirmedUnmerged only bypasses the merged veto, never dirty/identity:
    const conf = { busyTaskIds: new Set<string>(), confirmedUnmerged: new Set([record.id]) };
    console.log('[D2] confirmed + dirty unknown ->', JSON.stringify(cleanupWorktree(record, { exists: true, ...base }, conf)));
    console.log('[D2] confirmed + dirty true ->', JSON.stringify(cleanupWorktree(record, { exists: true, ...base, dirty: true }, conf)));
    console.log('[D2] confirmed + merged unknown + clean ->', JSON.stringify(cleanupWorktree(record, { exists: true, ...base, dirty: false }, conf)));
  });
});
