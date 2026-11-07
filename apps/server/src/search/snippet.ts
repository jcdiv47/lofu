/**
 * Query-highlighted excerpts, built here instead of by Meilisearch: asking
 * Meilisearch to crop/highlight (or even to report match positions) makes it
 * re-tokenize every hit's full article text, which cut search throughput
 * ~60x in benchmarks (≈35k → ≈620 req/s). A regex over the stored text is
 * far cheaper. Trade-off: typo-tolerant matches aren't highlighted.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CJK_CHARS = "぀-ヿ㐀-鿿가-힯";
const CJK = new RegExp(`[${CJK_CHARS}]`);
/**
 * Holds at a word start: not right after a letter, digit or underscore of a
 * spaced script. A CJK character before doesn't count, since CJK text has no
 * spaces ("用React开发" holds the word "React").
 */
const WORD_START = `(?<![\\p{L}\\p{N}\\p{M}_](?<![${CJK_CHARS}]))`;
/** Terms that begin like a word of a spaced script get matched at word starts only. */
const startsWord = (t: string) => /^[\p{L}\p{N}_]/u.test(t) && !CJK.test(t.charAt(0));

/**
 * Builds a matcher for the query's terms, or null if there is nothing to
 * match. A term matches at a word start ("learn" marks "Learning", "in" not
 * "Machine"); a term in CJK, which has no spaces, matches anywhere.
 */
export function queryMatcher(q: string): RegExp | null {
  const terms = q
    .split(/[\s"'“”‘’(),;:!?]+/u)
    .filter((t) => t.length >= 2 || CJK.test(t))
    .sort((a, b) => b.length - a.length) // prefer the longest alternative
    .map((t) => (startsWord(t) ? WORD_START : "") + escapeRe(t));
  return terms.length ? new RegExp(terms.join("|"), "giu") : null;
}

/** ~`width` chars around the first match, matches wrapped in <mark>, HTML-escaped. */
export function makeSnippet(text: string, re: RegExp, width = 220): string | null {
  re.lastIndex = 0;
  const first = re.exec(text);
  if (!first) return null;

  let start = Math.max(0, first.index - Math.floor(width / 3));
  let end = Math.min(text.length, start + width);
  // Snap to whitespace so words aren't cut (no-op for CJK, which has none).
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp !== -1 && sp < first.index) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(" ", end);
    if (sp > first.index + first[0].length) end = sp;
  }

  const slice = text.slice(start, end);
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(slice); m; m = re.exec(slice)) {
    out += `${escapeHtml(slice.slice(last, m.index))}<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(slice.slice(last));
  out = out.replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${out}${end < text.length ? "…" : ""}`;
}
