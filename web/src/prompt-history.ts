/**
 * Shell-style prompt recall for a composer input: Up/Down walk previously
 * sent prompts without this module owning what the user was mid-typing —
 * that stays the caller's responsibility, which is why `next()` past the
 * newest entry hands back `null` rather than a remembered draft.
 */
export class PromptHistory {
  private static readonly CAP = 50;

  private entries: string[] = [];
  /** One past the newest entry means "not currently recalling". */
  private cursor: number;

  constructor() {
    this.cursor = 0;
  }

  /** Records a sent prompt. A repeat of the immediately preceding entry collapses. */
  push(text: string): void {
    if (text !== this.entries[this.entries.length - 1]) {
      this.entries.push(text);
      if (this.entries.length > PromptHistory.CAP) this.entries.shift();
    }
    this.reset();
  }

  /**
   * Steps one entry further into the past, starting from the newest.
   * `current` is accepted (the line the user was typing) but not stored —
   * pure history walking does not need to remember it; the caller restores
   * its own draft when `next()` returns null.
   */
  prev(current: string): string | null {
    void current;
    if (this.entries.length === 0) return null;
    if (this.cursor > 0) this.cursor -= 1;
    return this.entries[this.cursor] ?? null;
  }

  /** Steps one entry back toward the present; null once past the newest entry. */
  next(): string | null {
    if (this.cursor >= this.entries.length) return null;
    this.cursor += 1;
    if (this.cursor >= this.entries.length) {
      this.reset();
      return null;
    }
    return this.entries[this.cursor] ?? null;
  }

  /** Clears the recall cursor. Call after sending a prompt or when the user edits the draft. */
  reset(): void {
    this.cursor = this.entries.length;
  }
}
