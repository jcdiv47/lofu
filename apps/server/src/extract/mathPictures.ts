import { timingSafeEqual } from "node:crypto";
import { pictureFormulas } from "@lofu/shared";
import type { ExtractPool } from "./pool.ts";
import type { MathOutput } from "./protocol.ts";

/**
 * Formulas on lines of their own drawn as SVG pictures, for readers that
 * can't typeset TeX (the app's editor). Drawn by MathJax in the extraction
 * workers (extract/mathSvg.ts), kept in memory (least recently used out),
 * and served from `/math/<signature>?t=<tex>&c=<rrggbb>`: a reader's
 * `<img>` can't send a token, so the path is signed with the image proxy's
 * key. The color is the reader's ink, so it isn't signed.
 */

/** Pictures kept in memory: a few KB each. */
const KEPT = 2000;
/** Formulas of one article drawn: past this, the rest are set as text. */
const PER_ARTICLE = 2000;

export interface ArticleFormula {
  tex: string;
  display: boolean;
  width: number;
  height: number;
  depth: number;
  src: string;
}

export class MathPictures {
  private kept = new Map<string, Promise<MathOutput>>();

  constructor(
    private pool: ExtractPool,
    private sign: (value: string) => string,
  ) {}

  /** The formula drawn, or null for TeX MathJax can't read (failures aren't kept). */
  draw(tex: string, display: boolean): Promise<MathOutput> {
    const key = `${display ? "D" : "I"}${tex}`;
    const hit = this.kept.get(key);
    if (hit) {
      // Most recently used last.
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    const drawn = this.pool.math(tex, display).catch(() => {
      this.kept.delete(key);
      return null;
    });
    this.kept.set(key, drawn);
    while (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!);
    return drawn;
  }

  private signed = (tex: string, display: boolean) =>
    this.sign(`math\n${display ? "" : "inline\n"}${tex}`);

  path(tex: string, display: boolean): string {
    const mode = display ? "" : "&i=1";
    return `/math/${this.signed(tex, display)}?t=${encodeURIComponent(tex)}${mode}`;
  }

  /**
   * The Markdown's formulas worth drawing (`pictureFormulas`) that could be,
   * with their pictures' paths and sizes.
   */
  async list(markdown: string): Promise<ArticleFormula[]> {
    if (!markdown.includes("$")) return [];
    const formulas = pictureFormulas(markdown).slice(0, PER_ARTICLE);
    const drawn = await Promise.all(formulas.map((f) => this.draw(f.tex, f.display)));
    return formulas.flatMap(({ tex, display }, i) => {
      const d = drawn[i];
      if (!d) return [];
      const { width, height, depth } = d;
      return [{ tex, display, width, height, depth, src: this.path(tex, display) }];
    });
  }

  async serve(
    sig: string,
    tex: string | undefined,
    color: string | undefined,
    inline: string | undefined,
  ): Promise<Response> {
    const display = inline !== "1";
    if (tex === undefined || !this.verify(sig, tex, display)) return failure("bad signature", 403);
    if (color !== undefined && !/^[0-9a-f]{6}$/i.test(color)) return failure("bad color", 400);
    const d = await this.draw(tex, display);
    if (!d) return failure("TeX MathJax can't read", 422);
    const svg = d.svg.replaceAll("currentColor", color ? `#${color}` : "#000");
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=604800",
        "x-content-type-options": "nosniff",
        // An SVG opened on its own must not run scripts on the server's origin.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  }

  private verify(sig: string, tex: string, display: boolean): boolean {
    const want = Buffer.from(this.signed(tex, display));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

const failure = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
