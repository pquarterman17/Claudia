/**
 * Turning one objective into several, and several answers back into one.
 *
 * The prompts and the parser live together because they are one contract: the
 * split prompt asks for a shape, and `parseTasks` is the only thing that
 * decides what that shape meant. Keeping them apart is how a parser quietly
 * stops matching a prompt somebody reworded.
 *
 * All pure, so the interesting failures — a planner that answers in prose, a
 * planner that returns twenty tasks, a planner that refuses to split — are
 * testable without spending a turn on a real model.
 */

/** One piece of a split objective. */
export interface CrewTask {
  title: string;
  brief: string;
}

/**
 * Asks for the split.
 *
 * Written to fight the two failure modes a model has here. It over-splits —
 * eight tasks where two would do, because listing feels like working — so the
 * cap is stated as a maximum and fewer is explicitly allowed. And it splits by
 * ACTIVITY ("write the tests", "write the docs") rather than by area, which
 * produces pieces that cannot start until another piece finishes; the ask is
 * for independence, in those words, because that is the property that makes
 * parallel work possible at all.
 */
export function splitPrompt(objective: string, maxTasks: number): string {
  return [
    'Split this objective into independent pieces of work that different agents can do AT THE SAME TIME, in separate copies of this repository.',
    '',
    'The objective:',
    objective,
    '',
    `Rules:`,
    `- At most ${maxTasks} pieces. Fewer is better. If it genuinely should not be split, return exactly one.`,
    '- Each piece must be doable without waiting for any other piece. If two pieces must edit the same function, they are one piece.',
    '- Do not split by activity ("write tests", "write docs"). Split by area of the codebase or by feature.',
    '- Investigate the repository first if you need to, then answer.',
    '',
    'Answer with nothing but this, repeated per piece:',
    'TASK: <short title, a few words>',
    'DO: <one or two sentences: what this piece must accomplish and what it must not touch>',
  ].join('\n');
}

/**
 * Reads the plan back.
 *
 * Deliberately forgiving about decoration — models bullet and bold things they
 * were asked to write plainly, and rejecting `- **TASK:** x` would throw away
 * a perfectly good plan over asterisks. It is NOT forgiving about structure: a
 * line that does not announce a task is treated as continuation of the brief,
 * never as a task, because inventing work from prose is worse than finding
 * none — the caller can fall back, but it cannot un-launch an agent.
 */
export function parseTasks(text: string, maxTasks: number): CrewTask[] {
  const tasks: CrewTask[] = [];
  const seen = new Set<string>();
  let current: CrewTask | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const task = match(line, 'TASK');
    if (task !== undefined) {
      current = task ? { title: task, brief: '' } : undefined;
      if (!current) continue;
      const key = task.toLowerCase();
      // A repeated title means a repeated worktree; the second one would land
      // in the first one's directory and edit its work.
      if (seen.has(key) || tasks.length >= maxTasks) {
        current = undefined;
        continue;
      }
      seen.add(key);
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const does = match(line, 'DO');
    const addition = does ?? line;
    if (!addition) continue;
    current.brief = current.brief ? `${current.brief} ${addition}` : addition;
  }

  return tasks.filter((t) => t.title);
}

/** `TASK: x`, `- **TASK:** x`, `1. TASK - x` and the other shapes of the same line. */
function match(line: string, key: 'TASK' | 'DO'): string | undefined {
  const re = new RegExp(`^(?:[-*+]|\\d+[.)])?\\s*\\**\\s*${key}\\s*\\**\\s*[:\\-—]\\s*(.*)$`, 'i');
  const m = re.exec(line);
  return m ? (m[1] ?? '').replace(/\*+/g, '').trim() : undefined;
}

/**
 * A git branch name for one piece, unique to this run.
 *
 * The run token is not decoration: worktrees are reused when their directory
 * already exists, so without it a second crew on the same objective would open
 * its members inside the first crew's checkouts and edit that work.
 */
export function crewBranch(runId: string, index: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'task';
  return `claudia/crew-${runId}-${index + 1}-${slug}`;
}

/**
 * What one member is told.
 *
 * It is given the whole objective as well as its own piece, because a member
 * that only knows its fragment makes decisions that contradict the others.
 * And it is told where it is: a member that does not know it is in a private
 * worktree tries to be polite about a shared repository and does half the job.
 */
export function memberPrompt(objective: string, task: CrewTask, branch: string, siblings: string[]): string {
  const others = siblings.filter((s) => s !== task.title);
  return [
    'You are one of several agents working on one objective at the same time. This is your piece of it.',
    '',
    'The overall objective:',
    objective,
    '',
    'YOUR piece:',
    task.title,
    task.brief,
    '',
    ...(others.length ? [`Other agents are doing, right now: ${others.join('; ')}. Do not do their work.`, ''] : []),
    `You are alone in your own checkout of this repository, on branch ${branch}. Nobody else can see or overwrite your changes, so edit files directly.`,
    'Leave your work uncommitted in the working tree — a human reviews the branches before anything is merged.',
    '',
    'When you are done, finish with a short summary: what you changed, what you did not do, and anything the other pieces need to know.',
  ].join('\n');
}

/** One member's outcome, as the planner is shown it. */
export interface MemberReport {
  title: string;
  branch?: string;
  summary?: string;
  error?: string;
}

/**
 * The closing ask.
 *
 * The human's real question after coming back is "is any of this in conflict,
 * and what do I have to do now" — so those are asked for by name rather than
 * hoped for out of free prose. The planner is told not to re-read the
 * repository: it would spend a long turn re-deriving what it is being handed.
 */
export function reportPrompt(objective: string, reports: MemberReport[]): string {
  const body = reports.map((r) =>
    [
      `--- ${r.title}${r.branch ? ` (branch ${r.branch})` : ''}`,
      r.error ? `FAILED: ${r.error}` : (r.summary ?? '(said nothing)'),
    ].join('\n'),
  );
  return [
    'The agents you split this objective between have finished. Here is what each reported back.',
    '',
    'The objective:',
    objective,
    '',
    ...body,
    '',
    'Do not re-read the repository. Using only what is above, answer in this exact shape and nothing else:',
    '',
    'DONE: what the objective now has that it did not before.',
    'CONFLICTS: pieces that overlap or contradict each other, and where. Write "none" if there are none.',
    'LEFT: what the objective still needs. Write "nothing" if it is complete.',
    'NEEDS YOU: decisions or merges a human has to do. Write "nothing" if there are none.',
  ].join('\n');
}
