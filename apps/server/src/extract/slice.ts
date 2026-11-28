/**
 * Reading long content a piece at a time (an agent's context is finite):
 * slices that never split a surrogate pair, and the Markdown's headings with
 * where each starts, to jump to one.
 */

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * `text` from `offset`, at most `maxChars` long (UTF-16 code units), moved
 * so that neither end cuts a character in two.
 */
export function sliceText(
  text: string,
  offset: number,
  maxChars: number,
): { text: string; offset: number; end: number } {
  let start = Math.min(offset, text.length);
  if (start > 0 && isHigh(text.charCodeAt(start - 1))) start--;
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length && end > start && isHigh(text.charCodeAt(end - 1))) end--;
  return { text: text.slice(start, end), offset: start, end };
}

/** ATX headings outside fenced code, with the offset of each one's line. */
export function markdownHeadings(md: string): { level: number; text: string; offset: number }[] {
  const out: { level: number; text: string; offset: number }[] = [];
  let fence: string | null = null;
  let pos = 0;
  for (const line of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!.charAt(0);
      else if (f[1]!.charAt(0) === fence) fence = null;
    } else if (fence === null) {
      const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (h?.[2]) out.push({ level: h[1]!.length, text: h[2], offset: pos });
    }
    pos += line.length + 1;
  }
  return out;
}
