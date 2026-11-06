export type ExtractRequest =
  /** Extract an article from a fetched page. */
  | { id: number; kind: "extract"; html: string; url: string }
  /** Convert an already extracted article's HTML to Markdown again (extract/markdown.ts). */
  | { id: number; kind: "markdown"; html: string; url: string };

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
  /** Set when the page is a captcha/challenge interstitial (see blocked.ts). */
  blocked: string | null;
  parseMs: number;
}

export type ExtractResponse =
  | { id: number; ok: true; out: ExtractOutput | MarkdownOutput }
  | { id: number; ok: false; error: string };
