/**
 * Turns the "ask for changes" free-text box into a deny message. A blank or
 * whitespace-only box is not feedback the model can act on, so it must not
 * be sent as an empty-string deny reason (that would read like a silent
 * rejection instead of a request for changes).
 */
export function planFeedbackMessage(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
