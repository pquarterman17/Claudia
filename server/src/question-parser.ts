import type { PendingQuestion } from '@claudia/shared';

/**
 * Reads the AskUserQuestion tool payload.
 *
 * The tool arrives through `canUseTool` like any other, but it is not really a
 * permission: the answer is handed back as `updatedInput.answers`, keyed by
 * question text — "collected by the permission component", as the SDK schema
 * puts it. So Claudia renders it as a picker and resolves the same callback.
 */
export function parseQuestions(input: Record<string, unknown>): PendingQuestion['questions'] | null {
  const raw = input['questions'];
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const questions: PendingQuestion['questions'] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const question = typeof entry['question'] === 'string' ? entry['question'] : '';
    if (!question) continue;
    const options = Array.isArray(entry['options'])
      ? (entry['options'] as Array<Record<string, unknown>>)
          .map((o) => ({
            label: typeof o['label'] === 'string' ? o['label'] : '',
            description: typeof o['description'] === 'string' ? o['description'] : '',
          }))
          .filter((o) => o.label)
      : [];
    if (options.length === 0) continue;
    questions.push({
      question,
      header: typeof entry['header'] === 'string' ? entry['header'] : '',
      multiSelect: entry['multiSelect'] === true,
      options,
    });
  }
  return questions.length > 0 ? questions : null;
}

/**
 * Builds the tool input carrying the user's answers. Keyed by question text,
 * which is what the tool expects — not by index.
 */
export function withAnswers(
  input: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, unknown> {
  return { ...input, answers };
}
