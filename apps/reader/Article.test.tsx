import { createRichEditor, type RichNodeJSON, StarterKit, TableKit } from "nsh/base";
import { expect, test } from "nsh/test";
import { findQuote, quoteAt } from "../../packages/shared/src/anchor";
import { indexDoc } from "./lib/docIndex";
import { isFootnoteNumber, numberFootnotes, raiseFootnotes } from "./lib/footnotes";
import { compactCells } from "./screens/Reader";

/** The document as the reader makes it. */
const doc = (markdown: string) =>
  compactCells(
    raiseFootnotes(
      createRichEditor({
        content: numberFootnotes(markdown),
        format: "markdown",
        extensions: [StarterKit, TableKit],
      }).getJSON(),
    ),
  );

/** Text with superscript as ^n. */
const show = (n: RichNodeJSON): string =>
  n.type === "text"
    ? isFootnoteNumber(n)
      ? `^${n.text}`
      : (n.text ?? "")
    : (n.content ?? []).map(show).join(n.type === "doc" ? "\n" : "");

const article = [
  "Claim[^b] and another[^a], again[^b]; `code [^a]` and a dangling[^zz].",
  "",
  "```",
  "[^a]: not a note",
  "```",
  "",
  "[^a]: Note A with a [link](https://a.example).",
  "",
  "[^b]: Note B.",
  "",
  "[^c]: Never cited.",
].join("\n");

test("footnote references are numbered in order of use, and raised", () => {
  const d = doc(article);
  expect(show(d.content![0]!)).toBe("Claim^1 and another^2, again^1; code [^a] and a dangling^zz.");
  // The definitions: an ordered list in the references' order, after a rule.
  const list = d.content!.find((n) => n.type === "orderedList")!;
  expect(list.content!.map(show)).toEqual(["Note B.", "Note A with a link.", "Never cited."]);
  expect(d.content!.some((n) => n.type === "horizontalRule")).toBe(true);
  expect(show(d)).toContain("[^a]: not a note"); // code stays code
});

test("highlights are anchored without footnote numbers", () => {
  const d = doc(article);
  const idx = indexDoc(d, isFootnoteNumber);
  expect(idx.text.startsWith("Claim and another, again;")).toBe(true);
  // A quote made before footnotes showed (or by another reader) still matches.
  const old = quoteAt("Claim and another, again; x", 0, 17);
  expect(old.quote).toBe("Claim and another");
  const hit = findQuote(idx.text, old)!;
  expect(idx.text.slice(hit.start, hit.end)).toBe("Claim and another");
});

test("tables are tables, their paragraphs marked as cell text", () => {
  const d = doc("| Model | Pass@1 |\n| --- | --- |\n| **A** | 0.9 |\n\nAfter.");
  const table = d.content![0]!;
  expect(table.type).toBe("table");
  const [head, row] = table.content!;
  expect(head!.content!.map((c) => c.type)).toEqual(["tableHeader", "tableHeader"]);
  expect(row!.content!.map(show)).toEqual(["A", "0.9"]);
  expect(row!.content![0]!.content![0]!.attrs?.textAlign).toBe("left");
  // Paragraphs outside tables are left as they are.
  expect(d.content![1]!.attrs?.textAlign ?? null).toBeNull();
});

test("notes go under the page's own empty notes heading", () => {
  const d = doc("Text[^1].\n\n## References\n\n## Citation\n\nCite us.\n\n[^1]: The source.");
  expect(d.content!.map((n) => n.type)).toEqual([
    "paragraph",
    "heading",
    "orderedList",
    "heading",
    "paragraph",
  ]);
  // A notes heading with content of its own is left alone.
  const kept = doc("Text[^1].\n\n## Notes\n\nSome notes.\n\n[^1]: The source.");
  expect(kept.content!.map((n) => n.type)).toEqual([
    "paragraph",
    "heading",
    "paragraph",
    "horizontalRule",
    "orderedList",
  ]);
});

test("an article without footnotes is unchanged", () => {
  expect(numberFootnotes("Plain [text] and ^caret.")).toBe("Plain [text] and ^caret.");
});
