import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/settings-store.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-settings-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pathFor = (name: string) => join(dir, name, 'settings.json');

describe('SettingsStore', () => {
  it('starts from defaults when there is no file', () => {
    const s = new SettingsStore(pathFor('fresh'));
    expect(s.get().planTier).toBe('auto');
    expect(s.get().countdownSec).toBe(30);
    expect(s.get().recentDirectories).toEqual([]);
  });

  it('persists across instances', () => {
    const path = pathFor('persist');
    new SettingsStore(path).update({ countdownSec: 90, planTier: 'max20x' });
    const reloaded = new SettingsStore(path);
    expect(reloaded.get().countdownSec).toBe(90);
    expect(reloaded.get().planTier).toBe('max20x');
  });

  it('merges over defaults so an older file stays valid', () => {
    const path = pathFor('partial');
    const dirPath = join(dir, 'partial');
    rmSync(dirPath, { recursive: true, force: true });
    new SettingsStore(path).update({}); // creates the directory
    writeFileSync(path, JSON.stringify({ countdownSec: 45 }), 'utf8');

    const s = new SettingsStore(path);
    expect(s.get().countdownSec).toBe(45);
    expect(s.get().finishAction).toBe('notify'); // filled from defaults
  });

  it('falls back to defaults on a corrupt file rather than throwing', () => {
    const path = pathFor('corrupt');
    new SettingsStore(path).update({});
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => new SettingsStore(path)).not.toThrow();
    expect(new SettingsStore(path).get().countdownSec).toBe(30);
  });

  it('keeps recent directories most-recent-first without duplicates', () => {
    const s = new SettingsStore(pathFor('recent'));
    s.rememberDirectory('/a');
    s.rememberDirectory('/b');
    s.rememberDirectory('/a');
    expect(s.get().recentDirectories).toEqual(['/a', '/b']);
  });

  it('caps the recent list', () => {
    const s = new SettingsStore(pathFor('cap'));
    for (let i = 0; i < 20; i++) s.rememberDirectory(`/d${i}`);
    expect(s.get().recentDirectories).toHaveLength(8);
    expect(s.get().recentDirectories[0]).toBe('/d19');
  });

  it('writes valid JSON, not a truncated file', () => {
    const path = pathFor('valid');
    new SettingsStore(path).update({ countdownSec: 12 });
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });

  it('survives an unwritable path instead of crashing the app', () => {
    // Settings are a convenience; losing them must never take the server down.
    const s = new SettingsStore(join(dir, 'nul-ish', '\0bad', 'settings.json'));
    expect(() => s.update({ countdownSec: 60 })).not.toThrow();
    expect(s.get().countdownSec).toBe(60);
  });
});
