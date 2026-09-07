/**
 * Accumulates streamed text deltas into a live draft, throttling how often the
 * UI hears about it.
 *
 * Without this the tile freezes between "Session started" and the first
 * complete message — the terminal streams tokens immediately, so a long first
 * answer made Claudia look hung for its entire duration. Deltas arrive many
 * times a second; broadcasting each would flood the socket, so changes are
 * reported at most once per interval.
 *
 * The throttle fires on the trailing edge as well as the leading one, and that
 * matters more than it sounds. Models stream in bursts separated by pauses: a
 * paragraph lands in a few milliseconds, then a tool runs for ten seconds.
 * Emitting only on the leading edge showed the burst's first token and swallowed
 * the rest until some later delta happened to fall outside the window — so the
 * reader watched a stalled tile through the whole pause and then the finished
 * message arrived all at once. Hence the timer: the tail of a burst is emitted
 * on its own, without waiting for a delta that may never come.
 */
export class DraftBuffer {
  private text = '';
  private lastEmit = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** @param emit receives the whole draft so far, never a single delta. */
  constructor(
    private readonly emit: (draft: string) => void,
    private readonly intervalMs = 250,
  ) {}

  /** Appends a delta, emitting it now or scheduling the tail of this burst. */
  append(delta: string, now = Date.now()): void {
    this.text += delta;
    const wait = this.lastEmit + this.intervalMs - now;
    if (wait <= 0) {
      this.flush(now);
      return;
    }
    if (this.timer !== undefined) return; // a flush is already due
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref(); // a pending draft must never hold the process open
  }

  /** Clears after the complete message arrives; returns true if there was a draft. */
  clear(): boolean {
    this.disarm();
    const had = this.text.length > 0;
    this.text = '';
    this.lastEmit = 0;
    return had;
  }

  private flush(now = Date.now()): void {
    this.disarm();
    if (this.text.length === 0) return;
    this.lastEmit = now;
    this.emit(this.text);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
