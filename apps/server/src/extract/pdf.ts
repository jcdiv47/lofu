import { Semaphore } from "../util/semaphore.ts";

/**
 * PDF text extraction via poppler (`pdftotext`, `pdfinfo`): native, fast
 * (a 20-page paper takes tens of ms), and run as child processes so the
 * event loop never blocks. Disabled if poppler isn't installed.
 */
export interface PdfResult {
  /** Reflowed paragraphs. */
  paragraphs: string[];
  title: string | null;
  author: string | null;
  pages: number | null;
}

const TIMEOUT_MS = 60_000;
const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯]/;

async function run(cmd: string[], input: Uint8Array): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdin: input,
    stdout: "pipe",
    stderr: "ignore",
    timeout: TIMEOUT_MS,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
  return out;
}

/**
 * Turns pdftotext's hard-wrapped lines back into paragraphs: blank lines and
 * form feeds separate paragraphs; inside one, lines are joined with a space,
 * except across CJK text (no spaces) and after a hyphenated line break.
 */
export function reflow(raw: string): string[] {
  const out: string[] = [];
  for (const block of raw.replace(/\f/g, "\n\n").split(/\n[ \t]*\n/)) {
    let para = "";
    for (const line of block.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      if (!para) para = l;
      else if (/[a-z]-$/.test(para) && /^[a-z]/.test(l)) para = para.slice(0, -1) + l;
      else if (CJK.test(para.at(-1) ?? "") || CJK.test(l[0] ?? "")) para += l;
      else para += ` ${l}`;
    }
    if (para) out.push(para);
  }
  return out;
}

function infoField(info: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(info);
  const v = m?.[1]?.trim();
  return v && v !== "untitled" ? v : null;
}

export class PdfExtractor {
  readonly available = Bun.which("pdftotext") !== null && Bun.which("pdfinfo") !== null;
  private sem: Semaphore;

  constructor(concurrency: number) {
    this.sem = new Semaphore(concurrency);
  }

  async extract(data: Uint8Array): Promise<PdfResult> {
    const release = await this.sem.acquire();
    try {
      const [text, info] = await Promise.all([
        run(["pdftotext", "-q", "-enc", "UTF-8", "-", "-"], data),
        run(["pdfinfo", "-enc", "UTF-8", "-"], data).catch(() => ""),
      ]);
      const pages = Number(infoField(info, "Pages"));
      return {
        paragraphs: reflow(text),
        title: infoField(info, "Title"),
        author: infoField(info, "Author"),
        pages: Number.isFinite(pages) && pages > 0 ? pages : null,
      };
    } finally {
      release();
    }
  }
}
