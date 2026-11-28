import {
  type Bookmark,
  type BookmarkType,
  type ContentStatus,
  dateRange,
  matchesTerm,
  parseQuery,
  type Term,
  tokenize,
} from "@lofu/shared";
import type { BookmarkFilter, BookmarkStore } from "../store/bookmarks.ts";
import type { BookmarkRow } from "../store/rows.ts";
import type { Meili } from "./meili.ts";
import { makeSnippets, queryMatcher } from "./snippet.ts";

const dec = new TextDecoder();

export interface SearchParams {
  q: string;
  /** Minutes east of UTC, for `created:` (see packages/shared/src/query.ts). */
  tz?: number | undefined;
  collectionId?: string | undefined;
  includeSubcollections?: boolean | undefined;
  tags?: string[] | undefined;
  archived?: boolean | undefined;
  favorite?: boolean | undefined;
  type?: BookmarkType | undefined;
  contentStatus?: ContentStatus | undefined;
  domain?: string | undefined;
  hasNote?: boolean | undefined;
  hasHighlights?: boolean | undefined;
  untagged?: boolean | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  sort: "relevance" | "newest" | "oldest";
  limit: number;
  offset: number;
  semantic?: number | undefined;
  snippets: boolean;
  maxSnippets?: number | undefined;
}

export interface SearchResponse {
  hits: { bookmark: Bookmark; snippet: string | null; snippets?: string[] }[];
  estimatedTotal: number;
  processingTimeMs: number;
  semanticApplied: boolean;
  engine: "meilisearch" | "sqlite";
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A condition of the search box as a Meilisearch filter. */
function filterOf(t: Term, tz: number): string {
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
      f = `title CONTAINS ${quote(t.text)} OR excerpt CONTAINS ${quote(t.text)}`;
      break;
    case "link":
      f = `url CONTAINS ${quote(t.text)}`;
      break;
  }
  return t.not ? `NOT (${f})` : `(${f})`;
}

/** The words of a query, lowercased; `-word` excludes, a "quoted phrase" is one. */
function wordsOf(text: string): { word: string; not: boolean }[] {
  const out: { word: string; not: boolean }[] = [];
  for (const { raw } of tokenize(text)) {
    const not = raw.startsWith("-") && raw.length > 1;
    const word = (not ? raw.slice(1) : raw).replace(/^"|"$/g, "").trim().toLowerCase();
    if (word) out.push({ word, not });
  }
  return out;
}

/** Rows read a batch at a time by the database search. */
const SCAN_BATCH = 500;
/** At most this many rows a database search looks at. */
const SCAN_ROWS = 20_000;
/** At most this many article texts a database search decompresses to look for words. */
const SCAN_TEXTS = 2_000;

/**
 * Meilisearch returns only ids (its fastest path); full bookmarks are then
 * loaded from SQLite in one indexed query and snippets are cut locally (see
 * snippet.ts). Results always reflect the latest committed state even if the
 * index lags.
 *
 * Without Meilisearch, and for queries of conditions only (no words), the
 * database answers instead: filters in SQL, the search box's conditions as
 * the apps evaluate them (`matchesTerm`), and words as case-insensitive
 * substrings of the title, description, note, address, tags, highlights and
 * text. It looks at a bounded number of rows and texts, so on a large
 * library a word search there may miss old matches; `estimatedTotal` then
 * counts what it found.
 */
export class Searcher {
  constructor(
    private meili: Meili | null,
    private index: string,
    private bookmarks: BookmarkStore,
    private embedder: string,
  ) {}

  get engine(): "meilisearch" | "sqlite" {
    return this.meili ? "meilisearch" : "sqlite";
  }

  get semanticAvailable(): boolean {
    return this.meili !== null && this.embedder !== "";
  }

  async search(p: SearchParams): Promise<SearchResponse> {
    const parsed = parseQuery(p.q);
    if (!this.meili || !parsed.text) return this.searchDb(p, parsed.text, parsed.terms);
    try {
      return await this.searchMeili(this.meili, p, parsed.text, parsed.terms);
    } catch (e) {
      // Meilisearch down or failing: the database still answers (more slowly).
      console.warn(`search: Meilisearch failed (${(e as Error).message}); using the database`);
      return this.searchDb(p, parsed.text, parsed.terms);
    }
  }

  private async searchMeili(
    meili: Meili,
    p: SearchParams,
    q: string,
    terms: Term[],
  ): Promise<SearchResponse> {
    const filter = terms.map((t) => filterOf(t, p.tz ?? 0));
    if (p.collectionId === "unsorted") filter.push("collectionId IS NULL");
    else if (p.collectionId && p.includeSubcollections) {
      const ids = this.bookmarks.collectionTree(p.collectionId);
      filter.push(`collectionId IN [${ids.map(quote).join(", ")}]`);
    } else if (p.collectionId) filter.push(`collectionId = ${quote(p.collectionId)}`);
    for (const t of p.tags ?? []) filter.push(`tags = ${quote(t)}`);
    if (p.archived !== undefined) filter.push(`archived = ${p.archived}`);
    if (p.favorite !== undefined) filter.push(`favorite = ${p.favorite}`);
    if (p.type) filter.push(`type = ${quote(p.type)}`);
    if (p.contentStatus) filter.push(`contentStatus = ${quote(p.contentStatus)}`);
    if (p.domain) filter.push(`domain = ${quote(p.domain.trim().toLowerCase())}`);
    if (p.hasNote !== undefined) filter.push(`hasNote = ${p.hasNote}`);
    if (p.hasHighlights !== undefined) filter.push(`hasHighlights = ${p.hasHighlights}`);
    if (p.untagged !== undefined) filter.push(p.untagged ? "tags IS EMPTY" : "tags IS NOT EMPTY");
    if (p.createdAfter) filter.push(`createdAt >= ${Date.parse(p.createdAfter)}`);
    if (p.createdBefore) filter.push(`createdAt < ${Date.parse(p.createdBefore)}`);

    const body: Record<string, unknown> = {
      q,
      filter,
      limit: p.limit,
      offset: p.offset,
      attributesToRetrieve: ["id"],
    };
    if (p.sort === "newest") body.sort = ["createdAt:desc"];
    else if (p.sort === "oldest") body.sort = ["createdAt:asc"];
    const semanticApplied = this.embedder !== "" && p.semantic !== undefined;
    if (semanticApplied) {
      body.hybrid = { embedder: this.embedder, semanticRatio: p.semantic };
    }

    const res = await meili.request<{
      hits: { id: string }[];
      estimatedTotalHits?: number;
      processingTimeMs: number;
    }>("POST", `/indexes/${this.index}/search`, body);

    const bookmarks: Bookmark[] = this.bookmarks.getMany(res.hits.map((h) => h.id));
    return {
      hits: this.withSnippets(bookmarks, q, p),
      estimatedTotal: res.estimatedTotalHits ?? bookmarks.length,
      processingTimeMs: res.processingTimeMs,
      semanticApplied,
      engine: "meilisearch",
    };
  }

  private searchDb(p: SearchParams, q: string, terms: Term[]): SearchResponse {
    const t0 = performance.now();
    const tz = p.tz ?? 0;
    const filter: BookmarkFilter = {
      collectionId: p.collectionId,
      includeSubcollections: p.includeSubcollections,
      tags: p.tags,
      archived: p.archived,
      favorite: p.favorite,
      type: p.type,
      contentStatus: p.contentStatus,
      domain: p.domain,
      hasNote: p.hasNote,
      hasHighlights: p.hasHighlights,
      untagged: p.untagged,
      createdAfter: p.createdAfter,
      createdBefore: p.createdBefore,
    };
    const words = wordsOf(q);
    const want = p.offset + p.limit;
    const found: (BookmarkRow & { highlight_count: number })[] = [];
    let after: [number, string] | null = null;
    let rowsSeen = 0;
    let textsRead = 0;

    // Whether the row holds every word and none of the excluded ones; null
    // when finding out would take reading more texts than allowed.
    const holdsWords = (r: BookmarkRow & { highlight_count: number }): boolean | null => {
      if (words.length === 0) return true;
      const meta = [r.title, r.excerpt ?? "", r.note ?? "", r.url, r.domain, r.tags]
        .join("\n")
        .toLowerCase();
      let hl: string | undefined;
      let text: string | undefined;
      const inHighlights = (w: string) => {
        if (r.highlight_count === 0) return false;
        hl ??= this.bookmarks
          .highlightTexts(r.id)
          .map((h) => `${h.quote}\n${h.note ?? ""}`)
          .join("\n")
          .toLowerCase();
        return hl.includes(w);
      };
      const inText = (w: string): boolean | null => {
        if (text === undefined) {
          if (r.extracted_at === null) text = "";
          else if (textsRead >= SCAN_TEXTS) return null;
          else {
            textsRead++;
            const blob = this.bookmarks.contentBlob(r.id, "text");
            text = blob ? dec.decode(Bun.zstdDecompressSync(blob)).toLowerCase() : "";
          }
        }
        return text.includes(w);
      };
      for (const { word, not } of words) {
        let found: boolean | null = meta.includes(word) || inHighlights(word);
        if (!found) found = inText(word);
        if (found === null) return null;
        if (found === not) return false;
      }
      return true;
    };

    scan: for (;;) {
      const rows = this.bookmarks.scan(
        filter,
        p.sort === "oldest" ? "oldest" : "newest",
        after,
        SCAN_BATCH,
      );
      for (const r of rows) {
        rowsSeen++;
        const m = {
          url: r.url,
          title: r.title,
          excerpt: r.excerpt,
          note: r.note,
          type: r.type,
          tags: JSON.parse(r.tags) as string[],
          favorite: r.favorite === 1,
          created: r.created_at,
          highlights: r.highlight_count,
        };
        if (!terms.every((t) => matchesTerm(m, t, tz))) continue;
        const holds = holdsWords(r);
        if (holds === null) break scan;
        if (holds) found.push(r);
        // One more than asked for: whether there are more.
        if (found.length > want && words.length > 0) break scan;
      }
      const last = rows.at(-1);
      if (rows.length < SCAN_BATCH || !last || rowsSeen >= SCAN_ROWS) break;
      after = [last.created_at, last.id];
    }

    const page = this.bookmarks.getMany(found.slice(p.offset, want).map((r) => r.id));
    return {
      hits: this.withSnippets(page, q, p),
      estimatedTotal: found.length,
      processingTimeMs: Math.round(performance.now() - t0),
      semanticApplied: false,
      engine: "sqlite",
    };
  }

  /**
   * Excerpts around the words: from the article's text first, then its note,
   * highlights, description and title, up to `maxSnippets`.
   */
  private withSnippets(bookmarks: Bookmark[], q: string, p: SearchParams) {
    // Words only: excluded ones aren't in the text to mark.
    const re = p.snippets
      ? queryMatcher(
          q
            .split(/\s+/)
            .filter((w) => !w.startsWith("-"))
            .join(" "),
        )
      : null;
    const max = p.maxSnippets ?? 1;
    return bookmarks.map((bookmark) => {
      if (!re) return { bookmark, snippet: null };
      const snippets = this.snippetsOf(bookmark, re, max);
      return { bookmark, snippet: snippets[0] ?? null, snippets };
    });
  }

  private snippetsOf(b: Bookmark, re: RegExp, max: number): string[] {
    const out: string[] = [];
    const add = (text: string | null | undefined) => {
      if (!text || out.length >= max) return;
      out.push(...makeSnippets(text, re, max - out.length));
    };
    const blob = this.bookmarks.contentBlob(b.id, "text");
    if (blob) add(dec.decode(Bun.zstdDecompressSync(blob)));
    add(b.note);
    if (out.length < max) {
      for (const h of this.bookmarks.highlightTexts(b.id)) {
        add(h.quote);
        add(h.note);
      }
    }
    add(b.excerpt);
    add(b.title);
    return out;
  }
}
