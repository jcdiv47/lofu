import { createRichEditor, type RichNodeJSON, StarterKit, TableKit } from "nsh/base";
import { expect, test } from "nsh/test";
import { indexDoc } from "./lib/docIndex";
import { isFootnoteNumber, numberFootnotes, raiseFootnotes } from "./lib/footnotes";
import { mathMarks, pictureKey, protectMath, type Run, typeset, typesetMath } from "./lib/math";
import { placeImages } from "./screens/Reader";

/** The document as the reader makes it. */
const doc = (markdown: string, pictures?: Parameters<typeof typesetMath>[2]) => {
  const math = protectMath(markdown);
  const parsed = createRichEditor({
    content: numberFootnotes(math.markdown),
    format: "markdown",
    extensions: [StarterKit, TableKit, ...mathMarks],
  }).getJSON();
  return raiseFootnotes(typesetMath(parsed, math.formulas, pictures));
};

/** Runs with their marks: [x|italic]. */
const show = (runs: Run[]) =>
  runs.map((r) => (r.marks.length ? `[${r.text}|${r.marks.join(",")}]` : r.text)).join("");
const tex = (s: string, display = false) => show(typeset(s, display));
const text = (n: RichNodeJSON) => indexDoc(n, isFootnoteNumber).text;

test("formulas are taken out of the Markdown; money, code and escaped dollars stay", () => {
  const { markdown, formulas } = protectMath(
    [
      "A chunk $A$ reads $x_t$, costs $5 to $10, and `$HOME` or \\$x$ stays.",
      "",
      "$$",
      "y = \\sum_{i} x_i",
      "$$",
      "",
      "```",
      "$not_math$",
      "```",
      "> $$E = mc^2$$",
    ].join("\n"),
  );
  expect(formulas.map((f) => f.tex)).toEqual(["A", "x_t", "y = \\sum_{i} x_i", "E = mc^2"]);
  expect(formulas.map((f) => f.display)).toEqual([false, false, true, true]);
  expect(markdown).toContain("costs $5 to $10, and `$HOME` or \\$x$ stays.");
  expect(markdown).toContain("$not_math$");
  expect(protectMath("No formulas here.").markdown).toBe("No formulas here.");
});

test("TeX is set as text: italic variables, symbols, Unicode scripts", () => {
  expect(tex("h_{t-1}")).toBe("[h|italic]ₜ₋₁");
  expect(tex("\\tilde{C}_t")).toBe("[C̃|italic]ₜ");
  expect(tex("r_n \\geq r_{n-1} \\geq \\dots \\geq r_1")).toBe(
    "[r|italic]ₙ ≥ [r|italic]ₙ₋₁ ≥ … ≥ [r|italic]₁",
  );
  expect(tex("-1")).toBe("−1");
  expect(tex("a - b")).toBe("[a|italic] − [b|italic]");
  expect(tex("\\langle q, x_i \\rangle")).toBe("⟨[q|italic], [x|italic]ᵢ⟩");
  expect(tex("y = \\sum_{i = 1}^{n} G \\left(\\right. x \\left.\\right)_{i}")).toBe(
    "[y|italic] = ∑ᵢ₌₁ⁿ [G|italic]([x|italic])ᵢ",
  );
  expect(tex("\\log \\pi(x)")).toBe("log [π|italic]([x|italic])");
  expect(tex("\\frac{a+b}{2}")).toBe("([a|italic] + [b|italic])/2");
  expect(tex("\\tfrac12\\|Sk_t - v_t\\|^2")).toBe("1/2‖[Sk|italic]ₜ − [v|italic]ₜ‖²");
  expect(tex("\\sqrt{x^2+y^2}")).toBe("√([x|italic]² + [y|italic]²)");
  expect(tex("\\mathbb{E}[X] \\in \\mathbb{R}")).toBe("𝔼[[X|italic]] ∈ ℝ");
  expect(tex("f'(x) \\neq 0")).toBe("[f|italic]′([x|italic]) ≠ 0");
  expect(tex("W^\\top x")).toBe("[W|italic]ᵀ[x|italic]");
  expect(tex("\\text{Expert Capacity} = k")).toBe("Expert Capacity = [k|italic]");
  expect(tex("\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}")).toBe(
    "([a|italic] [b|italic]; [c|italic] [d|italic])",
  );
});

test("scripts Unicode has no characters for are smaller text", () => {
  expect(tex("\\pi_\\text{teacher}")).toBe("[π|italic][teacher|mathSub]");
  expect(tex("W_{g}")).toBe("[W|italic][g|italic,mathSub]");
  expect(tex("\\mathbb{R}^{n \\times d}")).toBe("ℝ[n|italic,mathSup][×|mathSup][d|italic,mathSup]");
});

test("cases and aligned equations are a row a line when displayed", () => {
  const cases =
    "f(x) = \\begin{cases} x & \\text{if } x > 0, \\\\ -x & \\text{otherwise}. \\end{cases}";
  expect(tex(cases, true)).toBe(
    "[f|italic]([x|italic]) = {[x|italic] if [x|italic] > 0,\n−[x|italic] otherwise.",
  );
  expect(tex("\\begin{aligned} a &= b \\\\ &= c \\end{aligned}")).toBe(
    "[a|italic] = [b|italic]; = [c|italic]",
  );
});

test("TeX it can't read doesn't throw", () => {
  for (const s of ["\\frac{a", "x^", "}{", "\\left(", "\\begin{cases} a &", "\\"]) {
    expect(typeof tex(s)).toBe("string");
  }
});

test("in the article: no stray emphasis, a display formula centred, footnotes still numbered", () => {
  const d = doc(
    [
      "Gate $f_t$ with $a*b$ and $c*d$ in it.[^1]",
      "",
      "$$",
      "h_t = o_t * \\tanh(C_t)",
      "$$",
      "",
      "[^1]: See $x^2$.",
    ].join("\n"),
  );
  expect(text(d)).toBe("Gate fₜ with a ∗ b and c ∗ d in it.\nhₜ = oₜ ∗ tanh(Cₜ)\nSee x².");
  const [first, display] = d.content!;
  // `*` in formulas isn't emphasis; the variables are in italics.
  expect(first!.content!.some((n) => n.marks?.some((m) => m.type === "bold"))).toBe(false);
  expect(first!.content!.find((n) => n.text === "f")?.marks).toEqual([{ type: "italic" }]);
  expect(display!.attrs?.textAlign).toBe("center");
  // The footnote's number is still raised.
  expect(first!.content!.some((n) => isFootnoteNumber(n) && n.text === "1")).toBe(true);
});

test("a formula keeps the marks of the text it's in, and works in a table", () => {
  const d = doc("**Bold $x_i$ text**\n\n| a | b |\n|---|---|\n| $\\alpha$ | 2 |");
  const bold = d.content![0]!.content!.find((n) => n.text === "x");
  expect(bold?.marks?.map((m) => m.type)).toEqual(["bold", "italic"]);
  expect(text(d)).toContain("α");
});

test("a display formula with a picture is the picture, sized to the text; others stay text", () => {
  const src = "https://lofu.test/math/sig?t=E&c=1f1b16";
  const d = doc(
    "Inline $E$ here, and:\n\n$$\nE = mc^2\n$$\n\n![photo](https://x.test/p.jpg)\n\n$$\nF = ma\n$$",
    new Map([[pictureKey("E = mc^2", true), { src, width: 900, height: 40 }]]),
  );
  const [inline, pictured, , unpictured] = d.content!;
  expect(text({ type: "doc", content: [inline!] })).toBe("Inline E here, and:");
  expect(pictured!.attrs?.textAlign).toBe("center");
  expect(pictured!.content).toEqual([
    { type: "image", attrs: { src, alt: "E = mc^2", title: "formula-0", width: 900, height: 40 } },
  ]);
  expect(text({ type: "doc", content: [unpictured!] })).toBe("F = ma");
  // Sized down to the text; the article's picture still found by position.
  const placed = placeImages(
    d,
    [{ src: "https://x.test/other.jpg", width: 100, height: 50, proxy: "https://lofu.test/img/p" }],
    600,
    [{ src, width: 900, height: 40, proxy: "file:///kept/formula.svg" }],
  );
  const images: Record<string, unknown>[] = [];
  const walk = (n: RichNodeJSON) => {
    if (n.type === "image") images.push(n.attrs ?? {});
    n.content?.forEach(walk);
  };
  walk(placed);
  expect(images.map(({ src, width, height }) => ({ src, width, height }))).toEqual([
    { src: "file:///kept/formula.svg", width: 600, height: 27 },
    { src: "https://lofu.test/img/p", width: 100, height: 50 },
  ]);
});

test("a base's subscript and superscript are set alike, never one raised and one on the line", () => {
  expect(tex("x_i^2")).toBe("[x|italic]ᵢ²");
  expect(tex("w^I_{t,j}")).toBe(
    "[w|italic][I|italic,mathSup][t|italic,mathSub][,|mathSub][j|italic,mathSub]",
  );
  // Unicode's ⱼ and capital ᴵ look wrong in the fallback fonts: smaller text instead.
  expect(tex("\\sum_j w")).toBe("∑[j|italic,mathSub] [w|italic]");
  expect(tex("k^I_s")).toBe("[k|italic][I|italic,mathSup][s|italic,mathSub]");
});

test("every formula in text with a picture is its picture; without one it is set as text", () => {
  const sum = "https://lofu.test/math/s?t=sum&i=1&c=1f1b16";
  const xt = "https://lofu.test/math/x?t=xt&i=1&c=1f1b16";
  const d = doc(
    "Score $I_{t,s}=\\sum_j w^I_{t,j}$ per token, $x_t$ too, and $y_t$ has none.",
    new Map([
      [
        pictureKey("I_{t,s}=\\sum_j w^I_{t,j}", false),
        { src: sum, width: 120, height: 26, depth: 8 },
      ],
      [pictureKey("x_t", false), { src: xt, width: 14, height: 14 }],
    ]),
  );
  const images = d.content![0]!.content!.filter((n) => n.type === "image");
  expect(images.map((n) => [n.attrs?.src, n.attrs?.title])).toEqual([
    [sum, "formula-8"],
    [xt, "formula-0"],
  ]);
  expect(text(d)).toBe("Score  per token,  too, and yₜ has none.");
});
