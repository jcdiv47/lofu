/**
 * Defuddle's cleaned article HTML → Markdown.
 *
 * Defuddle's converter keeps what Markdown can't express as raw HTML: inline
 * `<svg>` (diagrams, MathJax formulas), `<sup>`/`<sub>`, `<iframe>`,
 * `<video>`, `<audio>` and tables with merged cells. Readers that don't render
 * HTML (the app's RichEditor) show those as literal tags, so they are
 * rewritten into plain HTML first and then converted with Defuddle's own
 * converter, which leaves everything else exactly as Defuddle would.
 *
 * Runs in the extraction worker (CPU). Text that merely looks like a tag
 * ("the <think> token") is a text node here, so it can't be mistaken for one.
 */
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

// Not in Defuddle's package exports; the Node build loads it from here too.
const { createMarkdownContent } = require(
  join(dirname(Bun.resolveSync("defuddle/node", import.meta.dir)), "markdown.js"),
) as { createMarkdownContent(html: string, url: string): string };

/**
 * The slice of linkedom's DOM used here, stated structurally: the server
 * compiles without the DOM lib (see sites/types.ts).
 */
interface DomNode {
  nodeType: number;
  textContent: string | null;
  previousSibling: DomNode | null;
}
interface El extends DomNode {
  localName: string;
  parentElement: El | null;
  children: Iterable<El>;
  childNodes: Iterable<DomNode>;
  attributes: Iterable<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  closest(selector: string): El | null;
  append(...nodes: DomNode[]): void;
  replaceWith(...nodes: DomNode[]): void;
  replaceChildren(...nodes: DomNode[]): void;
  remove(): void;
}
interface Doc {
  body: El & { innerHTML: string };
  createElement(tag: string): El;
  createTextNode(text: string): DomNode;
}

/** Bump when the output changes, so saved articles are converted again (jobs/markdown.ts). */
export const MARKDOWN_VERSION = 1;

/** Extractors whose Markdown is plain text rather than converted HTML (jobs/extract.ts). */
export const PLAIN_EXTRACTORS = ["pdftotext", "text", "markdown"];

const RAW = /<(svg|sup|sub|iframe|video|audio|td|th)\b/i;

export function articleMarkdown(html: string, url: string): string {
  if (!RAW.test(html)) return createMarkdownContent(html, url);
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  tidy(document as unknown as Doc, url);
  return createMarkdownContent(document.body.innerHTML, url);
}

function tidy(doc: Doc, url: string) {
  const outermost = (sel: string) =>
    [...doc.body.querySelectorAll(sel)].filter((e) => !e.parentElement?.closest(sel));
  const captions = new Set<El>();
  for (const svg of outermost("svg")) replaceSvg(doc, svg, captions);
  for (const el of [...doc.body.querySelectorAll("sup, sub")].reverse()) replaceScript(doc, el);
  for (const el of outermost("iframe, video, audio")) replaceEmbed(doc, el, url);
  // Innermost first: a nested table is laid out before the one around it.
  for (const t of [...doc.body.querySelectorAll("table")].reverse()) fixTable(doc, t);
}

// --- svg -------------------------------------------------------------------

/**
 * A MathJax formula becomes its text. A diagram becomes its accessible name
 * in italics, once when a page ships one copy per layout. An icon goes.
 */
function replaceSvg(doc: Doc, svg: El, captions: Set<El>) {
  if (svg.querySelector("[data-mml-node]")) {
    const text = mathText(svg.querySelector('[data-mml-node="math"]') ?? svg).trim();
    svg.replaceWith(doc.createTextNode(text));
    return;
  }
  const title = [...svg.children].find((c) => c.localName === "title");
  const label = (svg.getAttribute("aria-label") || title?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!label) {
    svg.remove();
    return;
  }
  let prev = svg.previousSibling;
  while (prev && prev.nodeType === 3 && !prev.textContent?.trim()) prev = prev.previousSibling;
  if (prev && captions.has(prev as El) && prev.textContent === label) {
    svg.remove();
    return;
  }
  const em = doc.createElement("em");
  em.textContent = label;
  // A figure on its own is a paragraph; one inside a sentence stays inline.
  let caption = em;
  if (!svg.parentElement || !INLINE.has(svg.parentElement.localName)) {
    caption = doc.createElement("p");
    caption.append(em);
  }
  captions.add(caption);
  svg.replaceWith(caption);
}

const INLINE = new Set(["p", "span", "a", "em", "i", "strong", "b", "small", "label", "td", "th"]);

/** MathJax SVG keeps the MathML tree (`data-mml-node`) and each glyph's character (`data-c`). */
function mathText(el: El): string {
  const kids: El[] = [];
  const collect = (e: El) => {
    for (const c of e.children) c.hasAttribute("data-mml-node") ? kids.push(c) : collect(c);
  };
  collect(el);
  const k = (i: number) => (kids[i] ? mathText(kids[i]) : "");
  switch (el.getAttribute("data-mml-node")) {
    case "mi":
    case "mn":
    case "mtext":
    case "ms":
      return glyphs(el);
    case "mo": {
      const op = glyphs(el);
      return /^[=+−×÷±∓≤≥≠≈≡∼→←↔⇒⇐⇔∈∉⊂⊆∪∩·]$/.test(op) ? ` ${op} ` : op;
    }
    case "msup":
    case "mover":
      return k(0) + script(k(1), SUP, "^");
    case "msub":
    case "munder":
      return k(0) + script(k(1), SUB, "_");
    case "msubsup":
    case "munderover":
      return k(0) + script(k(1), SUB, "_") + script(k(2), SUP, "^");
    case "mfrac":
      return `${group(k(0))}/${group(k(1))}`;
    case "msqrt":
      return `√${group(kids.map(mathText).join(""))}`;
    case "mroot":
      return `${script(k(1), SUP, "^")}√${group(k(0))}`;
    case "mphantom":
      return "";
    case "mspace":
      return " ";
    default:
      return kids.length ? kids.map(mathText).join("") : glyphs(el);
  }
}

function glyphs(el: El): string {
  let s = "";
  const walk = (e: El) => {
    for (const c of e.children) {
      const code = c.getAttribute("data-c");
      if (code && /^[0-9A-F]+$/i.test(code)) s += String.fromCodePoint(parseInt(code, 16));
      else if (c.localName === "text") s += c.textContent ?? "";
      else walk(c);
    }
  };
  walk(el);
  return s.normalize("NFKC"); // 𝑥 (math italic) → x
}

const group = (s: string) => {
  const t = s.trim();
  return /^[\p{L}\p{N}.′]*$/u.test(t) || /^\(.*\)$/.test(t) ? t : `(${t})`;
};

// --- sup / sub ---------------------------------------------------------------

const SUP: Record<string, string> = Object.fromEntries(
  [..."0123456789+-−=()ni"].map((c, i) => [c, "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ"[i]!]),
);
const SUB: Record<string, string> = Object.fromEntries(
  [..."0123456789+-−=()aeoxhklmnpstijruv"].map((c, i) => [
    c,
    [..."₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥ"][i]!,
  ]),
);
/** Marks that already read as raised (footnotes, x∗, f′). */
const MARKS = /^[*∗†‡§¶#′″]+$/;

function toScript(text: string, map: Record<string, string>): string | null {
  let out = "";
  for (const c of text) {
    if (c === "," || c === " ") out += c;
    else if (map[c]) out += map[c];
    else return null;
  }
  return out;
}

function script(s: string, map: Record<string, string>, mark: string) {
  const t = s.replace(/\s+/g, "");
  if (!t) return "";
  if (mark === "^" && MARKS.test(t)) return t;
  return toScript(t, map) ?? (/^[\p{L}\p{N}]$/u.test(t) ? mark + t : `${mark}(${t})`);
}

/** x<sup>2</sup> → x², H<sub>2</sub>O → H₂O; anything else is unwrapped (1<sup>st</sup> → 1st). */
function replaceScript(doc: Doc, el: El) {
  // Defuddle turns these into [^1] itself.
  if (el.localName === "sup" && el.getAttribute("id")?.startsWith("fnref:")) return;
  const text = (el.textContent ?? "").trim();
  const mapped = MARKS.test(text) ? text : toScript(text, el.localName === "sup" ? SUP : SUB);
  if (mapped === null) {
    el.replaceWith(...el.childNodes);
    return;
  }
  const link = el.querySelector("a[href]");
  const href = link?.getAttribute("href") ?? "";
  if (href && !href.startsWith("#")) {
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    a.textContent = mapped;
    el.replaceWith(a);
  } else {
    el.replaceWith(doc.createTextNode(mapped));
  }
}

// --- embeds ------------------------------------------------------------------

/** Players can't be shown; a link to what they play can. */
function replaceEmbed(doc: Doc, el: El, pageUrl: string) {
  const raw = el.getAttribute("src") || el.querySelector("source[src]")?.getAttribute("src") || "";
  let src: URL | null = null;
  try {
    src = raw ? new URL(raw, pageUrl) : null;
  } catch {}
  if (!src || !/^https?:$/.test(src.protocol)) {
    el.remove();
    return;
  }
  const title = (el.getAttribute("title") ?? "").trim();
  const label =
    el.localName === "video"
      ? "Video"
      : el.localName === "audio"
        ? "Audio"
        : title && !/^(iframe|embed)\b/i.test(title)
          ? title
          : src.hostname.replace(/^www\./, "");
  const p = doc.createElement("p");
  const a = doc.createElement("a");
  a.setAttribute("href", src.href);
  a.textContent = label;
  p.append(a);
  el.replaceWith(p);
}

// --- tables ------------------------------------------------------------------

/**
 * A cell's colspan/rowspan, whatever its case: React pages write `colSpan`,
 * linkedom keeps it as written and Defuddle's converter lowercases it.
 */
function spanAttr(c: El, name: string, remove = false): string | null {
  const a = [...c.attributes].find((x) => x.name.toLowerCase() === name);
  if (a && remove) c.removeAttribute(a.name);
  return a?.value ?? null;
}

const LAYOUT_BLOCKS = "blockquote, ul, ol, pre, dl, table";

/**
 * Defuddle keeps a table with merged cells as HTML. A data table gets its
 * merged cells split into empty ones, so it becomes a Markdown table. A
 * layout table (a forum post: quotes, lists, long text in a cell) becomes
 * its cells' content, one after another.
 */
function fixTable(doc: Doc, table: El) {
  const rows = [...table.querySelectorAll("tr")].filter((tr) => tr.closest("table") === table);
  const cellsOf = (tr: El) =>
    [...tr.children].filter((c) => c.localName === "td" || c.localName === "th");
  const cells = rows.flatMap(cellsOf);
  if (!cells.some((c) => spanAttr(c, "colspan") || spanAttr(c, "rowspan"))) return;
  // A nested table is flattened by Defuddle already.
  if ([...table.querySelectorAll("table")].some((t) => t !== table)) return;

  const isLayout = cells.some(
    (c) =>
      c.querySelector(LAYOUT_BLOCKS) !== null ||
      (c.textContent ?? "").replace(/\s+/g, " ").trim().length > 300,
  );
  if (isLayout) {
    const div = doc.createElement("div");
    for (const c of cells) {
      const part = doc.createElement("div");
      part.append(...c.childNodes);
      div.append(part);
    }
    table.replaceWith(div);
    return;
  }

  for (const c of cells) {
    for (const hr of [...c.querySelectorAll("hr")]) hr.remove();
    // A Markdown table cell holds one line: a heading in it becomes bold text.
    for (const h of [...c.querySelectorAll("h1, h2, h3, h4, h5, h6")]) {
      const b = doc.createElement("strong");
      b.append(...h.childNodes);
      h.replaceWith(b);
    }
  }
  const span = (c: El, a: string, max: number) => {
    const n = Number.parseInt(spanAttr(c, a, true) ?? "1", 10);
    return Math.min(max, Math.max(1, n || 1));
  };
  const taken: boolean[][] = rows.map(() => []);
  rows.forEach((tr, r) => {
    const out: El[] = [];
    let col = 0;
    const fill = () => {
      while (taken[r]![col]) {
        out.push(doc.createElement("td"));
        col++;
      }
    };
    for (const c of cellsOf(tr)) {
      fill();
      const cs = span(c, "colspan", 50);
      const rs = span(c, "rowspan", rows.length - r);
      out.push(c);
      for (let i = 1; i < cs; i++) out.push(doc.createElement(c.localName));
      for (let dr = 0; dr < rs; dr++) for (let i = 0; i < cs; i++) taken[r + dr]![col + i] = true;
      col += cs;
    }
    fill();
    tr.replaceChildren(...out);
  });
  // Rows left empty (separators, spacers) go, but the first one is the header.
  rows.forEach((tr, i) => {
    if (i > 0 && !(tr.textContent ?? "").trim() && !tr.querySelector("img")) tr.remove();
  });
}
