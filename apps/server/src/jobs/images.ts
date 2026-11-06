import { measureImages } from "../extract/images.ts";
import type { BookmarkStore } from "../store/bookmarks.ts";
import type { JobHandler } from "./runner.ts";

const dec = new TextDecoder();

/** Measures the images of a bookmark's saved Markdown (see extract/images.ts). */
export function imagesHandler(deps: { bookmarks: BookmarkStore }): JobHandler {
  const { bookmarks } = deps;
  return {
    async run(job) {
      const content = bookmarks.markdownForImages(job.bookmark_id);
      if (!content) return; // deleted, or never extracted
      const markdown = dec.decode(Bun.zstdDecompressSync(content.markdown));
      const sizes = await measureImages(markdown);
      bookmarks.saveImageSizes(job.bookmark_id, content.extractedAt, sizes);
    },
    giveUp(job, error) {
      console.error(`measuring images of ${job.bookmark_id} failed:`, error.message);
    },
  };
}
