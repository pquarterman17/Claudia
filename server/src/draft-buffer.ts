/**
 * Accumulates streamed text deltas into a live draft, throttling how often the
 * UI hears about it.
 *
 * Without this the tile freezes between "Session started" and the first
 * complete message — the terminal streams tokens immediately, so a long first
 * answer made Claudia look hung for its entire duration. Deltas arrive many
 * times a second; broadcasting each would flood the socket, so changes are
 * reported at most once per interval, with a final flush on demand.
 */
export class DraftBuffer {
  private text = '';
  private lastEmit = 0;

  constructor(private readonly intervalMs = 250) {}

  /** Appends a delta. Returns the full draft when it is time to emit, else null. */
  append(delta: string, now = Date.now()): string | null {
    this.text += delta;
    if (now - this.lastEmit < this.intervalMs) return null;
    this.lastEmit = now;
    return this.text;
  }

  /** Whatever has accumulated, regardless of throttle. Empty string if nothing. */
  current(): string {
    return this.text;
  }

  /** Clears after the complete message arrives; returns true if there was a draft. */
  clear(): boolean {
    const had = this.text.length > 0;
    this.text = '';
    this.lastEmit = 0;
    return had;
  }
}
