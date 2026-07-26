/**
 * Push-based AsyncIterable. The Agent SDK's streaming-input mode consumes an
 * AsyncIterable of user messages; this lets us push follow-up prompts into a
 * running session from WS commands.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  /**
   * Removes and returns everything buffered but not yet consumed. Used when a
   * queue is being replaced: items the old consumer never read (e.g. prompts
   * queued behind a running turn) move to the new queue instead of vanishing.
   */
  drain(): T[] {
    return this.buffer.splice(0);
  }

  /** Ends iteration; pending waiters resolve as done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
