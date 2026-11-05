import { describe, expect, test } from "bun:test";
import { findQuote, quoteAt } from "../src/anchor.ts";

const article = `# Sourdough

Bakers measure hydration carefully.

Bakers measure hydration carefully, because flour absorbs water at different rates.

Fermentation curves matter more than anything.`;

describe("anchoring", () => {
  test("round-trips a selection", () => {
    const start = article.indexOf("flour absorbs");
    const q = quoteAt(article, start, start + "flour absorbs water".length);
    expect(q.quote).toBe("flour absorbs water");
    expect(findQuote(article, q)).toEqual({ start, end: start + "flour absorbs water".length });
  });

  test("context picks the right one of several repeats", () => {
    const second = article.indexOf("Bakers measure hydration carefully,");
    const q = quoteAt(article, second, second + "Bakers measure hydration".length);
    expect(findQuote(article, q)?.start).toBe(second);
    const first = article.indexOf("Bakers measure");
    expect(findQuote(article, { ...q, prefix: "", suffix: "" })?.start).toBe(first);
  });

  test("survives different whitespace and block separators across renderers", () => {
    // Selected in an editor whose blocks are joined by a single newline…
    const editorText = article.replace(/\n\n/g, "\n");
    const s = editorText.indexOf("rates.");
    const q = quoteAt(editorText, s, s + "rates.\nFermentation curves".length);
    // …found in the server's text, where blocks are separated by blank lines.
    const hit = findQuote(article, q);
    expect(hit && article.slice(hit.start, hit.end)).toBe("rates.\n\nFermentation curves");
  });

  test("CJK text and missing quotes", () => {
    const zh = "组件尽量写成纯函数，如果需要外部功能和副作用，就用钩子把外部代码钩进来。";
    const s = zh.indexOf("副作用");
    expect(findQuote(zh, quoteAt(zh, s, s + 3))).toEqual({ start: s, end: s + 3 });
    expect(findQuote(zh, { quote: "不存在", prefix: "", suffix: "" })).toBeNull();
    expect(findQuote(zh, { quote: "  ", prefix: "", suffix: "" })).toBeNull();
  });
});
