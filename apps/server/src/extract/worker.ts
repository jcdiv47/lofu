/// <reference lib="webworker" />
/**
 * Extraction worker thread. Defuddle + linkedom are pure CPU (≈0.5 s for a
 * large page), so they run here, off the API's event loop. Output blobs are
 * zstd-compressed in the worker too and handed back as transferables
 * (zero-copy).
 */
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { assetUrl } from "./assetUrl.ts";
import { detectBlockPage } from "./blocked.ts";
import type { ExtractRequest, ExtractResponse } from "./protocol.ts";
import { type SiteDocument, type SiteTransform, siteFor } from "./sites/index.ts";
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
    // A site adapter may rewrite the page first (see sites/types.ts).
    const site = siteFor(url);
    let input: Parameters<typeof Defuddle>[0] = html;
    let fix: SiteTransform | null = null;
    if (site?.transform) {
      const { document } = parseHTML(html);
      fix = site.transform(document as unknown as SiteDocument, new URL(url));
      input = document;
    }
    const r = await Defuddle(input, url, { separateMarkdown: true });
    const markdown = r.contentMarkdown ?? "";
    const text = markdownToText(markdown);
    const meta = fix?.meta;
    const ogType =
      r.metaTags?.find((m) => m.property === "og:type" || m.name === "og:type")?.content ?? null;
    const out = {
      html: zstd(r.content),
      markdown: zstd(markdown),
      text: zstd(text),
      title: nonEmpty(meta?.title) ?? nonEmpty(r.title),
      excerpt:
        nonEmpty(meta?.excerpt) ??
        nonEmpty(r.description) ??
        (text ? `${text.slice(0, 280).trim()}…` : null),
      coverUrl: assetUrl(meta?.coverUrl ?? r.image, url),
      faviconUrl: assetUrl(r.favicon, url),
      wordCount: r.wordCount || null,
      lang: nonEmpty(r.language),
      author: nonEmpty(meta?.author) ?? nonEmpty(r.author),
      publishedAt: nonEmpty(meta?.publishedAt) ?? nonEmpty(r.published),
      extractor: fix ? site!.name : (r.extractorType ?? null),
      ogType,
      textLength: text.length,
      blocked: fix?.blocked ?? detectBlockPage(nonEmpty(r.title), text),
      parseMs: performance.now() - t0,
    };
    const msg: ExtractResponse = { id, ok: true, out };
    self.postMessage(msg, [out.html.buffer, out.markdown.buffer, out.text.buffer]);
  } catch (e) {
    const msg: ExtractResponse = { id, ok: false, error: (e as Error).message ?? String(e) };
    self.postMessage(msg);
  }
};
