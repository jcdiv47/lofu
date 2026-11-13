export type ExtractRequest =
  /** Extract an article from a fetched page. */
  | { id: number; kind: "extract"; html: string; url: string }
  /** Convert an already extracted article's HTML to Markdown again (extract/markdown.ts). */
  | { id: number; kind: "markdown"; html: string; url: string }
  /** Draw a formula's TeX as SVG (extract/mathSvg.ts). */
  | { id: number; kind: "math"; tex: string; display: boolean };

/** A formula drawn (extract/mathSvg.ts), or null for TeX MathJax can't read. */
export type MathOutput = { svg: string; width: number; height: number; depth: number } | null;

export interface MarkdownOutput {
  /** zstd-compressed markdown / plain text. */
  markdown: Uint8Array;
  text: Uint8Array;
}

export interface ExtractOutput {
  /** zstd-compressed cleaned article HTML / markdown / plain text. */
  html: Uint8Array;
  markdown: Uint8Array;
  text: Uint8Array;
  title: string | null;
  excerpt: string | null;
  coverUrl: string | null;
  faviconUrl: string | null;
  wordCount: number | null;
  lang: string | null;
  author: string | null;
  publishedAt: string | null;
  extractor: string | null;
  ogType: string | null;
  /** Length of the extracted plain text; ~0 means a JavaScript-only page. */
  textLength: number;
  /** A site adapter built the whole post: short text is all there is, not a JavaScript shell. */
  complete: boolean;
  /** Set when the page is a captcha/challenge interstitial (see blocked.ts). */
  blocked: string | null;
  parseMs: number;
}

export type ExtractResponse =
  | { id: number; ok: true; out: ExtractOutput | MarkdownOutput | MathOutput }
  | { id: number; ok: false; error: string };
