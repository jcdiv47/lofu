import { describe, expect, test } from "bun:test";
import { pictureFormulas } from "@lofu/shared";
import { formulaSvg } from "../src/extract/mathSvg.ts";
import { setupServer } from "./harness.ts";

describe("formulas drawn as pictures", () => {
  test("TeX becomes an SVG sized for 18-pixel text; TeX MathJax can't read doesn't", () => {
    const d = formulaSvg("I_{t,s}=\\sum_j w^I_{t,j}\\,\\mathrm{ReLU}(q^I_{t,j}\\cdot k^I_s)");
    expect(d).not.toBeNull();
    expect(d!.svg).toStartWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${d!.width}"`);
    expect(d!.svg).toContain('fill="currentColor"');
    expect(d!.width).toBeGreaterThan(150);
    expect(d!.height).toBeGreaterThan(18);
    expect(formulaSvg("\\notacommand{x}")).toBeNull();
    expect(formulaSvg("\\frac{a")).toBeNull();
    expect(formulaSvg("")).toBeNull();
  });

  test("an inline formula is drawn with its depth below the baseline, smaller than displayed", () => {
    const inline = formulaSvg("\\sum_j w^I_{t,j}", false)!;
    const display = formulaSvg("\\sum_j w^I_{t,j}", true)!;
    expect(inline.depth).toBeGreaterThan(0);
    expect(inline.height).toBeLessThan(display.height);
    expect(formulaSvg("x", false)!.depth).toBe(0);
  });

  test("every formula is listed, each once in each style; code is left alone", () => {
    const md = [
      "Inline $x$, $x$ again and $\\frac{a}{b}$; $E = mc^2$ in text too.",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "```",
      "$$",
      "not = math",
      "$$",
      "```",
      "",
      "$$E = mc^2$$",
    ].join("\n");
    expect(pictureFormulas(md)).toEqual([
      { tex: "x", display: false },
      { tex: "\\frac{a}{b}", display: false },
      { tex: "E = mc^2", display: false },
      { tex: "E = mc^2", display: true },
    ]);
  });

  const { sys, api } = setupServer();

  test("the article lists its formulas; their signed pictures come in the color asked for", async () => {
    const r = await api("POST", "/v1/bookmarks", {
      url: "https://unreachable.invalid/math",
      html: `<html><head><title>Math</title></head><body><article>
        <p>The mixture of experts sums what each expert says, weighted by the gate, for every token of the input.</p>
        <math display="block" data-latex="y = \\sum_{i=1}^{n} G(x)_i E_i(x)"><mi>y</mi></math>
        <p>A formula MathJax can't read is left as TeX for the reader to show as text.</p>
        <math display="block" data-latex="\\notacommand{x}"><mi>x</mi></math>
        <p>And the article goes on for a while longer, so that it is long enough to count as one.</p>
      </article></body></html>`,
    });
    await sys.runner.idle();
    const b = await api("GET", `/v1/bookmarks/${r.data.id}?content=markdown`);
    expect(b.data.content).toContain("$$\ny = \\sum_{i=1}^{n} G(x)_i E_i(x)\n$$");
    expect(b.data.formulas).toHaveLength(1);
    const [f] = b.data.formulas;
    expect(f.tex).toBe("y = \\sum_{i=1}^{n} G(x)_i E_i(x)");
    expect(f.src).toStartWith("/math/");
    expect(f.display).toBe(true);
    expect(f.depth).toBeGreaterThan(0);
    // The inline style is signed apart: a display signature doesn't serve it.
    expect((await api("GET", `${f.src}&i=1`)).status).toBe(403);

    const pic = await api("GET", `${f.src}&c=ece4d6`);
    expect(pic.status).toBe(200);
    expect(pic.res.headers.get("content-type")).toBe("image/svg+xml");
    expect(pic.res.headers.get("content-security-policy")).toContain("sandbox");
    expect(pic.data).toContain('fill="#ece4d6"');
    expect(pic.data).not.toContain("currentColor");

    expect((await api("GET", `${f.src}&c=red;x`)).status).toBe(400);
    const forged = f.src.replace(/t=[^&]+/, `t=${encodeURIComponent("\\frac{1}{0}")}`);
    expect((await api("GET", forged)).status).toBe(403);
    // Other formats have no formulas.
    expect((await api("GET", `/v1/bookmarks/${r.data.id}?content=text`)).data.formulas).toBeNull();
  });
});
