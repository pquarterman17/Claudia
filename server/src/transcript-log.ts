import type { TranscriptItem } from '@claudia/shared';

/**
 * Full conversation record for one session — what the feed compresses away.
 * Bounded so a week-long session cannot grow memory without limit; the feed
 * remains the long-horizon summary, this is the readable recent window.
 */
export class TranscriptLog {
  private items: TranscriptItem[] = [];
  /**
   * Total items ever appended, which keeps counting after eviction starts.
   *
   * The array's own length is not a usable position marker: once the log is at
   * its cap, `length` stays at the cap forever, so "how many items were there
   * before I asked?" answers the same number before and after a reply. An
   * orchestrator using that as a cursor concludes the session said nothing —
   * and only on long-lived sessions, which are exactly the ones a human has
   * been working in.
   */
  private appended = 0;

  constructor(private readonly cap = 500) {}

  append(item: TranscriptItem): void {
    this.items.push(item);
    this.appended += 1;
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }

  list(): TranscriptItem[] {
    return [...this.items];
  }

  /** A marker for "everything up to now", stable under eviction. */
  cursor(): number {
    return this.appended;
  }

  /**
   * Items appended after `cursor`.
   *
   * Returns everything still held when the cursor points at entries already
   * evicted: the alternative is silently claiming nothing was said, and a
   * caller asking about a window that has fallen out of the log is better
   * served by what survives than by a confident empty answer.
   */
  since(cursor: number): TranscriptItem[] {
    const firstHeld = this.appended - this.items.length;
    const from = Math.max(0, cursor - firstHeld);
    return this.items.slice(from);
  }

  clear(): void {
    this.items = [];
    // Deliberately NOT reset: a cursor taken before a clear must not suddenly
    // point into the middle of the new conversation.
  }
}
