import { type BookmarkType, onSite } from "@lofu/shared";
import type { Browser } from "../extract/browser.ts";
import { FetchError, type Fetcher, type FetchResult, HONEST_USER_AGENT } from "../extract/fetch.ts";
import type { PdfExtractor } from "../extract/pdf.ts";
import type { ExtractPool } from "../extract/pool.ts";
import type { ExtractOutput } from "../extract/protocol.ts";
import { siteFor } from "../extract/sites/index.ts";
import type { BookmarkStore, ExtractedContent } from "../store/bookmarks.ts";
import type { Job } from "../store/jobs.ts";
import type { BookmarkRow } from "../store/rows.ts";
import { type JobHandler, PermanentError } from "./runner.ts";

const VIDEO_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "m.youtube.com",
  "vimeo.com",
  "bilibili.com",
  "b23.tv",
  "tiktok.com",
  "twitch.tv",
  "dailymotion.com",
]);

/** Below this many characters of text, the page had no readable content. */
const MIN_TEXT_CHARS = 40;
const EMPTY_PAGE_ERROR = "no readable content (the page probably needs JavaScript)";

const enc = new TextEncoder();
const zstd = (s: string) => Bun.zstdCompressSync(enc.encode(s), { level: 3 });
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CJK_CHARS = /[぀-ヿ㐀-鿿가-힯]/g;
const countWords = (s: string) =>
  (s.match(/[\p{L}\p{N}]+/gu)?.filter((w) => !/^[぀-ヿ㐀-鿿가-힯]/.test(w)).length ?? 0) +
  (s.match(CJK_CHARS)?.length ?? 0);
const fileName = (url: string) => {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

function detectType(domain: string, ogType: string | null, wordCount: number | null): BookmarkType {
  if (VIDEO_HOSTS.has(domain) || ogType?.startsWith("video")) return "video";
  if (ogType?.startsWith("music")) return "audio";
  return (wordCount ?? 0) >= 150 ? "article" : "link";
}

/** Content record for text we already have as paragraphs (PDFs, text files). */
function plainContent(
  paragraphs: string[],
  rawBytes: number,
  extractor: string,
  meta: Partial<ExtractedContent>,
): ExtractedContent {
  const text = paragraphs.join("\n\n");
  return {
    html: zstd(paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")),
    markdown: zstd(text),
    text: zstd(text),
    rawBytes,
    extractor,
    type: "document",
    title: null,
    excerpt: paragraphs.find((p) => p.length > 80)?.slice(0, 280) ?? null,
    coverUrl: null,
    faviconUrl: null,
    wordCount: countWords(text),
    lang: null,
    author: null,
    publishedAt: null,
    ...meta,
  };
}

const ARXIV_PDF = /^\/pdf\/([^/]+?)(v\d+)?(\.pdf)?$/;
const htmlDecode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** arXiv PDFs rarely carry a Title; the abstract page has proper citation metadata. */
async function arxivMeta(url: string, fetcher: Fetcher) {
  const u = new URL(url);
  const m = u.hostname.endsWith("arxiv.org") ? ARXIV_PDF.exec(u.pathname) : null;
  if (!m) return null;
  try {
    const page = await fetcher.fetch(`https://arxiv.org/abs/${m[1]}`);
    if (page.kind !== "html") return null;
    const meta = (name: string) =>
      [...page.html.matchAll(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, "g"))].map(
        (x) => htmlDecode(x[1]!.trim()),
      );
    return {
      title: meta("citation_title")[0] ?? null,
      author: meta("citation_author").slice(0, 5).join("; ") || null,
      excerpt: meta("citation_abstract")[0]?.slice(0, 600) ?? null,
      publishedAt: meta("citation_date")[0] ?? null,
    };
  } catch {
    return null;
  }
}

/** WeChat's captcha is a rate limit: a browser from the same IP gets it too. Back off instead. */
const RATE_LIMIT_PAGES = new Set(["WeChat verification page"]);

export function extractHandler(deps: {
  bookmarks: BookmarkStore;
  fetcher: Fetcher;
  pool: ExtractPool;
  pdf: PdfExtractor;
  /** Optional headless-Chromium fallback. */
  browser: Browser | null;
  /** For GitHub's API (READMEs); null means the 60-an-hour anonymous limit. */
  githubToken?: string | null;
  /** Sites set not to be read (Settings): their bookmarks are `skipped`, unfetched. */
  skipDomains?: () => readonly string[];
}): JobHandler {
  const { bookmarks, fetcher, pool, pdf, browser } = deps;
  const siteCtx = { fetcher, githubToken: deps.githubToken ?? null };

  function save(
    row: BookmarkRow,
    out: ExtractOutput,
    rawBytes: number,
    outcome: { status: "ok" } | { status: "failed"; error: string },
    via?: string,
  ) {
    bookmarks.saveExtraction(
      row.id,
      {
        html: out.html,
        markdown: out.markdown,
        text: out.text,
        figures: out.figures,
        rawBytes,
        extractor: via ? `${out.extractor ?? "defuddle"}+${via}` : out.extractor,
        type: detectType(row.domain, out.ogType, out.wordCount),
        title: out.title,
        excerpt: out.excerpt,
        coverUrl: out.coverUrl,
        faviconUrl: out.faviconUrl,
        wordCount: out.wordCount,
        lang: out.lang,
        author: out.author,
        publishedAt: out.publishedAt,
      },
      outcome,
    );
  }

  /** Renders in headless Chromium. Returns null on success, else why it failed. */
  async function viaBrowser(row: BookmarkRow): Promise<string | null> {
    // Sites whose wall a headless browser never passes say what works instead.
    const noBrowser = siteFor(row.url)?.noBrowser;
    if (noBrowser) return noBrowser;
    if (!browser) return "no browser configured";
    let page: Awaited<ReturnType<Browser["render"]>>;
    try {
      page = await browser.render(row.url);
    } catch (e) {
      return (e as Error).message;
    }
    // The browser already judged the page (it polls until it looks real); a
    // page that never got there is an error page, however much text it has.
    const blocked = page.challenge;
    if (blocked) return `still blocked in a browser (${blocked})`;
    if (!page.ready) return "no readable content, even in a browser";
    const out = await pool.run(page.html, page.finalUrl);
    if (out.blocked) return `still blocked in a browser (${out.blocked})`;
    if (out.textLength < MIN_TEXT_CHARS && !out.complete)
      return "no readable content, even in a browser";
    save(row, out, Buffer.byteLength(page.html), { status: "ok" }, "browser");
    return null;
  }

  async function fromHtml(
    row: BookmarkRow,
    html: string,
    url: string,
    rawBytes: number,
    allowBrowser: boolean,
  ) {
    const out = await pool.run(html, url);
    if (out.blocked) {
      const noBrowser = siteFor(url)?.noBrowser;
      if (noBrowser) throw new PermanentError(`blocked by site: ${out.blocked}; ${noBrowser}`);
      if (RATE_LIMIT_PAGES.has(out.blocked) || !allowBrowser || !browser) {
        // Captcha/challenge served with HTTP 200: slow down on this host and retry later.
        fetcher.penalize(url);
        throw new Error(`blocked by site: ${out.blocked}`);
      }
      const failure = await viaBrowser(row);
      if (failure) throw new PermanentError(`blocked by site: ${out.blocked}; ${failure}`);
      return;
    }
    if (out.textLength < MIN_TEXT_CHARS && !out.complete) {
      // Probably a client-rendered app: try a real browser before giving up.
      const failure = allowBrowser && browser ? await viaBrowser(row) : EMPTY_PAGE_ERROR;
      // Keep the metadata (title, image) even when the body is empty.
      if (failure) save(row, out, rawBytes, { status: "failed", error: failure });
      return;
    }
    save(row, out, rawBytes, { status: "ok" });
  }

  /**
   * Cloudflare challenges a Chrome user agent without Chrome's TLS
   * fingerprint, yet serves many sites to a client that says what it is.
   * One request is cheaper than a browser render.
   */
  async function honestRetry(url: string): Promise<FetchResult | null> {
    try {
      return await fetcher.fetch(url, { userAgent: HONEST_USER_AGENT });
    } catch {
      return null;
    }
  }

  return {
    async run(job: Job) {
      const row = bookmarks.row(job.bookmark_id);
      if (!row || row.deleted_at !== null) return;

      if (onSite(row.domain, deps.skipDomains?.() ?? [])) {
        // Opened as the page itself: nothing is fetched, not even the HTML a client sent.
        bookmarks.setContentStatus(row.id, "skipped", {
          type: VIDEO_HOSTS.has(row.domain) ? "video" : undefined,
        });
        return;
      }

      if (job.payload !== null) {
        // HTML from the user's own browser: never second-guess it with ours.
        return fromHtml(row, job.payload, row.url, Buffer.byteLength(job.payload), false);
      }

      const site = siteFor(row.url);
      let fetched: FetchResult;
      try {
        fetched =
          (await site?.fetch?.(new URL(row.url), siteCtx)) ??
          (await fetcher.fetch(row.url, site?.request));
      } catch (e) {
        if (!(e instanceof FetchError) || !e.permanent) throw e;
        const retry = e.blocked && !site?.request?.userAgent ? await honestRetry(row.url) : null;
        if (retry) fetched = retry;
        else if (e.blocked && (browser || site?.noBrowser)) {
          const failure = await viaBrowser(row);
          if (!failure) return;
          throw new PermanentError(`${e.message}; ${failure}`);
        } else throw new PermanentError(e.message);
      }

      switch (fetched.kind) {
        case "html":
          return fromHtml(row, fetched.html, fetched.finalUrl, fetched.bytes, true);

        case "pdf": {
          if (!pdf.available) {
            bookmarks.setContentStatus(row.id, "skipped", {
              type: "document",
              title: fileName(fetched.finalUrl),
            });
            return;
          }
          const [doc, arxiv] = await Promise.all([
            pdf.extract(fetched.data).catch((e: Error) => {
              throw new PermanentError(`could not read PDF: ${e.message}`);
            }),
            arxivMeta(fetched.finalUrl, fetcher),
          ]);
          const content = plainContent(doc.paragraphs, fetched.data.byteLength, "pdftotext", {
            title: arxiv?.title ?? doc.title ?? fileName(fetched.finalUrl),
            author: arxiv?.author ?? doc.author,
            publishedAt: arxiv?.publishedAt ?? null,
          });
          if (arxiv?.excerpt) content.excerpt = arxiv.excerpt;
          const textChars = doc.paragraphs.reduce((n, p) => n + p.length, 0);
          bookmarks.saveExtraction(
            row.id,
            content,
            textChars < MIN_TEXT_CHARS
              ? { status: "failed", error: "no text layer in PDF (scanned document?)" }
              : { status: "ok" },
          );
          return;
        }

        case "text": {
          const content = plainContent([], fetched.bytes, fetched.markdown ? "markdown" : "text", {
            title: fileName(fetched.finalUrl),
          });
          content.markdown = zstd(fetched.text);
          content.text = zstd(fetched.text);
          content.html = zstd(`<pre>${escapeHtml(fetched.text)}</pre>`);
          content.wordCount = countWords(fetched.text);
          content.excerpt = fetched.text.trim().slice(0, 280) || null;
          bookmarks.saveExtraction(row.id, content);
          return;
        }

        case "other":
          // Images, video files, archives: typed, nothing to extract.
          bookmarks.setContentStatus(row.id, "skipped", {
            type: fetched.type,
            title: fileName(fetched.finalUrl),
          });
          return;
      }
    },
    giveUp(job, error) {
      bookmarks.setContentStatus(job.bookmark_id, "failed", { error: error.message });
    },
  };
}
