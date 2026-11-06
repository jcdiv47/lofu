import type { RichNodeJSON } from "nsh/base";

/**
 * GitHub footnotes (`[^1]` and `[^1]: …`, as the server's Markdown has them).
 * The editor's parser reads them but has no nodes for them: it drops each
 * reference and keeps a definition as a plain paragraph. So, before parsing,
 * references become numbers (in order of first use) between private-use
 * sentinels, and the definitions an ordered list in that order at the end;
 * after parsing, `raiseFootnotes` makes the numbers superscript.
 *
 * The numbers are not part of the text highlights are anchored in
 * (`isFootnoteNumber`, for `indexDoc`): quotes stay what the other readers
 * see, and a highlight across a reference still matches.
 */

const OPEN = "\uE000";
const CLOSE = "\uE001";
const REF = /(`+)[^`]*?\1|\[\^([^\]\s]+)\]/g;
const DEF = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A section the page kept its notes in, which the extraction left empty. */
const NOTES_HEADING = /^#{1,6}\s+(references|notes|footnotes|endnotes|参考文献|参考资料|注释)\s*$/i;

export function numberFootnotes(markdown: string): string {
  if (!markdown.includes("[^")) return markdown;
  const lines = markdown.split("\n");
  const defs = new Map<string, string[]>();
  const body: string[] = [];
  let listAt = -1;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      body.push(line);
      continue;
    }
    if (f) {
      fence = f;
      body.push(line);
      continue;
    }
    const def = DEF.exec(line);
    if (!def) {
      body.push(line);
      continue;
    }
    // A definition, and the indented lines (and blank lines between them) that continue it.
    const text = [def[2]!];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      const after = lines[i + 2] ?? "";
      if (/^( {4}|\t)/.test(next)) text.push(next.replace(/^( {4}|\t)/, ""));
      else if (!next.trim() && /^( {4}|\t)\S/.test(after)) text.push("");
      else break;
      i++;
    }
    if (!defs.has(def[1]!)) defs.set(def[1]!, text);
    if (listAt < 0) listAt = body.length;
  }

  const numbers = new Map<string, number>();
  const number = (id: string) => {
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    return numbers.get(id)!;
  };
  fence = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i]!;
    const f = FENCE.exec(line)?.[1];
    if (fence || f) {
      if (!fence) fence = f!;
      else if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    body[i] = line.replace(REF, (m, code: string | undefined, id: string | undefined) =>
      code || !id ? m : `${OPEN}${defs.has(id) ? number(id) : id}${CLOSE}`,
    );
  }
  if (defs.size === 0) return body.join("\n");

  for (const id of defs.keys()) number(id); // notes no text refers to come last
  const items = [...defs]
    .sort(([a], [b]) => numbers.get(a)! - numbers.get(b)!)
    .map(([id, text]) => {
      const marker = `${numbers.get(id)}. `;
      const indent = " ".repeat(marker.length);
      return marker + text.map((t, k) => (k === 0 || !t ? t : indent + t)).join("\n");
    });
  // Under the page's own (empty) notes heading, else after a rule where the definitions were.
  const heading = body.findIndex((l, i) => {
    if (!NOTES_HEADING.test(l)) return false;
    // Empty: nothing before the next heading, or before where the definitions were.
    const next = body.slice(i + 1).findIndex((x) => x.trim().length > 0);
    return next < 0 || body[i + 1 + next]!.startsWith("#") || i + 1 + next >= listAt;
  });
  if (heading >= 0) body.splice(heading + 1, 0, "", ...items, "");
  else body.splice(listAt, 0, "", "---", "", ...items, "");
  return body.join("\n");
}

const NUMBERED = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`);

/** Makes the numbers `numberFootnotes` marked superscript (and drops the sentinels). */
export function raiseFootnotes(doc: RichNodeJSON): RichNodeJSON {
  const walk = (n: RichNodeJSON): RichNodeJSON => {
    if (!n.content) return n;
    const content: RichNodeJSON[] = [];
    for (const c of n.content) {
      if (c.type !== "text" || !c.text?.includes(OPEN)) {
        content.push(walk(c));
        continue;
      }
      const parts = c.text.split(NUMBERED); // text, number, text, number, ..., text
      parts.forEach((t, k) => {
        if (!t) return;
        const marks = k % 2 ? [...(c.marks ?? []), { type: "superscript" }] : c.marks;
        content.push(marks?.length ? { ...c, text: t, marks } : { type: "text", text: t });
      });
    }
    return { ...n, content };
  };
  return walk(doc);
}

/** A footnote number (superscript appears nowhere else: the server turns `<sup>` into text). */
export const isFootnoteNumber = (n: RichNodeJSON) =>
  n.type === "text" && (n.marks ?? []).some((m) => m.type === "superscript");
