/**
 * Proves a tag, the manifest and the changelog agree, and writes the notes.
 *
 * Three files claim to know what version this is. A release where they
 * disagree is one where nobody can say what shipped — the tag says 0.2.0, the
 * app reports 0.1.0, and the notes describe neither — so every disagreement is
 * a failure here rather than a published artifact somebody has to retract.
 *
 * Run by .github/workflows/release.yml, and runnable by hand before tagging:
 *
 *   node scripts/release-notes.mjs v0.2.0
 *
 * Exits non-zero with the specific mismatch. Prints the notes it would use, so
 * the dry run is also the proofread.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tag = process.argv[2];
if (!tag) fail('usage: node scripts/release-notes.mjs <tag>');

// `v` is the tag convention; everything after it has to be a plain semantic
// version. A pre-release suffix is allowed — 0.2.0-rc.1 is a real thing to cut
// — but build metadata is not, because `+` is not valid in a file name and the
// changelog heading would have to be quoted differently from every other one.
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) fail(`tag ${tag} is not of the form v1.2.3 or v1.2.3-rc.1`);
const version = match[1];

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.version !== version) {
  fail(`tag ${tag} says ${version}, but package.json says ${manifest.version}`);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const notes = section(changelog, version);
if (notes === undefined) fail(`CHANGELOG.md has no "## [${version}]" section`);
if (notes.trim() === '') fail(`the "## [${version}]" section of CHANGELOG.md is empty`);

const file = join(mkdtempSync(join(tmpdir(), 'claudia-notes-')), 'notes.md');
writeFileSync(file, notes.trim() + '\n', 'utf8');
console.log(`--- notes for ${tag} ---\n${notes.trim()}\n--- end ---`);

// The workflow reads the path from here rather than guessing it. Absent when
// run by hand, which is why the write is conditional and not an error.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `file=${file}\n`);

/**
 * The body of one version's section: the lines after its heading, up to the
 * next one.
 *
 * Line-wise and literal, with no regular expression built from the argument.
 * The first version of this escaped the version into a pattern — `.` in a
 * semantic version is a wildcard, and an unescaped 0.1.0 matches a heading for
 * 0x1y0 — but a regex assembled from input is a regex-injection finding
 * whether or not the escaping happens to be right, and `startsWith` cannot
 * have that class of bug at all. It also reads better: a heading is a line
 * that begins with `## `, which is exactly what this asks.
 */
function section(text, wanted) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${wanted}]`));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('## '));
  return (next === -1 ? rest : rest.slice(0, next)).join('\n');
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
