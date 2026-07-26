/**
 * Hand-rolled, minimal markdown renderer for chat replies — not a spec
 * implementation. Handles ONLY: fenced code blocks (``` with an optional
 * language), inline `code`, **bold**, #/##/### headings, and "- " list items.
 * Everything else is a plain paragraph.
 *
 * Must never throw and must never drop text — a reply the user cannot read
 * is worse than one that renders as a plain paragraph.
 */

export interface Span {
  bold?: boolean;
  code?: boolean;
  text: string;
}

export type Segment =
  | { type: 'code-block'; lang?: string; text: string }
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'heading'; level: number; spans: Span[] }
  | { type: 'list-item'; spans: Span[] };

const FENCE_OPEN = /^\s*```(\S*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM = /^-\s+(.*)$/;

export function renderMarkdown(text: string): Segment[] {
  try {
    return parse(text);
  } catch {
    // Fallback: the raw text, untouched, so nothing is ever lost.
    return [{ type: 'paragraph', spans: [{ text }] }];
  }
}

function parse(text: string): Segment[] {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const lang = fence[1];
      const content: string[] = [];
      i++;
      // Unclosed fence: consume to EOF rather than losing the rest of the text.
      while (i < lines.length && !FENCE_CLOSE.test(lines[i] ?? '')) {
        content.push(lines[i] ?? '');
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence line
      segments.push({ type: 'code-block', text: content.join('\n'), ...(lang ? { lang } : {}) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      segments.push({ type: 'heading', level: (heading[1] ?? '#').length, spans: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      segments.push({ type: 'list-item', spans: parseInline(item[1] ?? '') });
      i++;
      continue;
    }

    if (line.trim().length > 0) {
      segments.push({ type: 'paragraph', spans: parseInline(line) });
    }
    i++;
  }

  return segments;
}

/** Splits a line into spans, applying **bold** first and `code` within each run. */
function parseInline(text: string): Span[] {
  const runs: Array<{ text: string; bold: boolean }> = [];
  const boldRe = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = boldRe.exec(text)) !== null) {
    if (match.index > lastIndex) runs.push({ text: text.slice(lastIndex, match.index), bold: false });
    runs.push({ text: match[1] ?? '', bold: true });
    lastIndex = boldRe.lastIndex;
  }
  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex), bold: false });
  if (runs.length === 0) runs.push({ text, bold: false });

  const spans: Span[] = [];
  for (const run of runs) spans.push(...parseCode(run.text, run.bold));
  return spans;
}

function parseCode(text: string, bold: boolean): Span[] {
  const codeRe = /`([^`]+)`/g;
  const spans: Span[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = codeRe.exec(text)) !== null) {
    found = true;
    if (match.index > lastIndex) spans.push(mkSpan(text.slice(lastIndex, match.index), bold, false));
    spans.push(mkSpan(match[1] ?? '', bold, true));
    lastIndex = codeRe.lastIndex;
  }
  if (!found) {
    if (text) spans.push(mkSpan(text, bold, false));
    return spans;
  }
  if (lastIndex < text.length) spans.push(mkSpan(text.slice(lastIndex), bold, false));
  return spans;
}

function mkSpan(text: string, bold: boolean, code: boolean): Span {
  const span: Span = { text };
  if (bold) span.bold = true;
  if (code) span.code = true;
  return span;
}
