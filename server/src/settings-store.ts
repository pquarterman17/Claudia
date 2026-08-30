import type { FinishActionKey, PermissionLaunchMode, PlanTier, SessionTemplate, ToolkitAction } from '@claudia/shared';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Settings {
  planTier: PlanTier;
  /** Ordered chain of finish actions. */
  finishChain: FinishActionKey[];
  countdownSec: number;
  /**
   * Seconds after the last browser closes before sessions are stopped.
   * 0 disables it and leaves sessions running headless.
   */
  stopSessionsWhenClosedSec: number;
  /** Remembered so relaunching in the same repo doesn't mean retyping the path. */
  recentDirectories: string[];
  defaultPermissionMode: PermissionLaunchMode;
  /** Saved launch shapes (cwd + prompt + permission mode), most-recent first. */
  templates: SessionTemplate[];
  /** Saved prompts that can be fired at a session already running. */
  toolkit: ToolkitAction[];
  /** Ceilings the user has calibrated themselves, used when planTier === 'custom'. */
  customCeilings?: { sessionTokens: number; weeklyTokens: number };
}

/** A generous ceiling; the palette stops being scannable long before this. */
const MAX_TOOLKIT = 40;

const DEFAULTS: Settings = {
  planTier: 'auto',
  finishChain: ['notify'],
  countdownSec: 30,
  // Long enough to ride out a page reload, short enough that a closed tab does
  // not leave sessions spending tokens unattended.
  stopSessionsWhenClosedSec: 30,
  recentDirectories: [],
  defaultPermissionMode: 'auto',
  templates: [],
  // Seeded rather than empty: a toolkit with nothing in it reads as broken, and
  // these three are the ones worth having in any repo. All are read-or-fix
  // instructions; nothing here pushes, tags or rewrites anything on its own.
  toolkit: [
    {
      id: 'seed-tests',
      name: 'Run & fix tests',
      prompt: "Run this project's test suite. If anything fails, diagnose and fix it, then run it again to confirm.",
    },
    {
      id: 'seed-diff',
      name: 'Diff summary',
      prompt: 'Summarise the changes on this branch compared with main, grouped by intent rather than by file.',
    },
    {
      id: 'seed-review',
      name: 'Review my changes',
      prompt: 'Review the uncommitted changes critically for bugs, missed cases, and anything inconsistent with the conventions of this repo. Report first; do not fix anything yet.',
    },
  ],
};

const MAX_RECENT = 8;
const MAX_TEMPLATES = 12;

export function settingsPath(): string {
  return join(process.env['CLAUDIA_DATA_DIR'] ?? join(homedir(), '.claudia'), 'settings.json');
}

/**
 * Settings on disk as a single small JSON file.
 *
 * SQLite was in the plan, but nothing here is relational or large — it is one
 * flat record — and a JSON file keeps the dependency count at zero and stays
 * hand-editable. Session history is deliberately NOT persisted: Claude Code
 * already owns the transcripts, and duplicating them would be a second source
 * of truth to keep in step.
 */
export class SettingsStore {
  private current: Settings;
  private readonly path: string;

  constructor(path = settingsPath()) {
    this.path = path;
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    this.current = { ...this.current, ...patch };
    this.save();
    return this.current;
  }

  /** Most recent first, de-duplicated, capped. */
  rememberDirectory(dir: string): void {
    const rest = this.current.recentDirectories.filter((d) => d !== dir);
    this.update({ recentDirectories: [dir, ...rest].slice(0, MAX_RECENT) });
  }

  /** Upserts by name (same name replaces, moved to the front), most-recent first, capped. */
  saveTemplate(template: SessionTemplate): void {
    const rest = this.current.templates.filter((t) => t.name !== template.name);
    this.update({ templates: [template, ...rest].slice(0, MAX_TEMPLATES) });
  }

  deleteTemplate(name: string): void {
    this.update({ templates: this.current.templates.filter((t) => t.name !== name) });
  }

  /** Adds or replaces an action, keyed by id so editing one does not duplicate it. */
  saveToolkitAction(action: ToolkitAction): void {
    const rest = this.current.toolkit.filter((a) => a.id !== action.id);
    this.update({ toolkit: [...rest, action].slice(0, MAX_TOOLKIT) });
  }

  deleteToolkitAction(id: string): void {
    this.update({ toolkit: this.current.toolkit.filter((a) => a.id !== id) });
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Settings>;
      // Merge over defaults so a file written by an older version stays valid.
      return { ...DEFAULTS, ...raw };
    } catch {
      return { ...DEFAULTS };
    }
  }

  /**
   * Write to a temp sibling then rename, so a crash mid-write cannot leave a
   * truncated settings file that fails to parse on next start.
   */
  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch {
      // Settings are a convenience; failing to persist must not break the app.
    }
  }
}
