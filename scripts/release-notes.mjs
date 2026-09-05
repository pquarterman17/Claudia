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
 * The body of one version's section: everything after its heading, up to the
 * next one.
 *
 * Matched on the heading rather than by splitting the whole file, so a `## `
 * that appears inside a fenced code block in some other section cannot shorten
 * this one — and the version is escaped because `.` in a semantic version is
 * a regex wildcard that would let 0.1.0 match a heading for 0x1y0.
 */
function section(text, wanted) {
  const heading = new RegExp(`^## \\[${wanted.replace(/[.+\-]/g, '\\$&')}\\].*$`, 'm');
  const start = heading.exec(text);
  if (!start) return undefined;
  const rest = text.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
