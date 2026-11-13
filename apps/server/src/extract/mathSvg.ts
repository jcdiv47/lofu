/**
 * A formula's TeX drawn as SVG with MathJax, for readers that can't typeset
 * it (apps/reader's editor has no math node). Pure CPU: runs in the
 * extraction worker (worker.ts), MathJax loaded there on the first formula.
 */
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";

/** The text size the picture's pixels are for: the reader's paragraphs. */
export const FORMULA_FONT_PX = 18;
/** Longer TeX isn't drawn (a page that put a whole table in one formula). */
export const MAX_TEX = 4000;

export interface FormulaSvg {
  /** In `currentColor`, which the server replaces with the color asked for. */
  svg: string;
  width: number;
  height: number;
  /** How far it reaches below the text's baseline, in pixels. */
  depth: number;
}

let engine: {
  adaptor: ReturnType<typeof liteAdaptor>;
  doc: ReturnType<typeof mathjax.document>;
} | null = null;

function load() {
  if (engine) return engine;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  // No glyph cache: every picture stands on its own.
  const doc = mathjax.document("", {
    // An unknown command or a missing brace throws (instead of being drawn in
    // red): the reader then shows the formula as text.
    InputJax: new TeX({
      packages: AllPackages.filter((p) => p !== "noundefined"),
      formatError: (_jax: unknown, err: Error) => {
        throw err;
      },
    }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  engine = { adaptor, doc };
  return engine;
}

/**
 * The formula as a display (block) formula, or in the style of one in a
 * line of text (`display` false: smaller limits, fractions in the line's
 * height), or null for TeX MathJax can't read.
 */
export function formulaSvg(tex: string, display = true): FormulaSvg | null {
  if (!tex.trim() || tex.length > MAX_TEX) return null;
  const { adaptor, doc } = load();
  let svg: string;
  try {
    svg = adaptor.innerHTML(doc.convert(tex, { display }));
  } catch {
    return null;
  }
  if (svg.includes("data-mjx-error") || !svg.startsWith("<svg")) return null;
  // The viewBox is in thousandths of an em: its size at the reader's text size, in pixels.
  const box = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!box) return null;
  const width = Math.max(1, Math.ceil((Number(box[3]) / 1000) * FORMULA_FONT_PX));
  const height = Math.max(1, Math.ceil((Number(box[4]) / 1000) * FORMULA_FONT_PX));
  // The viewBox starts at the top (y below the baseline is positive).
  const below = Number(box[2]) + Number(box[4]);
  const depth = Math.max(0, Math.round((below / 1000) * FORMULA_FONT_PX));
  svg = svg
    .replace(/^<svg style="[^"]*"/, "<svg")
    .replace(
      /^(<svg[^>]*?) width="[^"]*" height="[^"]*"/,
      `$1 width="${width}" height="${height}"`,
    );
  return { svg, width, height, depth };
}
