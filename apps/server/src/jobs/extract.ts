import type { BookmarkType } from "@lofu/shared";
import { FetchError, type Fetcher } from "../extract/fetch.ts";
import type { ExtractPool } from "../extract/pool.ts";
import type { BookmarkStore } from "../store/bookmarks.ts";
import type { Job } from "../store/jobs.ts";
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

function detectType(domain: string, ogType: string | null, wordCount: number | null): BookmarkType {
  if (VIDEO_HOSTS.has(domain) || ogType?.startsWith("video")) return "video";
  if (ogType?.startsWith("music")) return "audio";
  return (wordCount ?? 0) >= 150 ? "article" : "link";
}

export function extractHandler(deps: {
  bookmarks: BookmarkStore;
  fetcher: Fetcher;
  pool: ExtractPool;
}): JobHandler {
  const { bookmarks, fetcher, pool } = deps;
  return {
    async run(job: Job) {
      const row = bookmarks.row(job.bookmark_id);
      if (!row || row.deleted_at !== null) return;

      let html: string;
      let url = row.url;
      let rawBytes: number;
      if (job.payload !== null) {
        html = job.payload;
        rawBytes = Buffer.byteLength(html);
      } else {
        let fetched: Awaited<ReturnType<Fetcher["fetch"]>>;
        try {
          fetched = await fetcher.fetch(row.url);
        } catch (e) {
          if (e instanceof FetchError && e.permanent) throw new PermanentError(e.message);
          throw e;
        }
        if (fetched.kind === "other") {
          // PDFs, images, etc. Typed now; dedicated extractors can come later.
          bookmarks.setContentStatus(row.id, "skipped", {
            type: fetched.type,
            title: decodeURIComponent(new URL(fetched.finalUrl).pathname.split("/").pop() ?? ""),
          });
          return;
        }
        html = fetched.html;
        url = fetched.finalUrl;
        rawBytes = fetched.bytes;
      }

      const out = await pool.run(html, url);
      bookmarks.saveExtraction(row.id, {
        html: out.html,
        markdown: out.markdown,
        text: out.text,
        rawBytes,
        extractor: out.extractor,
        type: detectType(row.domain, out.ogType, out.wordCount),
        title: out.title,
        excerpt: out.excerpt,
        coverUrl: out.coverUrl,
        faviconUrl: out.faviconUrl,
        wordCount: out.wordCount,
        lang: out.lang,
        author: out.author,
        publishedAt: out.publishedAt,
      });
    },
    giveUp(job, error) {
      bookmarks.setContentStatus(job.bookmark_id, "failed", { error: error.message });
    },
  };
}
