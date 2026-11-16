/**
 * Inline SVG figures (charts, diagrams drawn into the page) kept as pictures
 * of their own. Markdown has no inline SVG and the app's editor shows raw
 * HTML as text, so a figure was reduced to its accessible name. Now the
 * conversion (extract/markdown.ts, in the extraction worker) takes each
 * figure out of the page, cleaned of anything that could run or fetch, and
 * the Markdown points at it as `![name](lofu:figure/<hash>)`. The server keeps
 * them with the article (`figures` table) and serves them from
 * `/figures/<hash>`; the article's `images` give readers that path and the
 * figure's size.
 *
 * A figure is drawn for its page's colors, which a picture on its own no
 * longer has: `currentColor` becomes an ink, and a background goes behind
 * it, dark when the figure's own colors are mostly light (drawn for a dark
 * page), white otherwise.
 */

/** The Markdown image URL of a figure: `![name](lofu:figure/<hash>)`. */
export const FIGURE_SCHEME = "lofu:figure/";
export const FIGURE_HASH = /^[0-9a-f]{32}$/;

export interface Figure {
  hash: string;
  svg: string;
  width: number;
  height: number;
}

/** The slice of linkedom's DOM used here (the server compiles without the DOM lib). */
interface SvgEl {
  localName: string;
  attributes: Iterable<{ name: string; value: string }>;
  textContent: string | null;
  outerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelectorAll(selector: string): Iterable<SvgEl>;
  querySelector(selector: string): SvgEl | null;
  remove(): void;
}

/** Smaller (in CSS pixels, either way) is an icon or a legend's swatch. */
const MIN_SIDE = 64;
/** Fewer shapes is a decoration: a rule, a box, a dot. */
const MIN_SHAPES = 3;
/** A bigger figure stays its name (a page that inlines a 5 MB map). */
const MAX_BYTES = 1024 * 1024;

const SHAPES = "path, rect, circle, ellipse, line, polygon, polyline, text, image, use";
/** What could run, fetch, or change the picture after it's drawn. */
const UNSAFE =
  "script, foreignobject, iframe, object, embed, audio, video, animate, set, animatemotion, animatetransform, discard, handler, listener";
/** SVG's mixed-case element names, which an HTML parser lowercases. */
const CASED = [
  "altGlyph",
  "animateMotion",
  "animateTransform",
  "clipPath",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "linearGradient",
  "radialGradient",
  "textPath",
];
const CASED_RE = new RegExp(`(</?)(${CASED.join("|")})\\b`, "gi");
const CASED_BY_LOWER = new Map(CASED.map((n) => [n.toLowerCase(), n]));

/** An `href` that stays inside the picture: a fragment, or an embedded bitmap. */
const LOCAL_HREF = /^\s*(#|data:image\/(png|jpe?g|gif|webp);)/i;
/** A CSS `url()` to anything but a fragment, or an `@import`. */
const REMOTE_CSS = /@import|url\(\s*['"]?\s*(?!#)/i;

const DARK = { ink: "#e6e3de", background: "#17191c" };
const LIGHT = { ink: "#1f1f1f", background: "#ffffff" };

/**
 * The figure `svg` draws, cleaned and colored to stand on its own, or null
 * when it isn't one (an icon, a decoration, hidden from assistive tech).
 * Changes `svg` in place: the caller replaces it.
 */
export function figureOf(svg: SvgEl, named: boolean): Figure | null {
  // Unnamed and outside a <figure>, a big drawing is the page's decoration.
  if (!named || svg.getAttribute("aria-hidden") === "true") return null;
  const box = viewBox(svg);
  const size = intrinsicSize(svg, box);
  if (!size || size.width < MIN_SIDE || size.height < MIN_SIDE) return null;
  if (count(svg.querySelectorAll(SHAPES)) < MIN_SHAPES) return null;
  if (paintedByPage(svg)) return null;
  const { ink, background } = lightInk(svg) ? DARK : LIGHT;

  for (const el of [...svg.querySelectorAll(UNSAFE)]) el.remove();
  for (const style of [...svg.querySelectorAll("style")]) {
    if (REMOTE_CSS.test(style.textContent ?? "")) style.remove();
  }
  // Classes stay for the figure's own stylesheet; without one they're the page's.
  const ownStyle = count(svg.querySelectorAll("style")) > 0;
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (
        n.startsWith("on") ||
        (n === "class" && !ownStyle) ||
        ((n === "href" || n === "xlink:href" || n === "src") && !LOCAL_HREF.test(value)) ||
        // `style`, and paint by presentation attribute (`fill="url(…)"`, `filter`).
        REMOTE_CSS.test(value)
      ) {
        el.removeAttribute(name);
      }
    }
  }
  // The page's layout (`style="width:100%"`, `role`, its name) has no use here.
  for (const name of ["style", "role", "aria-label", "aria-labelledby", "id"]) {
    svg.removeAttribute(name);
  }
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(size.width));
  svg.setAttribute("height", String(size.height));
  const vb = box ?? { x: 0, y: 0, width: size.width, height: size.height };
  if (!box) svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);

  let markup = svg.outerHTML;
  if (markup.length > MAX_BYTES) return null;
  if (/xlink:/.test(markup) && !/xmlns:xlink=/.test(markup)) {
    markup = markup.replace(/^<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  markup = markup
    .replace(
      CASED_RE,
      (_, open: string, name: string) => open + CASED_BY_LOWER.get(name.toLowerCase()),
    )
    .replace(/currentColor/gi, ink)
    .replace(
      /^(<svg\b[^>]*>)/,
      `$1<rect x="${vb.x}" y="${vb.y}" width="${vb.width}" height="${vb.height}" fill="${background}"/>`,
    );
  const hash = new Bun.CryptoHasher("sha256").update(markup).digest("hex").slice(0, 32);
  return { hash, svg: markup, width: Math.round(size.width), height: Math.round(size.height) };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function viewBox(svg: SvgEl): Box | null {
  const v = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n)) || v[2]! <= 0 || v[3]! <= 0) {
    return null;
  }
  return { x: v[0]!, y: v[1]!, width: v[2]!, height: v[3]! };
}

/** A length in CSS pixels (`640`, `640px`), or null for one relative to the page (`100%`, `40em`). */
function pixels(value: string | null): number | null {
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(value ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The size the figure is drawn at: its width and height, else its view box's. */
function intrinsicSize(svg: SvgEl, box: Box | null): { width: number; height: number } | null {
  const w = pixels(svg.getAttribute("width"));
  const h = pixels(svg.getAttribute("height"));
  if (w && h) return { width: w, height: h };
  if (!box) return null;
  if (w) return { width: w, height: (w * box.height) / box.width };
  if (h) return { width: (h * box.width) / box.height, height: h };
  return { width: box.width, height: box.height };
}

/** The figure's own paint for `property`, from its attribute or its inline style. */
function paint(el: SvgEl, property: "fill" | "stroke" | "color"): string | null {
  const style = el.getAttribute("style") ?? "";
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(style);
  return (m?.[1] ?? el.getAttribute(property))?.trim() ?? null;
}

const AREAS = new Set(["path", "rect", "circle", "ellipse", "polygon"]);

/**
 * Whether the figure's shapes are mostly filled with `currentColor`: the
 * page's stylesheet colored each (a pie chart's slices by class), which the
 * picture on its own can't, so they'd all come out one color.
 */
function paintedByPage(svg: SvgEl): boolean {
  let filled = 0;
  let current = 0;
  for (const el of svg.querySelectorAll(SHAPES)) {
    if (!AREAS.has(el.localName)) continue;
    const fill = paint(el, "fill");
    if (fill && /^none$/i.test(fill)) continue;
    filled++;
    if (fill && /^currentcolor$/i.test(fill)) current++;
  }
  return current >= 3 && current * 2 >= filled;
}

/**
 * Whether the figure's inks (its lines and its text) are mostly light: it
 * was drawn on a dark page. Fills of shapes don't tell: a light box is
 * drawn on either.
 */
function lightInk(svg: SvgEl): boolean {
  let sum = 0;
  let n = 0;
  const add = (color: string | null) => {
    const l = color ? luminance(color) : null;
    if (l === null) return;
    sum += l;
    n++;
  };
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    add(paint(el, "stroke"));
    add(paint(el, "color"));
    const name = el.localName;
    if (name === "text" || name === "tspan" || (name === "g" && el.querySelector("text"))) {
      add(paint(el, "fill"));
    }
  }
  return n > 0 && sum / n > 0.55;
}

function luminance(color: string): number | null {
  if (!/^(#[0-9a-f]{3,8}|rgba?\()/i.test(color)) return null;
  let r: number;
  let g: number;
  let b: number;
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
    if (hex.length !== 6 && hex.length !== 8) return null;
    [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  } else {
    const parts = color.match(/[\d.]+/g)?.map(Number);
    if (!parts || parts.length < 3) return null;
    [r, g, b] = parts as [number, number, number];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function count(it: Iterable<unknown>): number {
  let n = 0;
  for (const _ of it) n++;
  return n;
}
