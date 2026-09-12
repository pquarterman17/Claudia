import type { Capability } from './capabilities.js';

/**
 * The capability a live tool call needs, when it can be named from the call
 * alone.
 *
 * `undefined` means "nothing this module can speak to", and every caller
 * treats that as "carry on to whatever gate you already had". That direction
 * matters: a fleet child runs in `default` permission mode, so an unclassified
 * call still parks on a human. This map can therefore only ever TIGHTEN the
 * boundary, and a tool it fails to recognise degrades to the behaviour that
 * existed before it — never to an approval nobody gave.
 *
 * Worth being precise about what "tighten" buys, because it is narrower than
 * it looks: the policy this feeds only ever REFUSES. Naming a capability the
 * run already holds changes nothing — the call goes on to the same approval
 * banner it would have reached anyway. So classifying `sed -i` as `repo.write`
 * would be decoration, and the only classifications that do any work are the
 * ones no child holds by default: `net`, `destructive`, `git.push` and
 * `git.merge`. Those are what this file is for.
 */
export function capabilityForTool(toolName: string, input: Record<string, unknown>): Capability | undefined {
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'net';
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'repo.write';
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') return 'repo.read';
  if (toolName !== 'Bash') return undefined;
  const command = input['command'];
  if (typeof command !== 'string') return undefined;
  return capabilityForCommand(command);
}

/**
 * Reading a shell command is imprecise by nature, so this only answers where
 * it is confident and returns undefined everywhere else.
 *
 * Git first and by subcommand, because those are the least ambiguous strings
 * in a shell. Word boundaries around the subcommand keep `git pushd` and a
 * branch called `merge` from reading as the real thing.
 */
function capabilityForCommand(command: string): Capability | undefined {
  // Talking to a remote. `fetch` is harmless in itself, but it is still egress
  // and a child working in its own worktree has no ordinary need of it; if a
  // mission does, the grant is the place to say so.
  if (/\bgit\s+(?:clone|fetch|pull|remote|ls-remote)\b/.test(command)) return 'net';
  // Throwing work away, rather than writing it. Plain `git clean` refuses
  // without a force flag, so reaching for it at all is the destructive intent.
  if (/\bgit\s+reset\s+--hard\b/.test(command)) return 'destructive';
  if (/\bgit\s+clean\b/.test(command)) return 'destructive';
  if (/\bgit\s+branch\s+(?:-D|--delete\s+--force|--force\s+--delete)\b/.test(command)) return 'destructive';
  if (/\bgit\s+push\b/.test(command)) return 'git.push';
  if (/\bgit\s+merge\b/.test(command)) return 'git.merge';
  if (/\bgit\s+commit\b/.test(command)) return 'git.commit';
  if (runs(command, EGRESS)) return 'net';
  if (runs(command, WRECKING)) return 'destructive';
  // `rm` earns its flags rather than its name: deleting one file it just wrote
  // is ordinary work, and recursive or forced removal is not.
  if (runs(command, ['rm']) && /\brm\s+(?:-\S*[rRf]|--(?:recursive|force))/.test(command)) return 'destructive';
  // Deliberately unclassified: `npm`/`pip`/`cargo` installs need the network,
  // but they are also what an ordinary child does before it can run a test.
  // Naming them `net` would refuse honest work outright instead of parking it
  // on a human, which is the one thing this map promises not to do.
  return undefined;
}

/** Programs whose whole job is moving bytes off this machine. */
const EGRESS = ['curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync'];

/** Programs with no non-destructive reading. */
const WRECKING = ['dd', 'shred', 'truncate', 'mkfs', 'fdisk', 'sudo', 'doas'];

/**
 * Whether `command` actually RUNS one of `programs`, rather than mentioning
 * one.
 *
 * A bare `\bnc\b` matches the filename `sync.nc` and `\bcurl\b` matches a
 * branch named `curl` — either would refuse a child for doing nothing wrong,
 * and a boundary that misfires gets switched off. So a name only counts at a
 * command position: the start of the line, or after a pipe, separator,
 * subshell or newline, past any leading environment assignments.
 */
function runs(command: string, programs: readonly string[]): boolean {
  const at = String.raw`(?:^|[\n;|&(]|\$\(|\x60)`;
  const leading = String.raw`[ \t]*(?:\w+=\S*[ \t]+)*`;
  // Not followed by a word character or dash, so `curl` and `curl.exe` count
  // while `curling` and `mkfs-helper` do not. `mkfs.ext4` is meant to count.
  return new RegExp(`${at}${leading}(?:${programs.join('|')})(?![\\w-])`).test(command);
}
