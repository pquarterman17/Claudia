import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The gate between a tag and a published release.
 *
 * Tagging is cheap and un-tagging is not: the moment a release exists somebody
 * can fetch it, and a release whose tag, manifest and changelog disagree is one
 * where nobody can say what shipped. Every case here is a disagreement that has
 * to stop before it becomes an artifact, so the assertions are on the exit code
 * and on the sentence the human reads — not on the happy path alone.
 */

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'release-notes.mjs');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function repo(version: string, changelog: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-release-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'claudia', version }), 'utf8');
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog, 'utf8');
  return dir;
}

function run(cwd: string, tag: string, env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, tag], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, GITHUB_OUTPUT: '', ...env },
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const TWO_VERSIONS = `# Changelog

## [0.2.0] — 2026-09-05

### Added

- the thing

## [0.1.0] — 2026-09-01

- first release
`;

describe('release notes', () => {
  it('takes the section for the tag and stops at the next one', () => {
    const result = run(repo('0.2.0', TWO_VERSIONS), 'v0.2.0');
    expect(result.ok).toBe(true);
    expect(result.out).toContain('the thing');
    // The proof it stopped: the older section's content is not in the notes.
    expect(result.out).not.toContain('first release');
  });

  it('releases an older version from the middle of the file', () => {
    const result = run(repo('0.1.0', TWO_VERSIONS), 'v0.1.0');
    expect(result.ok).toBe(true);
    expect(result.out).toContain('first release');
    expect(result.out).not.toContain('the thing');
  });

  it('refuses a tag the manifest does not agree with', () => {
    // The one that matters most: the tag people fetch and the version the app
    // reports about itself would otherwise be two different numbers.
    const result = run(repo('0.1.0', TWO_VERSIONS), 'v0.2.0');
    expect(result.ok).toBe(false);
    expect(result.out).toContain('package.json says 0.1.0');
  });

  it('refuses a tag that is not a version', () => {
    for (const tag of ['0.2.0', 'v0.2', 'release-0.2.0', 'v0.2.0+build.5']) {
      expect(run(repo('0.2.0', TWO_VERSIONS), tag).ok).toBe(false);
    }
  });

  it('accepts a pre-release tag, which is a real thing to cut', () => {
    const result = run(repo('0.2.0-rc.1', '## [0.2.0-rc.1]\n\ncandidate\n'), 'v0.2.0-rc.1');
    expect(result.ok).toBe(true);
    expect(result.out).toContain('candidate');
  });

  it('refuses a version the changelog never mentions', () => {
    const result = run(repo('0.3.0', TWO_VERSIONS), 'v0.3.0');
    expect(result.ok).toBe(false);
    expect(result.out).toContain('no "## [0.3.0]" section');
  });

  it('refuses a section that is present but empty', () => {
    // A release with no notes is worse than no release: it looks published and
    // says nothing, and the tag cannot be moved once it is out.
    const result = run(repo('0.3.0', '# Changelog\n\n## [0.3.0]\n\n## [0.2.0]\n\n- old\n'), 'v0.3.0');
    expect(result.ok).toBe(false);
    expect(result.out).toContain('is empty');
  });

  it('does not let one version match another version\'s heading', () => {
    // The first version of the extractor built a regex from the argument, and
    // `.` is a wildcard there: an unescaped 0.1.0 matches a heading for 0x1y0.
    // The heading is matched literally now, so this cannot come back — but the
    // case stays, because the bug is in the requirement, not in one
    // implementation of it.
    const result = run(repo('0.1.0', '# Changelog\n\n## [0x1y0]\n\n- not a version\n'), 'v0.1.0');
    expect(result.ok).toBe(false);
    expect(result.out).toContain('no "## [0.1.0]" section');
  });

  it('reads a file with Windows line endings', () => {
    // Development happens on Windows and the extractor is line-wise now, so
    // the line splitter has to be the one thing in it that is not naive.
    const result = run(repo('0.2.0', TWO_VERSIONS.replace(/\n/g, '\r\n')), 'v0.2.0');
    expect(result.ok).toBe(true);
    expect(result.out).toContain('the thing');
    expect(result.out).not.toContain('first release');
  });

  it('tells the workflow where it wrote the notes', () => {
    const dir = repo('0.2.0', TWO_VERSIONS);
    const output = join(dir, 'gh-output');
    writeFileSync(output, '', 'utf8');
    expect(run(dir, 'v0.2.0', { GITHUB_OUTPUT: output }).ok).toBe(true);
    const line = readFileSync(output, 'utf8').trim();
    expect(line.startsWith('file=')).toBe(true);
    // The path is the contract with `gh release create --notes-file`, so the
    // file it names has to exist and hold the section.
    expect(readFileSync(line.slice('file='.length), 'utf8')).toContain('the thing');
  });
});
