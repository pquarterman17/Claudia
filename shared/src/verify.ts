/**
 * The command a mission checks its work with, and what it is allowed to be.
 *
 * ONE command, never a chain. That restriction is the whole reason this module
 * exists: the command is configured over the wire and runs unattended in a
 * directory an agent has been writing to, and it is run THROUGH A SHELL —
 * because `npm` on Windows is `npm.cmd`, which node will not spawn without
 * one, so the commonest check anybody would write is impossible otherwise.
 *
 * With a shell doing the running, the refusal here is the boundary. Every
 * character a shell reads as more than arguments is rejected where the command
 * is written — `&`, `|`, `;`, backticks, `$(`, redirection, a newline — so a
 * stored command cannot start a second thing that nobody typed into the box.
 * Chaining and substitution both need one of those, which is what makes a list
 * of them a boundary rather than a hopeful filter.
 *
 * The other half of the argument is quieter and matters as much: a command
 * that cannot mean what it says is worse than no command. `npm test && npm run
 * lint` is a reasonable thing to type, and every way of half-honouring it ends
 * with the fleet REJECTING good work for the rest of the mission's life.
 * Somebody who wants two commands writes a script and names that.
 *
 * Pure string work, in `shared` rather than the server, so the store validates
 * on the way in and the runner refuses on the way out against ONE definition —
 * the same reason `TASK_TRANSITIONS` lives here.
 */

/** What a shell would treat as more than an argument. */
const SHELL_OPERATORS = ['&', '|', ';', '`', '$(', '>', '<', '\n'];

/**
 * The words of a command, or `undefined` if it does not have any.
 *
 * Used to ask whether a command HAS a program to run and whether its quotes
 * close — the shell does the real splitting. An unbalanced quote is not a
 * command: a shell would either wait for more input or read the rest of the
 * line as one argument, and neither is what was written.
 */
export function commandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: string | undefined;
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      // A quote starts a word even when what it encloses is empty, so `""`
      // is an empty argument rather than nothing at all.
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(current);
  return words.length > 0 ? words : undefined;
}

/**
 * Why this command cannot be stored, or `undefined` if it can.
 *
 * Answers with the reason rather than a boolean because it is shown to the
 * person typing it: "that is not a command" is not an explanation, and the
 * one-command rule is surprising enough to have to be stated.
 */
export function verifyCommandProblem(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === '') return undefined; // Clearing it is always allowed.
  const operator = SHELL_OPERATORS.find((op) => trimmed.includes(op));
  if (operator !== undefined) {
    return `A verify command runs one program without a shell, so "${operator}" cannot be part of it. Put several commands in a script and name that instead.`;
  }
  if (commandWords(trimmed) === undefined) {
    return 'A verify command needs a program to run, with its quotes balanced.';
  }
  return undefined;
}
