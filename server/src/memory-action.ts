import { query } from '@anthropic-ai/claude-agent-sdk';

const PROMPT = `Update your memory files with any durable learnings from the recent work in this
project that are not already recorded.

Work efficiently and converge — this is an automated wrap-up step running unattended, not an
open-ended task. Read your existing memory index and recent git log, then decide. Do not
explore the codebase broadly.

Record only what would genuinely help a future session: decisions and the reasoning behind
them, corrections the user made, non-obvious constraints, gotchas that cost real time. Do not
record what the code or git history already says. If a related memory exists, update it rather
than adding a near-duplicate.

If there is nothing worth saving, change nothing and say so. Finish with one short sentence
naming what you wrote or why you wrote nothing.`;

/**
 * Asks Claude to write up durable learnings into its memory files.
 *
 * This runs as a normal SDK session rather than a shell command, because the
 * work is judgement — deciding what was actually learned — not a fixed
 * operation. It runs with edits auto-accepted so it can write memory files
 * unattended, which is the point: the whole chain fires when nobody is watching.
 */
export async function updateMemories(cwd: string): Promise<string> {
  let summary = '';
  let turns = 0;

  for await (const message of query({
    prompt: PROMPT,
    options: {
      cwd,
      permissionMode: 'acceptEdits',
      // Bounded, but generously: reading the memory index, checking recent
      // history, writing a file and updating the index is comfortably a dozen
      // turns on its own. A first attempt at 12 hit the ceiling after 140s.
      maxTurns: 40,
    },
  }) as AsyncIterable<Record<string, unknown>>) {
    if (message['type'] === 'assistant') {
      const inner = message['message'] as Record<string, unknown> | undefined;
      const content = inner?.['content'];
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block['type'] === 'text' && typeof block['text'] === 'string') summary = block['text'];
        }
      }
      turns++;
    } else if (message['type'] === 'result') {
      const subtype = String(message['subtype'] ?? '');
      if (subtype === 'error_max_turns') {
        // Failing is deliberate: it may have written half of what it intended,
        // so the chain must stop rather than march on to a shutdown.
        throw new Error(`Ran out of turns after ${turns} — memory may be partly written`);
      }
      if (subtype.startsWith('error')) throw new Error(`Memory update failed: ${subtype}`);
      break;
    }
  }

  const line = firstProseLine(summary);
  return `Reviewed in ${turns} turn${turns === 1 ? '' : 's'}${line ? ` — ${line}` : ''}`;
}

/**
 * First line that is actually prose. Replies often open with a decorative rule
 * or heading, and reporting "— ★ ─────" as the outcome tells the reader nothing.
 */
export function firstProseLine(text: string, maxLen = 140): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[#>*\-\s]+/, '');
    // Needs enough letters to be a sentence rather than a divider or a heading.
    const letters = line.replace(/[^A-Za-z]/g, '').length;
    if (letters < 20) continue;
    return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
  }
  return '';
}
