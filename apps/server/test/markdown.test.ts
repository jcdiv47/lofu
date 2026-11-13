import { describe, expect, test } from "bun:test";
import { articleMarkdown, MARKDOWN_VERSION, PLAIN_EXTRACTORS } from "../src/extract/markdown.ts";
import { setupServer } from "./harness.ts";

const md = (html: string) => articleMarkdown(html, "https://example.com/post");

describe("articleMarkdown: what Markdown can't express doesn't come out as raw HTML", () => {
  test("a diagram becomes its accessible name, once per copy; an icon goes", () => {
    const diagram = (w: number) =>
      `<svg viewBox="0 0 ${w} 400" role="img" aria-label="Diagram of the pipeline"><rect x="0"></rect><text>Task pool</text></svg>`;
    expect(
      md(`<ul><li>Last point.</li></ul><figure>${diagram(800)} ${diagram(360)}</figure>`),
    ).toBe("- Last point.\n\n*Diagram of the pipeline*");
    expect(md(`<p>Star <svg aria-hidden="true"><path d="M0 0"></path></svg> it</p>`)).toBe(
      "Star it",
    );
    expect(md(`<p>A <svg><title>tiny chart</title><path d="M0"></path></svg> inline.</p>`)).toBe(
      "A *tiny chart* inline.",
    );
  });

  test("a MathJax formula becomes its text", () => {
    const g = (node: string, inner: string) => `<g data-mml-node="${node}">${inner}</g>`;
    const glyph = (c: string) => `<path data-c="${c.codePointAt(0)!.toString(16)}"></path>`;
    const mi = (s: string) => g("mi", [...s].map(glyph).join(""));
    const formula = `<svg role="img" aria-hidden="true">${g(
      "math",
      g("msub", mi("𝑥") + g("TeXAtom", mi("max"))) +
        g("mo", glyph("=")) +
        g("mfrac", g("mrow", mi("a") + g("mo", glyph("−")) + mi("b")) + mi("σ")) +
        g("msup", mi("y") + g("mo", glyph("∗"))),
    )}</svg>`;
    expect(md(`<p>式中， ${formula} 是最大值</p>`)).toBe("式中， xₘₐₓ = (a − b)/σy∗ 是最大值");
  });

  test("KaTeX and MathML stay TeX; a caption taken for a formula becomes text", () => {
    expect(md('<p>Input <math data-latex="x_t"><mi>x</mi></math> at each step.</p>')).toBe(
      "Input $x_t$ at each step.",
    );
    const caption =
      "A SumTree representing &quot;Hello World!\\nThis is&quot; with some fields left out";
    expect(
      md(`<p>Like this:</p><math data-latex="${caption}" display="block"><mi>A</mi></math>`),
    ).toBe(
      'Like this:\n\n*A SumTree representing "Hello World! This is" with some fields left out*',
    );
  });

  test("sup and sub become raised and lowered characters, else plain text", () => {
    expect(md("<p>E = mc<sup>2</sup>, H<sub>2</sub>O, the 1<sup>st</sup> one</p>")).toBe(
      "E = mc², H₂O, the 1st one",
    );
    expect(md(`<p>Jesse Cai<sup>†</sup> and <sup><a href="#note-3">3</a></sup></p>`)).toBe(
      "Jesse Cai† and ³",
    );
    expect(md(`<p>See<sup><a href="https://ex.com/ref">[12]</a></sup></p>`)).toBe(
      "See[\\[12\\]](https://ex.com/ref)",
    );
    // Defuddle's own footnotes are left to it.
    expect(
      md(
        `<p>Claim<sup id="fnref:1"><a href="#fn:1">1</a></sup></p><div id="footnotes"><ol><li id="fn:1"><p>Source.</p></li></ol></div>`,
      ),
    ).toStartWith("Claim[^1]");
  });

  test("players become links to what they play", () => {
    expect(
      md(
        `<p>Watch:</p><iframe src="//player.bilibili.com/player.html?bvid=BV1&amp;page=1" title="iframe embed"></iframe>`,
      ),
    ).toBe(
      "Watch:\n\n[player.bilibili.com](https://player.bilibili.com/player.html?bvid=BV1&page=1)",
    );
    expect(
      md(`<video controls><source src="/demo.mp4" type="video/mp4">Your browser…</video>`),
    ).toBe("[Video](https://example.com/demo.mp4)");
    expect(md(`<p>x</p><iframe src="javascript:alert(1)"></iframe>`)).toBe("x");
  });

  test("a data table with merged cells becomes a Markdown table", () => {
    const table = `<table><thead><tr><th colSpan="2">Name</th><th>Score</th></tr></thead><tbody>
      <tr><th colspan="3">Reasoning models</th></tr>
      <tr><td rowspan="2">A</td><td><h3>a1</h3></td><td><strong>0.9</strong></td></tr>
      <tr><td>a2</td><td>0.8</td></tr>
      <tr><td colspan="3"><hr></td></tr></tbody></table>`;
    expect(md(table)).toBe(
      [
        "| Name |  | Score |",
        "| --- | --- | --- |",
        "| Reasoning models |  |  |",
        "| A | **a1** | **0.9** |",
        "|  | a2 | 0.8 |",
      ].join("\n"),
    );
  });

  test("a single-column table with merged cells is no raw HTML either", () => {
    expect(
      md(`<table><tr><th colspan="2">Group</th></tr><tr><td colspan="2">Value</td></tr></table>`),
    ).toBe("| Group |  |\n| --- | --- |\n| Value |  |");
  });

  test("a layout table (a forum post) becomes its content", () => {
    const post = `<table><tbody><tr><td rowspan="2"></td><td><p><strong>#301</strong> posted 2024-10-30</p></td></tr>
      <tr><td><blockquote>Quoted question</blockquote><p>The answer.</p></td></tr></tbody></table>`;
    expect(md(post)).toBe("**#301** posted 2024-10-30\n\n> Quoted question\n\nThe answer.");
  });

  test("text that looks like a tag, and code, are left alone", () => {
    expect(md("<p>The &lt;think&gt; token and &lt;sup&gt;x&lt;/sup&gt;</p>")).toBe(
      "The \\<think> token and \\<sup>x\\</sup>",
    );
    expect(md('<pre><code>&lt;svg viewBox="0 0 1 1"&gt;&lt;/svg&gt;</code></pre>')).toBe(
      '```\n<svg viewBox="0 0 1 1"></svg>\n```',
    );
  });
});

describe("saved articles are converted again when the conversion changes", () => {
  const { sys, api, base } = setupServer();
  const zstd = (s: string) => Bun.zstdCompressSync(new TextEncoder().encode(s));
  const dec = new TextDecoder();
  const content = (id: string, col: "markdown" | "text") =>
    dec.decode(Bun.zstdDecompressSync(sys.ctx.bookmarks.contentBlob(id, col)!));

  test("from the saved HTML, bumping seq; plain-text extractions aren't touched", async () => {
    const id = (await api("POST", "/v1/bookmarks", { url: `${base}/article` })).data.id;
    const other = (await api("POST", "/v1/bookmarks", { url: `${base}/article?2` })).data.id;
    await sys.runner.idle();
    const fresh = content(id, "markdown");
    const { db, bookmarks } = sys.ctx;

    // As saved by an older conversion: raw HTML in the Markdown.
    db.query("UPDATE contents SET markdown = ?, text = ? WHERE bookmark_id = ?").run(
      zstd(`${fresh}\n\n<svg aria-label="x"></svg>`),
      zstd("old"),
      id,
    );
    db.query("UPDATE contents SET extractor = 'text', markdown = ? WHERE bookmark_id = ?").run(
      zstd("<b>plain</b>"),
      other,
    );
    db.query("DELETE FROM meta WHERE key = 'markdown_version'").run();
    const seq = bookmarks.get(id).seq;

    bookmarks.queueMarkdownUpgrade(MARKDOWN_VERSION, PLAIN_EXTRACTORS);
    await sys.runner.idle();
    expect(content(id, "markdown")).toBe(fresh);
    expect(content(id, "text")).toContain("sourdough starters");
    expect(bookmarks.get(id).seq).toBeGreaterThan(seq);
    expect(content(other, "markdown")).toBe("<b>plain</b>");

    // Once per version.
    const after = bookmarks.get(id).seq;
    db.query("UPDATE contents SET markdown = ? WHERE bookmark_id = ?").run(zstd("x"), id);
    bookmarks.queueMarkdownUpgrade(MARKDOWN_VERSION, PLAIN_EXTRACTORS);
    await sys.runner.idle();
    expect(content(id, "markdown")).toBe("x");
    expect(bookmarks.get(id).seq).toBe(after);
  });
});
