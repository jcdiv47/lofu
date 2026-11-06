import type { ExtractPool } from "../extract/pool.ts";
import type { BookmarkStore } from "../store/bookmarks.ts";
import type { JobHandler } from "./runner.ts";

const dec = new TextDecoder();

/**
 * Converts a saved article's HTML to Markdown again, after the conversion
 * changed (MARKDOWN_VERSION in extract/markdown.ts). Off-thread, like extraction.
 */
export function markdownHandler(deps: { bookmarks: BookmarkStore; pool: ExtractPool }): JobHandler {
  const { bookmarks, pool } = deps;
  return {
    async run(job) {
      const c = bookmarks.articleForMarkdown(job.bookmark_id);
      if (!c) return; // deleted, or never extracted
      const out = await pool.markdown(dec.decode(Bun.zstdDecompressSync(c.html)), c.url);
      const before = dec.decode(Bun.zstdDecompressSync(c.markdown));
      if (dec.decode(Bun.zstdDecompressSync(out.markdown)) === before) return;
      bookmarks.saveMarkdown(job.bookmark_id, c.extractedAt, out.markdown, out.text);
    },
    giveUp(job, error) {
      console.error(`converting ${job.bookmark_id} to Markdown failed:`, error.message);
    },
  };
}
