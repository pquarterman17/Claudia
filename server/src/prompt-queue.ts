/**
 * Tracks prompts sent while a session's turn is already in flight.
 *
 * The Agent SDK's streaming-input mode lets `sendPrompt` push text into the
 * input stream at any time — if a turn is running, the CLI just queues it and
 * runs it after the current turn ends. That behavior is correct but invisible
 * to the user, so the session pushes here whenever a prompt lands mid-turn.
 * When a `result` message ends the current turn, the first queued prompt
 * becomes the active turn, so the session shifts one off.
 */
export class PromptQueue {
  private items: string[] = [];

  push(text: string): void {
    this.items.push(text);
  }

  /** Copy of the queue, FIFO order — mutating the result does not affect the queue. */
  list(): string[] {
    return [...this.items];
  }

  /** Drops the oldest queued prompt. A no-op when the queue is empty. */
  shift(): void {
    this.items.shift();
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
