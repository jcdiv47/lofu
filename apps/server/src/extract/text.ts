// Markdown's backslash escapes (`\[`, `\_`) are set aside as private-use
// characters while the syntax is stripped, then put back as the literal
// characters they stand for.
const ESCAPABLE = "\\`*_{}[]()#+-.!|<>";
const PRIVATE = 0xe000;
const hide = (md: string) =>
  md.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, (_, c: string) =>
    String.fromCharCode(PRIVATE + ESCAPABLE.indexOf(c)),
  );
const restore = (s: string) =>
  s.replace(/[\uE000-\uE012]/g, (c) => ESCAPABLE[c.charCodeAt(0) - PRIVATE] ?? "");

/** Cheap markdown → plain text for the search index and excerpts (not for display). */
export function markdownToText(md: string): string {
  return restore(
    hide(md)
      .replace(/```[^\n]*\n/g, "\n")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/[*_~`]+/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}
