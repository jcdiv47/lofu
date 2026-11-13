import { defineExtension, type RichNodeJSON } from "nsh/base";
import { ALONE, type Formula, PLACEHOLDER } from "../../../packages/shared/src/formulas";

export { type Formula, protectMath } from "../../../packages/shared/src/formulas";

/**
 * Formulas (`$…$` in text, `$$…$$` on lines of their own: how the server's
 * Markdown keeps KaTeX and MathML) set as text the editor can show:
 * variables in italics, symbols as their characters, scripts raised or
 * lowered with Unicode where it has the characters (x², hₜ₋₁) and smaller
 * otherwise, fractions as a/b, cases and aligned equations a row a line.
 * The editor has no math node: its Markdown would show the TeX, and read
 * `*` and `_` in it as emphasis.
 *
 * So before parsing, each formula becomes a numbered placeholder between
 * private-use sentinels (`protectMath`, packages/shared/src/formulas.ts;
 * code is left alone), and after parsing `typesetMath` puts the set formula
 * in its place. A display formula is a paragraph of its own, centred
 * (`textAlign: "center"`): the server's picture of it when there is one
 * (drawn by MathJax, apps/server/src/extract/mathPictures.ts), else the
 * formula set as text. The stored Markdown keeps the TeX, which is what the
 * CLI and agents read.
 */

/** The marks of scripts Unicode has no characters for (styled smaller: the editor can't raise text). */
export const mathMarks = [
  defineExtension({ name: "mathSub", mark: {} }),
  defineExtension({ name: "mathSup", mark: {} }),
];

/** A formula's picture: where it loads from and its size. */
export interface FormulaPicture {
  src: string;
  width: number;
  height: number;
  /** How far it reaches below the baseline, in pixels (formulas in text). */
  depth?: number;
}

/** Deepest a formula in text is lowered (`depthTitle`). */
export const MAX_DEPTH = 40;
/**
 * A picture in text sits on the baseline, so one reaching below it (a sum's
 * limits, a subscript) would float above the line. Its depth goes in the
 * image's title, which the reader's classes lower it by (`image[title=…]`).
 * Every formula has one, depth 0 too: on the Mac (nsh 0.5) an SVG image node
 * no class applies to draws nothing.
 */
export const depthTitle = (depth: number) => `formula-${Math.min(MAX_DEPTH, Math.round(depth))}`;

/** A formula's key in `typesetMath`'s pictures: its style (display or text) and TeX. */
export const pictureKey = (tex: string, display: boolean) => `${display ? "D" : "I"}${tex}`;

/**
 * Puts the formulas `protectMath` took out back as their pictures (by
 * `pictureKey`), or set as text where there is none (an older server, TeX
 * MathJax can't read, an article read offline before pictures). Returns a
 * new document.
 */
export function typesetMath(
  doc: RichNodeJSON,
  formulas: Formula[],
  pictures: Map<string, FormulaPicture> = new Map(),
): RichNodeJSON {
  if (formulas.length === 0) return doc;
  const walk = (n: RichNodeJSON): RichNodeJSON => {
    if (!n.content) return n;
    const alone =
      n.type === "paragraph" && n.content.length === 1
        ? ALONE.exec(n.content[0]!.text ?? "")
        : null;
    const formula = alone ? formulas[Number(alone[1])] : undefined;
    const picture = formula && pictures.get(pictureKey(formula.tex, true));
    if (picture) {
      const { src, width, height } = picture;
      const image = {
        type: "image",
        attrs: { src, alt: formula.tex, title: depthTitle(0), width, height },
      };
      return { ...n, attrs: { ...n.attrs, textAlign: "center" }, content: [image] };
    }
    const content: RichNodeJSON[] = [];
    for (const c of n.content) {
      if (c.type !== "text" || !c.text || !PLACEHOLDER.test(c.text)) {
        content.push(walk(c));
        continue;
      }
      const parts = c.text.split(PLACEHOLDER); // text, kind, n, text, kind, n, ..., text
      for (let k = 0; k < parts.length; k += 3) {
        if (parts[k]) content.push({ ...c, text: parts[k] });
        if (k + 2 >= parts.length) break;
        const f = formulas[Number(parts[k + 2])];
        const inline = f && !f.display && pictures.get(pictureKey(f.tex, false));
        if (inline) {
          const { src, width, height, depth = 0 } = inline;
          const title = depthTitle(depth);
          content.push({ type: "image", attrs: { src, alt: f.tex, title, width, height } });
          continue;
        }
        for (const r of typeset(f?.tex ?? "", f?.display)) {
          if (r.text === "\n") {
            content.push({ type: "hardBreak" });
            continue;
          }
          const marks = [...(c.marks ?? [])];
          for (const type of r.marks) if (!marks.some((m) => m.type === type)) marks.push({ type });
          content.push(
            marks.length ? { type: "text", text: r.text, marks } : { type: "text", text: r.text },
          );
        }
      }
    }
    const out: RichNodeJSON = { ...n, content };
    if (alone) out.attrs = { ...n.attrs, textAlign: "center" };
    return out;
  };
  return walk(doc);
}

// --- TeX ---------------------------------------------------------------------

/** A run of text and its marks (`italic`, `bold`, `mathSub`, `mathSup`); `"\n"` is a line break. */
export interface Run {
  text: string;
  marks: string[];
}

/** How an atom is spaced from its neighbours, as TeX spaces them. */
type Cls = "ord" | "op" | "bin" | "rel" | "open" | "close" | "punct" | "space" | "amp" | "row";
interface Atom {
  runs: Run[];
  cls: Cls;
}
interface Style {
  upright?: boolean;
  bold?: boolean;
  font?: "bb" | "cal" | "frak";
}

/** The formula as runs. TeX it can't read is shown as it is. */
export function typeset(tex: string, display = false): Run[] {
  try {
    return merge(join(new Parser(tex).list(null, {}), false, display));
  } catch {
    return [{ text: tex, marks: [] }];
  }
}

function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    if (prev && r.text !== "\n" && prev.text !== "\n" && same(prev.marks, r.marks))
      prev.text += r.text;
    else out.push({ text: r.text, marks: [...r.marks] });
  }
  return out;
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((m) => b.includes(m));
const plain = (runs: Run[]) => runs.map((r) => r.text).join("");
const run = (text: string, marks: string[] = []): Run => ({ text, marks });
const ord = (text: string, marks: string[] = []): Atom => ({
  runs: [run(text, marks)],
  cls: "ord",
});

/** Atoms as runs, spaced: relations and binary operators get spaces around them, punctuation one after. */
function join(atoms: Atom[], script: boolean, display: boolean): Run[] {
  const out: Run[] = [];
  const space = () => {
    const last = out[out.length - 1];
    if (last && last.text !== "\n" && !last.text.endsWith(" ")) out.push(run(" "));
  };
  let prev: Cls | null = null;
  for (const a of atoms) {
    let cls = a.cls;
    if (cls === "amp") continue;
    if (cls === "row") {
      out.push(run(display ? "\n" : "; "));
      prev = null;
      continue;
    }
    // A binary operator with nothing to its left is a sign (−1, (−x)).
    if (cls === "bin" && (prev === null || /^(bin|rel|open|punct|op)$/.test(prev))) cls = "ord";
    if (!script) {
      if ((cls === "bin" || cls === "rel") && prev !== null && prev !== "open") space();
      else if (cls === "op" && prev !== null && /^(ord|close)$/.test(prev)) space();
      else if (prev === "rel" || prev === "bin" || prev === "punct") space();
      else if (prev === "op" && /^(ord|op)$/.test(cls)) space();
    }
    out.push(...a.runs);
    if (cls !== "space") prev = cls;
  }
  // Spaces never start or end a formula, or a line of one.
  while (out[0]?.text === " ") out.shift();
  while (out[out.length - 1]?.text === " ") out.pop();
  return out.filter((r, i) => r.text !== " " || out[i + 1]?.text !== "\n");
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  /** Atoms up to `stop` (`}` or `\end{…}`) or the end. */
  list(stop: string | null, style: Style): Atom[] {
    const atoms: Atom[] = [];
    let st = { ...style };
    while (this.i < this.s.length) {
      this.skipSpace();
      if (this.i >= this.s.length) break;
      if (stop === "}" && this.s[this.i] === "}") {
        this.i++;
        return atoms;
      }
      if (stop && stop !== "}" && this.s.startsWith(stop, this.i)) {
        this.i += stop.length;
        return atoms;
      }
      const c = this.s[this.i]!;
      if (c === "^" || c === "_") {
        // A subscript and a superscript of one base are set alike (x_i^2, w^I_{t,j}).
        const scripts: Script[] = [];
        for (const mark of [c, c === "^" ? "_" : "^"]) {
          this.skipSpace();
          if (this.s[this.i] !== mark) break;
          this.i++;
          scripts.push({ runs: this.arg(st, true), sup: mark === "^" });
        }
        if (!atoms.length) atoms.push(ord(""));
        const base = atoms[atoms.length - 1]!;
        base.runs.push(...scriptsRuns(scripts));
        if (base.cls === "space") base.cls = "ord";
        continue;
      }
      if (c === "'") {
        let n = 0;
        while (this.s[this.i] === "'") {
          n++;
          this.i++;
        }
        const prime = n === 1 ? "′" : n === 2 ? "″" : "‴";
        if (atoms.length) atoms[atoms.length - 1]!.runs.push(run(prime));
        else atoms.push(ord(prime));
        continue;
      }
      // Style switches (`{\rm d}x`) last to the end of the group.
      const sw = /^\\(rm|bf|it|cal)(?![a-zA-Z])/.exec(this.s.slice(this.i, this.i + 5));
      if (sw) {
        this.i += sw[0].length;
        if (sw[1] === "rm") st = { ...st, upright: true };
        else if (sw[1] === "bf") st = { ...st, bold: true, upright: true };
        else if (sw[1] === "it") st = { ...st, upright: false };
        else st = { ...st, font: "cal" };
        continue;
      }
      atoms.push(...this.atom(st));
    }
    return atoms;
  }

  skipSpace() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  /** One argument (a group, a command or a character) as runs. */
  arg(style: Style, script = false): Run[] {
    this.skipSpace();
    if (this.s[this.i] === "{") {
      this.i++;
      return join(this.list("}", style), script, false);
    }
    if (this.i >= this.s.length) return [];
    // An argument without braces is one character: \frac12 is 1/2, x^23 is x²3.
    if (/[0-9]/.test(this.s[this.i]!)) return [run(letters(this.s[this.i++]!, style))];
    return join(this.atom(style), script, false);
  }

  /** A group's raw text (`\text{…}`, an environment's name). */
  raw(): string {
    this.skipSpace();
    if (this.s[this.i] !== "{") return this.s[this.i++] ?? "";
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === "\\") this.i++;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return this.s.slice(start, this.i++);
    }
    return this.s.slice(start);
  }

  /** An optional `[…]` argument. */
  optional(): string | null {
    this.skipSpace();
    if (this.s[this.i] !== "[") return null;
    const end = this.s.indexOf("]", this.i);
    if (end < 0) return null;
    const v = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return v;
  }

  atom(style: Style): Atom[] {
    const c = this.s[this.i]!;
    if (c === "{") {
      this.i++;
      return [{ runs: join(this.list("}", style), false, false), cls: "ord" }];
    }
    if (c === "}") {
      this.i++; // unbalanced: dropped
      return [];
    }
    if (c === "\\") return this.command(style);
    this.i++;
    if (/[0-9]/.test(c)) {
      let n = c;
      while (
        /[0-9]/.test(this.s[this.i] ?? "") ||
        (this.s[this.i] === "." && /[0-9]/.test(this.s[this.i + 1] ?? ""))
      ) {
        n += this.s[this.i++];
      }
      return [ord(letters(n, style), style.bold ? ["bold"] : [])];
    }
    if (/[A-Za-z]/.test(c)) return [ord(letters(c, style), letterMarks(style))];
    if (c === "&") return [{ runs: [], cls: "amp" }];
    if (c === "~") return [{ runs: [run(" ")], cls: "space" }];
    const sym = CHARS[c];
    if (sym) return [{ runs: [run(sym[0])], cls: sym[1] }];
    return [ord(c)];
  }

  command(style: Style): Atom[] {
    const m = /^\\([a-zA-Z]+\*?|.)/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) {
      this.i++;
      return [];
    }
    this.i += m[0].length;
    const name = m[1]!;
    if (name === "\\") {
      this.optional(); // \\[2pt]
      return [{ runs: [], cls: "row" }];
    }
    const sym = SYMBOLS[name];
    if (sym) {
      const [text, cls] = sym;
      const marks = GREEK_LOWER.has(name) && !style.upright ? ["italic"] : [];
      return [{ runs: [run(text, style.bold ? [...marks, "bold"] : marks)], cls }];
    }
    if (SPACES[name] !== undefined) return [{ runs: [run(SPACES[name]!)], cls: "space" }];
    if (FUNCS.has(name)) return [{ runs: [run(name)], cls: "op" }];
    if (DELIMS.test(name)) {
      this.skipSpace();
      const d = this.delimiter();
      const cls: Cls =
        name === "left" || /^[bB]igg?l$/.test(name)
          ? "open"
          : name === "right" || /^[bB]igg?r$/.test(name)
            ? "close"
            : name === "middle" || /m$/.test(name)
              ? "rel"
              : "ord";
      return d ? [{ runs: [run(d)], cls }] : [];
    }
    const accent = ACCENTS[name];
    if (accent) {
      const every = name === "overline" || name === "underline";
      return [{ runs: accented(this.arg(style), accent, every), cls: "ord" }];
    }
    switch (name) {
      case "text":
      case "textrm":
      case "textnormal":
      case "textup":
      case "textsf":
      case "texttt":
      case "mbox":
      case "hbox":
        return [ord(this.raw().replace(/\$/g, ""))];
      case "textit":
      case "emph":
        return [ord(this.raw().replace(/\$/g, ""), ["italic"])];
      case "textbf":
        return [ord(this.raw().replace(/\$/g, ""), ["bold"])];
      case "operatorname":
      case "operatorname*":
        return [{ runs: [run(this.raw())], cls: "op" }];
      case "mathrm":
      case "mathsf":
      case "mathtt":
        return [{ runs: this.arg({ ...style, upright: true }), cls: "ord" }];
      case "mathit":
      case "mathnormal":
        return [{ runs: this.arg({ ...style, upright: false }), cls: "ord" }];
      case "mathbf":
        return [{ runs: this.arg({ ...style, bold: true, upright: true }), cls: "ord" }];
      case "boldsymbol":
      case "bm":
      case "pmb":
        return [{ runs: this.arg({ ...style, bold: true }), cls: "ord" }];
      case "mathbb":
      case "mathds":
      case "Bbb":
        return [{ runs: this.arg({ ...style, font: "bb" }), cls: "ord" }];
      case "mathcal":
      case "mathscr":
        return [{ runs: this.arg({ ...style, font: "cal" }), cls: "ord" }];
      case "mathfrak":
        return [{ runs: this.arg({ ...style, font: "frak" }), cls: "ord" }];
      case "frac":
      case "dfrac":
      case "tfrac":
      case "cfrac": {
        const a = this.arg(style);
        const b = this.arg(style);
        return [{ runs: [...group(a), run("/"), ...group(b)], cls: "ord" }];
      }
      case "binom":
      case "dbinom":
      case "tbinom": {
        const n = this.arg(style);
        const k = this.arg(style);
        return [{ runs: [run("C("), ...n, run(", "), ...k, run(")")], cls: "ord" }];
      }
      case "sqrt": {
        const index = this.optional();
        const a = this.arg(style);
        const root = index ? scriptRuns([run(index)], true) : [];
        return [{ runs: [...root, run("√"), ...group(a)], cls: "ord" }];
      }
      case "not": {
        this.skipSpace();
        const next = this.i < this.s.length ? this.atom(style) : [];
        const t = plain(next[0]?.runs ?? []);
        return [{ runs: [run(NOT[t] ?? `${t}\u0338`)], cls: next[0]?.cls ?? "rel" }];
      }
      case "begin":
        return this.environment(this.raw(), style);
      case "end":
        this.raw();
        return [];
      case "tag":
      case "tag*": {
        const t = this.raw();
        return [{ runs: [run(name === "tag" ? `\u2003(${t})` : `\u2003${t}`)], cls: "space" }];
      }
      case "hspace":
      case "hspace*":
        this.raw();
        return [{ runs: [run(" ")], cls: "space" }];
      case "label":
      case "vspace":
      case "vspace*":
      case "phantom":
      case "hphantom":
      case "vphantom":
      case "color":
        this.raw();
        return [];
      case "textcolor":
      case "colorbox":
        this.raw();
        return [{ runs: this.arg(style), cls: "ord" }];
      case "overset":
      case "stackrel": {
        const over = this.arg(style);
        const base = this.arg(style);
        return [{ runs: [...base, ...scriptRuns(over, true)], cls: "rel" }];
      }
      case "underset": {
        const under = this.arg(style);
        const base = this.arg(style);
        return [{ runs: [...base, ...scriptRuns(under, false)], cls: "ord" }];
      }
      case "overbrace":
      case "underbrace":
      case "boxed":
      case "fbox":
        return [{ runs: this.arg(style), cls: "ord" }];
      case "nonumber":
      case "notag":
      case "limits":
      case "nolimits":
      case "displaystyle":
      case "textstyle":
      case "scriptstyle":
      case "scriptscriptstyle":
        return [];
    }
    // A command it doesn't know: its name, upright.
    return [ord(name)];
  }

  delimiter(): string {
    const c = this.s[this.i];
    if (c === undefined) return "";
    if (c === "\\") {
      const m = /^\\([a-zA-Z]+|.)/.exec(this.s.slice(this.i, this.i + 40))!;
      this.i += m[0].length;
      return SYMBOLS[m[1]!]?.[0] ?? m[1]!;
    }
    this.i++;
    return c === "." ? "" : (CHARS[c]?.[0] ?? c);
  }

  /** Rows a line each (`aligned`, `cases`), or a matrix on one line between its brackets. */
  environment(name: string, style: Style): Atom[] {
    const env = name.replace(/\*$/, "");
    if (env === "array" || env === "alignat" || env === "tabular") this.raw();
    const rows: Atom[][][] = [[[]]];
    for (const a of this.list(`\\end{${name}}`, style)) {
      const row = rows[rows.length - 1]!;
      if (a.cls === "row") rows.push([[]]);
      else if (a.cls === "amp") row.push([]);
      else row[row.length - 1]!.push(a);
    }
    while (rows.length > 1 && rows[rows.length - 1]!.every((c) => c.length === 0)) rows.pop();
    const brackets = MATRICES[env];
    if (brackets) {
      const runs: Run[] = [run(brackets[0])];
      rows.forEach((row, r) => {
        if (r) runs.push(run("; "));
        row.forEach((cell, k) => {
          if (k) runs.push(run("\u2002"));
          runs.push(...join(cell, false, false));
        });
      });
      runs.push(run(brackets[1]));
      return [{ runs, cls: "ord" }];
    }
    // In aligned equations `&` only aligns; cases and arrays keep their cells apart.
    const cases = env === "cases" || env === "dcases";
    const apart = cases || env === "array" || env === "rcases";
    const out: Atom[] = [];
    if (cases) out.push({ runs: [run("{")], cls: "open" });
    rows.forEach((row, r) => {
      if (r) out.push({ runs: [], cls: "row" });
      row.forEach((cell, k) => {
        if (k && apart) out.push({ runs: [run("\u2003")], cls: "space" });
        out.push(...cell);
      });
    });
    return out;
  }
}

/** Letters in their font (𝔼, 𝓛, 𝔄); the rest as they are. */
function letters(s: string, style: Style): string {
  if (!style.font) return s;
  const f = FONTS[style.font];
  return [...s].map((c) => f(c) ?? c).join("");
}
function letterMarks(style: Style): string[] {
  const marks = style.upright || style.font ? [] : ["italic"];
  return style.bold ? [...marks, "bold"] : marks;
}

const offset = (base: number, c: string, from: string) =>
  String.fromCodePoint(base + c.charCodeAt(0) - from.charCodeAt(0));
const font =
  (upper: number, lower: number, special: Record<string, string>) =>
  (c: string): string | undefined =>
    special[c] ??
    (/[A-Z]/.test(c) ? offset(upper, c, "A") : /[a-z]/.test(c) ? offset(lower, c, "a") : undefined);
const FONTS: Record<NonNullable<Style["font"]>, (c: string) => string | undefined> = {
  bb: (c) =>
    /[0-9]/.test(c)
      ? offset(0x1d7d8, c, "0")
      : font(0x1d538, 0x1d552, { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" })(c),
  cal: font(0x1d49c, 0x1d4b6, {
    B: "ℬ",
    E: "ℰ",
    F: "ℱ",
    H: "ℋ",
    I: "ℐ",
    L: "ℒ",
    M: "ℳ",
    R: "ℛ",
    e: "ℯ",
    g: "ℊ",
    o: "ℴ",
  }),
  frak: font(0x1d504, 0x1d51e, { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" }),
};

/** A fraction's part: as it is when it is one thing (x, 2, xᵢ, (a + b)), else in brackets. */
function group(runs: Run[]): Run[] {
  const t = plain(runs).trim();
  if (/^[\p{L}\p{N}.′∞⁺⁻⁼⁽⁾₊₋₌₍₎]*$/u.test(t)) return runs;
  if (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1))) return runs;
  return [run("("), ...runs, run(")")];
}
function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Marks that already read as raised. */
const RAISED = /^[′″‴*∗†‡°]+$/;
// The reader's serif has almost none of these: they come from other fonts,
// so only those that look right there are used (no ⱼ, no capitals but ᵀ).
const SUP = pairs("0123456789+−-=()inT⊤,", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁱⁿᵀᵀ,");
const SUB = pairs("0123456789+−-=()aehiklmnopstx,", "₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎ₐₑₕᵢₖₗₘₙₒₚₛₜₓ,");
function pairs(from: string, to: string): Record<string, string> {
  const b = [...to];
  return Object.fromEntries([...from].map((c, i) => [c, b[i]!]));
}

interface Script {
  runs: Run[];
  sup: boolean;
}

/** A script in Unicode's raised or lowered characters, or null when it lacks one. */
function unicodeScript({ runs, sup }: Script): string | null {
  const t = plain(runs).replace(/\s+/g, "");
  if (sup && RAISED.test(t)) return t.replace(/\*/g, "∗");
  const map = sup ? SUP : SUB;
  const simple = runs.every((r) => r.marks.every((m) => m === "italic"));
  // One letter at most: a word of them is patchy.
  const letters = t.match(/\p{L}/gu)?.length ?? 0;
  if (!simple || letters > 1 || ![...t].every((c) => map[c])) return null;
  return [...t].map((c) => map[c]).join("");
}

/**
 * Scripts of one base: Unicode's raised or lowered characters when it has
 * them for all, else all as smaller text (the editor can't raise text), so
 * one isn't raised while the other sits on the line.
 */
function scriptsRuns(scripts: Script[]): Run[] {
  const present = scripts.filter((s) => plain(s.runs).trim());
  const unicode = present.map(unicodeScript);
  if (unicode.every((u) => u !== null)) return unicode.map((u) => run(u));
  return present.flatMap(({ runs, sup }) => {
    const mark = sup ? "mathSup" : "mathSub";
    return runs.map((r) => run(r.text, r.marks.includes(mark) ? r.marks : [...r.marks, mark]));
  });
}

const scriptRuns = (runs: Run[], sup: boolean) => scriptsRuns([{ runs, sup }]);

/** A combining accent over one character, or over every one (overline). */
function accented(runs: Run[], mark: string, every: boolean): Run[] {
  const out = runs.map((r) => run(r.text, r.marks));
  if (every) {
    for (const r of out) r.text = [...r.text].map((c) => (c.trim() ? c + mark : c)).join("");
    return out;
  }
  const last = [...out].reverse().find((r) => r.text.trim());
  if (last) last.text += mark;
  return out;
}

const NOT: Record<string, string> = {
  "=": "≠",
  "∈": "∉",
  "⊂": "⊄",
  "⊆": "⊈",
  "<": "≮",
  ">": "≯",
  "≤": "≰",
  "≥": "≱",
  "≡": "≢",
  "∼": "≁",
  "≈": "≉",
};

const ACCENTS: Record<string, string> = {
  hat: "\u0302",
  widehat: "\u0302",
  tilde: "\u0303",
  widetilde: "\u0303",
  bar: "\u0304",
  overline: "\u0305",
  underline: "\u0332",
  vec: "\u20d7",
  overrightarrow: "\u20d7",
  dot: "\u0307",
  ddot: "\u0308",
  check: "\u030c",
  breve: "\u0306",
  acute: "\u0301",
  grave: "\u0300",
  mathring: "\u030a",
};

const MATRICES: Record<string, [string, string]> = {
  matrix: ["", ""],
  smallmatrix: ["", ""],
  pmatrix: ["(", ")"],
  bmatrix: ["[", "]"],
  Bmatrix: ["{", "}"],
  vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"],
};

const DELIMS = /^(left|right|middle|[bB]igg?[lrm]?)$/;

const SPACES: Record<string, string> = {
  ",": "\u2009",
  ":": " ",
  ">": " ",
  ";": " ",
  " ": " ",
  "!": "",
  quad: "\u2003",
  qquad: "\u2003\u2003",
  enspace: "\u2002",
  thinspace: "\u2009",
  medspace: " ",
  thickspace: " ",
  negthinspace: "",
};

const CHARS: Record<string, [string, Cls]> = {
  "+": ["+", "bin"],
  "-": ["−", "bin"],
  "*": ["∗", "bin"],
  "=": ["=", "rel"],
  "<": ["<", "rel"],
  ">": [">", "rel"],
  ":": [":", "rel"],
  ",": [",", "punct"],
  ";": [";", "punct"],
  "(": ["(", "open"],
  "[": ["[", "open"],
  ")": [")", "close"],
  "]": ["]", "close"],
  "!": ["!", "close"],
  "?": ["?", "close"],
};

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  varkappa: "ϰ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
};
const GREEK_LOWER = new Set(Object.keys(GREEK));
const GREEK_UPPER: Record<string, string> = {
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

// name:character pairs, by how they are spaced.
const REL =
  "leq:≤ le:≤ geq:≥ ge:≥ neq:≠ ne:≠ approx:≈ sim:∼ simeq:≃ cong:≅ equiv:≡ propto:∝ ll:≪ gg:≫ in:∈ notin:∉ ni:∋ subset:⊂ subseteq:⊆ supset:⊃ supseteq:⊇ to:→ rightarrow:→ leftarrow:← gets:← Rightarrow:⇒ Leftarrow:⇐ leftrightarrow:↔ Leftrightarrow:⇔ iff:⟺ implies:⟹ impliedby:⟸ mapsto:↦ longrightarrow:⟶ longleftarrow:⟵ Longrightarrow:⟹ uparrow:↑ downarrow:↓ perp:⊥ parallel:∥ mid:∣ coloneqq:≔ triangleq:≜ doteq:≐ prec:≺ succ:≻ preceq:⪯ succeq:⪰ vdash:⊢ models:⊨ leqslant:⩽ geqslant:⩾ lesssim:≲ gtrsim:≳ asymp:≍";
const BIN =
  "pm:± mp:∓ times:× div:÷ cdot:· circ:∘ ast:∗ star:⋆ bullet:• oplus:⊕ ominus:⊖ otimes:⊗ odot:⊙ cup:∪ cap:∩ setminus:∖ wedge:∧ land:∧ vee:∨ lor:∨ sqcup:⊔ sqcap:⊓ uplus:⊎ diamond:⋄";
const OPS =
  "sum:∑ prod:∏ coprod:∐ int:∫ iint:∬ iiint:∭ oint:∮ bigcup:⋃ bigcap:⋂ bigoplus:⨁ bigotimes:⨂ bigvee:⋁ bigwedge:⋀ bigsqcup:⨆";
const ORD =
  "infty:∞ partial:∂ nabla:∇ forall:∀ exists:∃ nexists:∄ emptyset:∅ varnothing:∅ neg:¬ lnot:¬ angle:∠ top:⊤ bot:⊥ ell:ℓ hbar:ℏ hslash:ℏ Re:ℜ Im:ℑ aleph:ℵ wp:℘ prime:′ degree:° dots:… ldots:… cdots:⋯ vdots:⋮ ddots:⋱ triangle:△ square:□ checkmark:✓ dagger:† ddagger:‡ S:§ P:¶ %:% $:$ #:# &:& _:_ backslash:\\ vert:| Vert:‖ |:‖ surd:√ flat:♭ sharp:♯ clubsuit:♣ diamondsuit:♢ heartsuit:♡ spadesuit:♠ imath:ı jmath:ȷ";
const OPEN = "langle:⟨ lvert:| lVert:‖ lfloor:⌊ lceil:⌈ {:{ lbrace:{ lbrack:[";
const CLOSE = "rangle:⟩ rvert:| rVert:‖ rfloor:⌋ rceil:⌉ }:} rbrace:} rbrack:]";

const SYMBOLS: Record<string, [string, Cls]> = {};
for (const [list, cls] of [
  [REL, "rel"],
  [BIN, "bin"],
  [OPS, "op"],
  [ORD, "ord"],
  [OPEN, "open"],
  [CLOSE, "close"],
] as const) {
  for (const pair of list.split(" ")) {
    const at = pair.indexOf(":", 1);
    SYMBOLS[pair.slice(0, at)] = [pair.slice(at + 1), cls];
  }
}
for (const [k, v] of Object.entries({ ...GREEK, ...GREEK_UPPER })) SYMBOLS[k] = [v, "ord"];

/** Named functions, set upright. */
const FUNCS = new Set(
  "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp max min sup inf lim liminf limsup det dim ker deg gcd lcm arg Pr hom mod bmod argmax argmin".split(
    " ",
  ),
);
