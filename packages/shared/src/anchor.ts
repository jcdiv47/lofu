/**
 * Highlight anchoring with W3C Web Annotation TextQuoteSelectors
 * (exact text + a little context on each side) instead of offsets.
 *
 * Clients render articles differently (Markdown in a native editor, HTML in
 * a browser, plain text on the server), so the same passage sits at different
 * offsets and with different whitespace everywhere. Matching on the quoted
 * text with whitespace collapsed, and choosing between repeats by how much
 * of the surrounding context agrees, finds it in all of them.
 *
 * Dependency-free: imported by the server, the browser extension and the
 * nsh apps alike.
 */

export interface TextQuote {
  quote: string;
  prefix: string;
  suffix: string;
}

/** Context kept on each side of a quote. */
export const CONTEXT_CHARS = 32;

interface Normalized {
  text: string;
  /** For each char of `text`, its index in the original string. */
  map: number[];
}

const isSpace = (c: string) => /\s/u.test(c);

/** Collapses every whitespace run to one space (and trims), remembering original indices. */
function normalize(s: string): Normalized {
  let text = "";
  const map: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (isSpace(c)) {
      if (pendingSpace < 0 && text.length > 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      text += " ";
      map.push(pendingSpace);
      pendingSpace = -1;
    }
    text += c;
    map.push(i);
  }
  return { text, map };
}

const collapse = (s: string) => normalize(s).text;

/** The selector for `text.slice(start, end)`, with up to `context` chars around it. */
export function quoteAt(
  text: string,
  start: number,
  end: number,
  context = CONTEXT_CHARS,
): TextQuote {
  return {
    quote: collapse(text.slice(start, end)),
    prefix: collapse(text.slice(Math.max(0, start - context * 2), start)).slice(-context),
    suffix: collapse(text.slice(end, end + context * 2)).slice(0, context),
  };
}

/** Length of the common suffix of `a` and `b`. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of `a` and `b`. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Finds `q` in `text`: the `[start, end)` range in the original string, or
 * null when the quoted text no longer appears (the article changed).
 * Among several occurrences, the one whose surroundings best match the
 * prefix and suffix wins; with no context (e.g. imported highlights), the
 * first.
 */
export function findQuote(text: string, q: TextQuote): { start: number; end: number } | null {
  const quote = collapse(q.quote);
  if (!quote) return null;
  const norm = normalize(text);
  const prefix = collapse(q.prefix);
  const suffix = collapse(q.suffix);

  let best = -1;
  let bestScore = -1;
  for (let at = norm.text.indexOf(quote); at !== -1; at = norm.text.indexOf(quote, at + 1)) {
    const before = norm.text.slice(Math.max(0, at - prefix.length - 1), at).trimEnd();
    const after = norm.text
      .slice(at + quote.length, at + quote.length + suffix.length + 1)
      .trimStart();
    const score = commonSuffix(before, prefix.trimEnd()) + commonPrefix(after, suffix.trimStart());
    if (score > bestScore) {
      best = at;
      bestScore = score;
      if (score === prefix.trim().length + suffix.trim().length) break; // perfect
    }
  }
  if (best < 0) return null;
  return { start: norm.map[best]!, end: norm.map[best + quote.length - 1]! + 1 };
}
