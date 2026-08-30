/**
 * @-mention completion for the composer — split out of Composer.tsx so the
 * token math and the debounced search request (which together span several
 * edge cases) don't bloat its JSX, and so the pure part is testable without
 * mounting a component.
 */
import type { FileMatch } from '@claudia/shared';
import { type RefObject, useRef, useState } from 'react';
import { send } from './store';

/** Wait this long after a keystroke before asking the server for matches —
 * short enough to feel instant, long enough that fast typing sends one
 * request instead of one per character. */
const DEBOUNCE_MS = 150;

export interface MentionToken {
  /** Index of the '@' that starts this token. */
  start: number;
  /** Text typed after '@', up to the cursor. */
  query: string;
}

/**
 * Finds the @-mention token the cursor is currently inside, if any. A token
 * starts at an '@' preceded by start-of-string or whitespace — so an
 * email-like "user@host" mid-word never triggers it — and runs to the first
 * whitespace after it, so finishing the word and moving on ends the mention.
 */
export function activeMention(text: string, cursor: number): MentionToken | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const prev = before[at - 1];
  if (prev !== undefined && !/\s/.test(prev)) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}

/** Splices the chosen path in for the active token, leaving a trailing space
 * so typing continues straight past it. */
export function insertMention(
  text: string,
  token: MentionToken,
  cursor: number,
  path: string,
): { text: string; cursor: number } {
  const inserted = `@${path} `;
  return { text: text.slice(0, token.start) + inserted + text.slice(cursor), cursor: token.start + inserted.length };
}

/**
 * Drives @-mention completion for one composer: tracks the active token,
 * debounces search_files requests, and matches results back up by query so a
 * slow reply for an old keystroke can never render over a newer one.
 */
export function useMentionCompletion(
  sessionId: string,
  matchesBySession: Record<string, { query: string; matches: FileMatch[] }>,
  draft: string,
  setDraft: (text: string) => void,
  inputRef: RefObject<HTMLInputElement | null>,
) {
  const [token, setToken] = useState<MentionToken | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onDraftChange = (text: string, cursor: number): void => {
    const next = activeMention(text, cursor);
    setToken(next);
    if (timer.current !== undefined) clearTimeout(timer.current);
    if (next?.query) {
      timer.current = setTimeout(() => send({ type: 'search_files', sessionId, query: next.query }), DEBOUNCE_MS);
    }
  };

  const reset = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    setToken(null);
  };

  /** Applies a picked match, then restores focus and caret past the insert —
   * React re-renders the value first, so the caret move waits a frame. */
  const complete = (path: string): void => {
    if (!token) return;
    const cursor = inputRef.current?.selectionStart ?? draft.length;
    const result = insertMention(draft, token, cursor, path);
    setDraft(result.text);
    reset();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(result.cursor, result.cursor));
  };

  const found = matchesBySession[sessionId];
  const matches = token && found && found.query === token.query ? found.matches : [];

  return { matches, onDraftChange, reset, complete };
}
