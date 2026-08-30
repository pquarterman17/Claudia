/**
 * Says what the finish chain will do, in one sentence.
 *
 * The numbered list with reorder arrows answers "what is in the chain"; it does
 * not answer "so what happens when this fires?" without reading every row and
 * mentally sequencing it. That gap is why arming a chain that ends in shutdown
 * feels risky enough to avoid testing — which is the worst outcome, because an
 * untested chain is exactly the one that surprises you.
 *
 * Kept pure and separate from the component so the wording is unit-tested: this
 * sentence is a safety affordance, not decoration.
 */

/** Steps whose effect the user cannot simply undo by clicking again. */
const DESTRUCTIVE_HINT: Record<string, string> = {
  sleep: 'your displays turn off',
  shutdown: 'this machine powers off',
};

/**
 * Steps that touch something outside this machine, or that decline to.
 *
 * A push is not destructive — nothing is lost — but it is visible to other
 * people, and the branch rule is the thing worth knowing BEFORE arming rather
 * than discovering in a failed step at 3am.
 */
const OUTWARD_HINT: Record<string, string> = {
  commit: 'Commit + push only stages what each session wrote, and refuses on main or master.',
};

export interface ChainSentenceInput {
  /** Ordered step labels, already resolved to human wording. */
  labels: string[];
  /** Step keys in the same order, used to name the irreversible ones. */
  keys: string[];
  /** Seconds of grace before the chain runs, if one is configured. */
  countdownSec?: number;
}

/**
 * One sentence describing the armed sequence, or null when nothing is selected
 * (the empty state already explains itself).
 */
export function chainSentence({ labels, keys, countdownSec }: ChainSentenceInput): string | null {
  if (labels.length === 0) return null;

  const sequence = joinSteps(labels.map((l) => l.toLowerCase()));
  const grace =
    countdownSec && countdownSec > 0
      ? ` You get ${formatSeconds(countdownSec)} to cancel first.`
      : '';

  const finale = keys.map((k) => DESTRUCTIVE_HINT[k]).filter(Boolean).pop();
  const consequence = finale ? ` The last step means ${finale}.` : '';
  const outward = keys.map((k) => OUTWARD_HINT[k]).filter(Boolean).join(' ');

  return `When every session settles, Claudia will ${sequence}.${grace}${consequence}${outward ? ` ${outward}` : ''}`;
}

/** "a", "a, then b", "a, then b, then c" — the order is the point, so no "and". */
function joinSteps(steps: string[]): string {
  if (steps.length === 1) return steps[0] ?? '';
  return steps.join(', then ');
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${total} seconds`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  const minutes = `${min} minute${min === 1 ? '' : 's'}`;
  return sec === 0 ? minutes : `${minutes} ${sec}s`;
}
