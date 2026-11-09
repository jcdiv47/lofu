import { type Bookmark, type BookmarkType, dateRange, parseQuery, type Term } from "@lofu/shared";
import type { BookmarkStore } from "../store/bookmarks.ts";
import type { Meili } from "./meili.ts";
import { makeSnippet, queryMatcher } from "./snippet.ts";

const dec = new TextDecoder();

export interface SearchParams {
  q: string;
  /** Minutes east of UTC, for `created:` (see packages/shared/src/query.ts). */
  tz?: number | undefined;
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

/** A condition of the search box as a Meilisearch filter, or null when only words can say it. */
function filterOf(t: Term, tz: number): string | null {
  let f: string;
  switch (t.kind) {
    case "tag":
      f = `tags = ${quote(t.tag)}`;
      break;
    case "type":
      f = `type = ${quote(t.type)}`;
      break;
    case "notag":
      f = "tags IS EMPTY";
      break;
    case "note":
      f = "hasNote = true";
      break;
    case "highlights":
      f = "hasHighlights = true";
      break;
    case "favorite":
      f = "favorite = true";
      break;
    case "created": {
      const r = dateRange(t.date, tz);
      const parts = [
        ...(r.from === undefined ? [] : [`createdAt >= ${r.from}`]),
        ...(r.to === undefined ? [] : [`createdAt < ${r.to}`]),
      ];
      f = parts.join(" AND ");
      break;
    }
    case "info":
    case "link":
      return null;
  }
  return t.not ? `NOT (${f})` : f;
}

/**
 * The query Meilisearch gets for the search box's text: its words, and the
 * words of `info:` and `link:`, which also narrow the fields searched (to
 * the title and description, or the address) when nothing else is searched
 * for. An excluded one (`-info:word`) excludes the word everywhere.
 */
function textOf(text: string, terms: Term[]) {
  const words = text ? [text] : [];
  const on = new Set<string>();
  for (const t of terms) {
    if (t.kind !== "info" && t.kind !== "link") continue;
    const phrase = /\s/.test(t.text) ? `"${t.text}"` : t.text;
    words.push(t.not ? `-${phrase}` : phrase);
    if (t.not) continue;
    if (t.kind === "info") on.add("title").add("excerpt");
    else on.add("url").add("domain");
  }
  return { q: words.join(" "), on: text || !on.size ? null : [...on] };
}

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
    const parsed = parseQuery(p.q);
    const { q, on } = textOf(parsed.text, parsed.terms);
    const filter: string[] = [];
    for (const t of parsed.terms) {
      const f = filterOf(t, p.tz ?? 0);
      if (f) filter.push(f);
    }
    if (p.collectionId === "unsorted") filter.push("collectionId IS NULL");
    else if (p.collectionId) filter.push(`collectionId = ${quote(p.collectionId)}`);
    for (const t of p.tags ?? []) filter.push(`tags = ${quote(t)}`);
    if (p.archived !== undefined) filter.push(`archived = ${p.archived}`);
    if (p.favorite !== undefined) filter.push(`favorite = ${p.favorite}`);
    if (p.type) filter.push(`type = ${quote(p.type)}`);
    if (p.domain) filter.push(`domain = ${quote(p.domain)}`);

    const body: Record<string, unknown> = {
      q,
      filter,
      limit: p.limit,
      offset: p.offset,
      attributesToRetrieve: ["id"],
    };
    if (on) body.attributesToSearchOn = on;
    // Conditions alone have no relevance to rank by: the newest first.
    if (p.sort === "newest" || (p.sort === "relevance" && !q)) body.sort = ["createdAt:desc"];
    else if (p.sort === "oldest") body.sort = ["createdAt:asc"];
    if (this.embedder && p.semantic !== undefined && q) {
      body.hybrid = { embedder: this.embedder, semanticRatio: p.semantic };
    }

    const res = await this.meili.request<{
      hits: { id: string }[];
      estimatedTotalHits?: number;
      processingTimeMs: number;
    }>("POST", `/indexes/${this.index}/search`, body);

    const bookmarks: Bookmark[] = this.bookmarks.getMany(res.hits.map((h) => h.id));
    // Words only: excluded ones aren't in the text to mark.
    const re = p.snippets
      ? queryMatcher(
          q
            .split(/\s+/)
            .filter((w) => !w.startsWith("-"))
            .join(" "),
        )
      : null;
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
