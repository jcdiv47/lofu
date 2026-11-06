/// <reference lib="webworker" />
/**
 * Extraction worker thread. Defuddle + linkedom are pure CPU (≈0.5 s for a
 * large page), so they run here, off the API's event loop. Output blobs are
 * zstd-compressed in the worker too and handed back as transferables
 * (zero-copy).
 */
import { Defuddle } from "defuddle/node";
import { assetUrl } from "./assetUrl.ts";
import { detectBlockPage } from "./blocked.ts";
import type { ExtractRequest, ExtractResponse } from "./protocol.ts";
import { markdownToText } from "./text.ts";

declare const self: Worker;

const ZSTD_LEVEL = 3;
const enc = new TextEncoder();
const zstd = (s: string) => Bun.zstdCompressSync(enc.encode(s), { level: ZSTD_LEVEL });

const nonEmpty = (s: string | undefined | null) => s?.trim() || null;

self.onmessage = async (ev: MessageEvent<ExtractRequest>) => {
  const { id, html, url } = ev.data;
  try {
    const t0 = performance.now();
    const r = await Defuddle(html, url, { separateMarkdown: true });
    const markdown = r.contentMarkdown ?? "";
    const text = markdownToText(markdown);
    const ogType =
      r.metaTags?.find((m) => m.property === "og:type" || m.name === "og:type")?.content ?? null;
    const out = {
      html: zstd(r.content),
      markdown: zstd(markdown),
      text: zstd(text),
      title: nonEmpty(r.title),
      excerpt: nonEmpty(r.description) ?? (text ? `${text.slice(0, 280).trim()}…` : null),
      coverUrl: assetUrl(r.image, url),
      faviconUrl: assetUrl(r.favicon, url),
      wordCount: r.wordCount || null,
      lang: nonEmpty(r.language),
      author: nonEmpty(r.author),
      publishedAt: nonEmpty(r.published),
      extractor: r.extractorType ?? null,
      ogType,
      textLength: text.length,
      blocked: detectBlockPage(nonEmpty(r.title), text),
      parseMs: performance.now() - t0,
    };
    const msg: ExtractResponse = { id, ok: true, out };
    self.postMessage(msg, [out.html.buffer, out.markdown.buffer, out.text.buffer]);
  } catch (e) {
    const msg: ExtractResponse = { id, ok: false, error: (e as Error).message ?? String(e) };
    self.postMessage(msg);
  }
};
