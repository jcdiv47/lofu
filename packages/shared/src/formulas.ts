/**
 * Formulas in Markdown, as the server's Markdown keeps KaTeX and MathML:
 * `$…$` in text, `$$…$$` on lines of their own. The reader sets them
 * (apps/reader/lib/math.ts); the server draws those on lines of their own
 * as pictures (apps/server/src/extract/mathPictures.ts). Both find them
 * here, so they agree on which formulas there are.
 */

const INLINE = "\ue002";
const DISPLAY = "\ue003";
const END = "\ue004";
/** A placeholder `protectMath` left: its kind (INLINE or DISPLAY) and the formula's index. */
export const PLACEHOLDER = /([\ue002\ue003])(\d+)\ue004/;
/** A placeholder of a display formula with nothing else around it. */
export const ALONE = /^\s*\ue003(\d+)\ue004\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DOLLARS = /^([ \t>]*)\$\$[ \t]*$/;

/** A formula of the Markdown: its TeX, and whether it is on a line of its own (`$$…$$`). */
export interface Formula {
  tex: string;
  display: boolean;
}

export interface ProtectedMath {
  /** The Markdown with each formula a placeholder (`PLACEHOLDER`). */
  markdown: string;
  formulas: Formula[];
}

/**
 * Takes the formulas out of Markdown (code is left alone): each becomes a
 * numbered placeholder between private-use sentinels, the index of its
 * entry in `formulas`.
 */
export function protectMath(markdown: string): ProtectedMath {
  const formulas: Formula[] = [];
  if (!markdown.includes("$")) return { markdown, formulas };
  const keep = (tex: string, open: string) => {
    formulas.push({ tex, display: open === DISPLAY });
    return `${open}${formulas.length - 1}${END}`;
  };
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f;
      out.push(line);
      continue;
    }
    // `$$` on a line, the formula, `$$` on a line (in a quote or a list too).
    const open = DOLLARS.exec(line);
    if (open) {
      const prefix = open[1]!;
      let end = i + 1;
      while (end < lines.length && end - i < 200 && !DOLLARS.test(lines[end]!)) end++;
      if (end < lines.length && DOLLARS.test(lines[end]!)) {
        const strip = (l: string) => (l.startsWith(prefix) ? l.slice(prefix.length) : l);
        const tex = lines
          .slice(i + 1, end)
          .map(strip)
          .join("\n");
        const blank = prefix.trimEnd();
        out.push(blank, prefix + keep(tex, DISPLAY), blank);
        i = end;
        continue;
      }
    }
    // `$$…$$` alone on a line is a display formula too.
    const one = /^([ \t>]*)\$\$(.+)\$\$[ \t]*$/.exec(line);
    if (one && !one[2]!.includes("$$")) {
      const blank = one[1]!.trimEnd();
      out.push(blank, one[1]! + keep(one[2]!, DISPLAY), blank);
      continue;
    }
    out.push(line.includes("$") ? inlineMath(line, keep) : line);
  }
  return { markdown: out.join("\n"), formulas };
}

/**
 * `$…$` in a line, read as Pandoc reads it. The opening `$` is followed by
 * something other than a space. The closing one follows something other
 * than a space and comes before no digit. So "$5 and $10" stays money.
 */
function inlineMath(line: string, keep: (tex: string, open: string) => string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "`") {
      const run = /^`+/.exec(line.slice(i))![0];
      let end = line.indexOf(run, i + run.length);
      while (end >= 0 && line[end + run.length] === "`") {
        end = line.indexOf(run, end + run.length + 1);
      }
      const to = end < 0 ? i + run.length : end + run.length;
      out += line.slice(i, to);
      i = to;
      continue;
    }
    if (c === "\\") {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c !== "$") {
      out += c;
      i++;
      continue;
    }
    const double = line[i + 1] === "$";
    const start = i + (double ? 2 : 1);
    const close = double ? line.indexOf("$$", start) : closingDollar(line, start);
    if (close > start) {
      out += keep(line.slice(start, close).trim(), INLINE);
      i = close + (double ? 2 : 1);
    } else {
      out += double ? "$$" : "$";
      i = start;
    }
  }
  return out;
}

function closingDollar(line: string, start: number): number {
  if (/\s/.test(line[start] ?? " ")) return -1;
  for (let j = start; j < line.length; j++) {
    if (line[j] === "\\") {
      j++;
      continue;
    }
    if (line[j] === "`") return -1; // a formula doesn't run into code
    if (line[j] !== "$") continue;
    // The first `$` decides: an opening `$` it doesn't close isn't one.
    return /\s/.test(line[j - 1]!) || /\d/.test(line[j + 1] ?? "") ? -1 : j;
  }
  return -1;
}

/** The formulas drawn as pictures: each once (by style and TeX), in order. */
export function pictureFormulas(markdown: string): Formula[] {
  const seen = new Set<string>();
  return protectMath(markdown).formulas.filter((f) => {
    const key = `${f.display ? "D" : "I"}${f.tex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
