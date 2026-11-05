import type { RichNodeJSON } from "nsh/base";

/**
 * The editor document as plain text, with the ProseMirror position of every
 * character, so text-quote anchors (found in plain text) map to the
 * document positions decorations and selections use, and back.
 *
 * Positions follow ProseMirror: the document's content starts at 0; a node
 * with content takes one position to open and one to close; text takes one
 * per character (UTF-16 unit); a leaf node (image, hard break, rule) takes one.
 * Blocks are separated by "\n" in the text; a separator carries the
 * position of the content that follows it.
 */
export interface DocIndex {
  text: string;
  pos: number[];
}

const LEAVES = new Set(["image", "hardBreak", "hard_break", "horizontalRule", "horizontal_rule"]);

export function indexDoc(doc: RichNodeJSON): DocIndex {
  const chars: string[] = [];
  const pos: number[] = [];
  const separate = (p: number) => {
    if (chars.length && chars[chars.length - 1] !== "\n") {
      chars.push("\n");
      pos.push(p);
    }
  };

  /** Indexes `node` starting at position `start`; returns its size. */
  const walk = (node: RichNodeJSON, start: number): number => {
    if (node.type === "text") {
      const t = node.text ?? "";
      for (let i = 0; i < t.length; i++) {
        chars.push(t[i]!);
        pos.push(start + i);
      }
      return t.length;
    }
    if (LEAVES.has(node.type)) {
      if (node.type.startsWith("hard")) {
        chars.push("\n");
        pos.push(start);
      }
      return 1;
    }
    let p = start + 1;
    separate(p);
    for (const child of node.content ?? []) p += walk(child, p);
    return p + 1 - start;
  };

  let p = 0;
  for (const child of doc.content ?? []) p += walk(child, p);
  return { text: chars.join(""), pos };
}

/** First index whose position is >= `p` (binary search). */
function lowerBound(pos: number[], p: number): number {
  let lo = 0;
  let hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid]! < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Document range `[from, to)` → text range. */
export const toTextRange = (idx: DocIndex, from: number, to: number) => ({
  start: lowerBound(idx.pos, from),
  end: lowerBound(idx.pos, to),
});

/** Text range → document range. */
export const toDocRange = (idx: DocIndex, start: number, end: number) => ({
  from: idx.pos[start]!,
  to: idx.pos[end - 1]! + 1,
});
