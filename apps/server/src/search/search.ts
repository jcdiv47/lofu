import type { Bookmark, BookmarkType } from "@lofu/shared";
import type { BookmarkStore } from "../store/bookmarks.ts";
import type { Meili } from "./meili.ts";
import { makeSnippet, queryMatcher } from "./snippet.ts";

const dec = new TextDecoder();

export interface SearchParams {
  q: string;
  collectionId?: string | undefined;
  tags?: string[] | undefined;
  archived?: boolean | undefined;
  favorite?: boolean | undefined;
  type?: BookmarkType | undefined;
  domain?: string | undefined;
  sort: "relevance" | "newest" | "oldest";
  limit: number;
  offset: number;
  semantic?: number | undefined;
  snippets: boolean;
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Meilisearch returns only ids (its fastest path); full bookmarks are then
 * loaded from SQLite in one indexed query and snippets are cut locally (see
 * snippet.ts). Results always reflect the latest committed state even if the
 * index lags.
 */
export class Searcher {
  constructor(
    private meili: Meili,
    private index: string,
    private bookmarks: BookmarkStore,
    private embedder: string,
  ) {}

  async search(p: SearchParams) {
    const filter: string[] = [];
    if (p.collectionId === "unsorted") filter.push("collectionId IS NULL");
    else if (p.collectionId) filter.push(`collectionId = ${quote(p.collectionId)}`);
    for (const t of p.tags ?? []) filter.push(`tags = ${quote(t)}`);
    if (p.archived !== undefined) filter.push(`archived = ${p.archived}`);
    if (p.favorite !== undefined) filter.push(`favorite = ${p.favorite}`);
    if (p.type) filter.push(`type = ${quote(p.type)}`);
    if (p.domain) filter.push(`domain = ${quote(p.domain)}`);

    const body: Record<string, unknown> = {
      q: p.q,
      filter,
      limit: p.limit,
      offset: p.offset,
      attributesToRetrieve: ["id"],
    };
    if (p.sort === "newest") body.sort = ["createdAt:desc"];
    else if (p.sort === "oldest") body.sort = ["createdAt:asc"];
    if (this.embedder && p.semantic !== undefined && p.q) {
      body.hybrid = { embedder: this.embedder, semanticRatio: p.semantic };
    }

    const res = await this.meili.request<{
      hits: { id: string }[];
      estimatedTotalHits?: number;
      processingTimeMs: number;
    }>("POST", `/indexes/${this.index}/search`, body);

    const bookmarks: Bookmark[] = this.bookmarks.getMany(res.hits.map((h) => h.id));
    const re = p.snippets ? queryMatcher(p.q) : null;
    const snippet = (id: string) => {
      if (!re) return null;
      const blob = this.bookmarks.contentBlob(id, "text");
      return blob ? makeSnippet(dec.decode(Bun.zstdDecompressSync(blob)), re) : null;
    };
    return {
      hits: bookmarks.map((bookmark) => ({ bookmark, snippet: snippet(bookmark.id) })),
      estimatedTotal: res.estimatedTotalHits ?? bookmarks.length,
      processingTimeMs: res.processingTimeMs,
    };
  }
}
