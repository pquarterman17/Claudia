import type { TranscriptItem } from '@claudia/shared';

/**
 * Full conversation record for one session — what the feed compresses away.
 * Bounded so a week-long session cannot grow memory without limit; the feed
 * remains the long-horizon summary, this is the readable recent window.
 */
export class TranscriptLog {
  private items: TranscriptItem[] = [];

  constructor(private readonly cap = 500) {}

  append(item: TranscriptItem): void {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }

  list(): TranscriptItem[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}
