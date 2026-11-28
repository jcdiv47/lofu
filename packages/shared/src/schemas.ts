import { z } from "zod";
import { siteDomain } from "./url.ts";

/**
 * API contract shared by the server, the web/native clients and (via the
 * generated OpenAPI document) the Rust CLI. Timestamps are ISO-8601 strings on
 * the wire and epoch milliseconds in storage.
 */

export const BookmarkType = z.enum(["article", "video", "image", "audio", "document", "link"]);
export type BookmarkType = z.infer<typeof BookmarkType>;

export const ContentStatus = z.enum(["pending", "ok", "failed", "skipped"]);
export type ContentStatus = z.infer<typeof ContentStatus>;

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime({ offset: true });

export const TagName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((t) => t.toLowerCase());

const inTrash = "In the Trash";

export const Bookmark = z
  .object({
    id,
    url: z.url(),
    title: z.string(),
    excerpt: z.string().nullable(),
    note: z.string().nullable(),
    coverUrl: z.string().nullable(),
    /**
     * Where to load the cover from instead, relative to the server: the signed
     * image proxy (`/img/<signature>?u=<url>`), which fetches it without the
     * Referer that hotlink protection (WeChat, CSDN) rejects. Computed, never
     * stored; null when there is no http(s) cover.
     */
    coverProxy: z
      .string()
      .nullable()
      .describe("The cover through the server's signed image proxy (a path); null without a cover"),
    faviconUrl: z.string().nullable(),
    domain: z.string(),
    type: BookmarkType,
    tags: z.array(z.string()),
    collectionId: id.nullable(),
    favorite: z.boolean(),
    /** In the Trash; deleting from the Trash deletes for good. */
    trashed: z.boolean().describe(inTrash),
    readProgress: z.number().min(0).max(1),
    wordCount: z.number().int().nullable(),
    lang: z.string().nullable(),
    author: z.string().nullable(),
    publishedAt: z.string().nullable(),
    contentStatus: ContentStatus,
    contentError: z.string().nullable(),
    extractedAt: isoDate
      .nullable()
      .describe(
        "When the stored content last changed (extracted or converted again); null without content",
      ),
    sort: z
      .number()
      .describe(
        "Its place in its collection's manual order, ascending; minus the save time (ms) until moved",
      ),
    createdAt: isoDate,
    updatedAt: isoDate,
    deletedAt: isoDate.nullable(),
    seq: z.number().int(),
  })
  .meta({ id: "Bookmark" });
export type Bookmark = z.infer<typeof Bookmark>;

export const CreateBookmark = z
  .object({
    /** Optional client-generated id (UUIDv7 recommended) for offline creation. */
    id: id.optional(),
    url: z.url({ protocol: /^https?$/ }),
    title: z.string().max(1000).optional(),
    note: z.string().max(100_000).optional(),
    tags: z.array(TagName).max(100).optional(),
    collectionId: id.nullable().optional(),
    favorite: z.boolean().optional(),
    trashed: z.boolean().describe(inTrash).optional(),
    /**
     * Already-rendered page HTML (e.g. from the browser extension). When
     * present the server skips fetching, which is both faster and the only way
     * to capture pages behind a login.
     */
    html: z
      .string()
      .max(20 * 1024 * 1024)
      .optional(),
    /** Original save time, for importers. */
    createdAt: isoDate.optional(),
  })
  .meta({ id: "CreateBookmark" });
export type CreateBookmark = z.infer<typeof CreateBookmark>;

/** A URL as browsers read its scheme: blanks and control characters dropped. */
const withoutControls = (v: string) =>
  Array.from(v)
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join("")
    .slice(0, 32);

/**
 * Its cover: an http(s) URL, one relative to the page, or a `data:` URL;
 * never one that runs script.
 */
const CoverUrl = z
  .string()
  .max(4096)
  .refine((v) => !/^(javascript|vbscript):/i.test(withoutControls(v)), {
    message: "cover URL must not run script",
  });

export const UpdateBookmark = z
  .object({
    title: z.string().max(1000),
    note: z.string().max(100_000).nullable(),
    /** Replaces every tag. Not with `addTags`/`removeTags`. */
    tags: z.array(TagName).max(100),
    /** Tags added to those it has (atomically, on the server). */
    addTags: z.array(TagName).max(100),
    /** Tags taken off (atomically, on the server); applied after `addTags`. */
    removeTags: z.array(TagName).max(100),
    collectionId: id.nullable(),
    favorite: z.boolean(),
    /** true moves the bookmark to the Trash, false restores it. */
    trashed: z.boolean().describe(inTrash),
    readProgress: z.number().min(0).max(1),
    coverUrl: CoverUrl.nullable(),
    /** Its place in the manual order: between the two it was dropped between. */
    sort: z.number(),
    /**
     * Optimistic concurrency: the `seq` the client last saw. The update is
     * refused (409, code `SEQ_CONFLICT`) if the bookmark changed since. An
     * `If-Match: "<seq>"` header does the same.
     */
    expectedSeq: z.number().int().min(0),
  })
  .partial()
  .meta({ id: "UpdateBookmark" });
export type UpdateBookmark = z.infer<typeof UpdateBookmark>;

const boolParam = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

/**
 * Which bookmarks, as to the Trash: `false` (the default) leaves it out,
 * `true` is only the Trash, `all` is both. Parsed to false, true, or
 * undefined for `all` (no condition).
 */
const trashedParam = z
  .enum(["false", "true", "all", "0", "1"])
  .default("false")
  .describe("false (default): not in the Trash; true: only the Trash; all: both")
  .transform((v) => (v === "all" ? undefined : v === "true" || v === "1"));

/** Comma-separated list in a query string, e.g. `tags=rust,perf`. */
const csvParam = z.string().transform((s) =>
  s
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean),
);

/** Comma-separated ids, kept as given (ids are case-sensitive). */
const idsParam = z.string().transform((s) =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
);

const filterParams = {
  collectionId: z.string().optional(),
  /** With `collectionId`: its subcollections' bookmarks too, at any depth. */
  includeSubcollections: boolParam.optional(),
  tags: csvParam.optional(),
  trashed: trashedParam,
  favorite: boolParam.optional(),
  type: BookmarkType.optional(),
  contentStatus: ContentStatus.optional(),
  /** The bookmark's domain, as `domain` shows it (`example.com`). */
  domain: z.string().max(253).optional(),
  hasNote: boolParam.optional(),
  hasHighlights: boolParam.optional(),
  untagged: boolParam.optional(),
  createdAfter: isoDate.optional(),
  createdBefore: isoDate.optional(),
};

export const ListBookmarksQuery = z.object({
  ...filterParams,
  /** Only these bookmarks (comma-separated ids, up to 500). */
  ids: idsParam.pipe(z.array(id).max(500)).optional(),
  sort: z
    .enum(["newest", "oldest", "updated", "manual"])
    .describe("newest/oldest by save time, updated: last changed first, manual: the drag order")
    .default("newest"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  /** Opaque cursor from a previous page's `nextCursor` (with the same `sort`). */
  cursor: z.string().optional(),
});

export const BookmarkPage = z
  .object({ items: z.array(Bookmark), nextCursor: z.string().nullable() })
  .meta({ id: "BookmarkPage" });

export const ContentFormat = z.enum(["none", "markdown", "html", "text"]);

export const ContentImage = z
  .object({
    /**
     * The image's URL as it appears in the content. `lofu:figure/<hash>` is a
     * figure the server took out of the page (an inline SVG chart or diagram).
     */
    src: z.string(),
    /** Its size in pixels; null until measured, or when it couldn't be. */
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    /**
     * Where to load it from instead, relative to the server: a signed proxy
     * that fetches it without the Referer hotlink protection rejects, or
     * `/figures/<hash>` for a figure. Null for `data:` URLs.
     */
    proxy: z.string().nullable(),
  })
  .meta({ id: "ContentImage" });

export const ContentFormula = z
  .object({
    /** The formula's TeX, as it is between `$$` (or `$`) in the content. */
    tex: z.string(),
    /** On a line of its own (`$$`), or in text (`$`, drawn in the style of text). */
    display: z.boolean(),
    /** The picture's size in pixels, for text 18 pixels high. */
    width: z.number().int(),
    height: z.number().int(),
    /** How far it reaches below the text's baseline, in pixels. */
    depth: z.number().int(),
    /**
     * The formula drawn as SVG, relative to the server (signed, as the image
     * proxy is). Add `&c=<rrggbb>` for its color (black without).
     */
    src: z.string(),
  })
  .meta({ id: "ContentFormula" });

/**
 * Highlights are anchored with a W3C Web Annotation TextQuoteSelector
 * (exact + prefix/suffix context) rather than offsets, so they survive
 * re-extraction and differing renderers across platforms.
 */
export const Highlight = z
  .object({
    id,
    bookmarkId: id,
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    note: z.string().nullable(),
    color: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
    deletedAt: isoDate.nullable(),
    seq: z.number().int(),
  })
  .meta({ id: "Highlight" });
export type Highlight = z.infer<typeof Highlight>;

export const HighlightList = z.object({ items: z.array(Highlight) }).meta({ id: "HighlightList" });

export const Heading = z
  .object({
    level: z.number().int().min(1).max(6),
    text: z.string(),
    /** Where the heading's line starts in the whole content (for `contentOffset`). */
    offset: z.number().int(),
  })
  .meta({ id: "Heading" });

export const BookmarkWithContent = Bookmark.extend({
  content: z.string().nullable(),
  contentFormat: ContentFormat,
  /**
   * The images of Markdown content, in order (null for other formats, or
   * when `include` is given without `media`).
   */
  images: z.array(ContentImage).nullable(),
  /**
   * The Markdown's formulas drawn as pictures, each once, in order: those on
   * lines of their own (`$$…$$`), and those in text with scripts, fractions
   * or the like; those MathJax can't read are left out (null for other
   * formats, or when `include` is given without `media`).
   */
  formulas: z.array(ContentFormula).nullable(),
  /** Its live highlights. */
  highlightCount: z.number().int(),
  /** With `include=highlights`: the highlights, oldest first. */
  highlights: z.array(Highlight).optional(),
  /** With `contentOffset`/`contentMaxChars`: the whole content's length (UTF-16 code units). */
  contentTotalChars: z.number().int().optional(),
  contentOffset: z.number().int().optional(),
  /** Whether content goes on past this slice. */
  contentHasMore: z.boolean().optional(),
  /** When slicing Markdown: every heading of the whole content. */
  headings: z.array(Heading).optional(),
}).meta({ id: "BookmarkWithContent" });

const includeParam = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(["media", "highlights", "none"])));

export const GetBookmarkQuery = z.object({
  content: ContentFormat.default("none"),
  /**
   * What to add besides the bookmark (comma-separated): `media` (the
   * Markdown's images and formulas), `highlights`, or `none`. Without it,
   * Markdown content comes with its media.
   */
  include: includeParam.optional(),
  /** Start of the content slice, in UTF-16 code units. */
  contentOffset: z.coerce.number().int().min(0).optional(),
  /** At most this much content (UTF-16 code units). */
  contentMaxChars: z.coerce.number().int().min(1).optional(),
});

export const SearchQuery = z.object({
  /**
   * Words, and conditions as the apps' search box writes them: `#tag`,
   * `type:article`, `notag:true`, `note:true`, `highlights:true`,
   * `favorite:true`, `created:2026-11` (`<`/`>` before or after), `info:word`
   * (title or description), `link:word` (address); `-` in front excludes.
   * See packages/shared/src/query.ts.
   */
  q: z.string().max(1000).default(""),
  /** The searcher's time zone, in minutes east of UTC: where `created:` days start. */
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  ...filterParams,
  sort: z.enum(["relevance", "newest", "oldest"]).default("relevance"),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  /** Include query-highlighted content excerpts (set false for the fastest response). */
  snippets: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  /** Up to this many excerpts a hit, from its text, note, highlights, description or title. */
  maxSnippets: z.coerce.number().int().min(1).max(5).default(1),
  /** Semantic weight 0..1 for hybrid search; only used when an embedder is configured. */
  semantic: z.coerce.number().min(0).max(1).optional(),
});

export const SearchHit = z
  .object({
    bookmark: Bookmark,
    /** Excerpt of the matched content with `<mark>` around hits. */
    snippet: z.string().nullable(),
    /** Up to `maxSnippets` excerpts (the first is `snippet`). */
    snippets: z.array(z.string()).optional(),
  })
  .meta({ id: "SearchHit" });

export const SearchResult = z
  .object({
    hits: z.array(SearchHit),
    estimatedTotal: z.number().int(),
    processingTimeMs: z.number().int(),
    /** Whether hybrid (semantic) ranking was used. */
    semanticApplied: z.boolean(),
    /** What answered: Meilisearch, or the database itself (no Meilisearch, or conditions only). */
    engine: z.enum(["meilisearch", "sqlite"]),
  })
  .meta({ id: "SearchResult" });

export const Collection = z
  .object({
    id,
    name: z.string(),
    parentId: id.nullable(),
    sort: z.number(),
    color: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
    deletedAt: isoDate.nullable(),
    seq: z.number().int(),
  })
  .meta({ id: "Collection" });
export type Collection = z.infer<typeof Collection>;

export const CollectionWithCount = Collection.extend({
  /** Its live bookmarks outside the Trash (not counting subcollections'). */
  bookmarkCount: z.number().int(),
}).meta({ id: "CollectionWithCount" });
export type CollectionWithCount = z.infer<typeof CollectionWithCount>;

export const CollectionList = z
  .object({ items: z.array(CollectionWithCount) })
  .meta({ id: "CollectionList" });

export const CreateCollection = z
  .object({
    /** Optional client-generated id (UUIDv7 recommended) for offline creation. */
    id: id.optional(),
    name: z.string().trim().min(1).max(200),
    parentId: id.nullable().optional(),
    sort: z.number().optional(),
    color: z.string().max(32).nullable().optional(),
  })
  .meta({ id: "CreateCollection" });

export const UpdateCollection = z
  .object({
    name: z.string().trim().min(1).max(200),
    parentId: id.nullable(),
    sort: z.number(),
    color: z.string().max(32).nullable(),
  })
  .partial()
  .meta({ id: "UpdateCollection" });

export const TagCount = z
  .object({ name: z.string(), count: z.number().int() })
  .meta({ id: "TagCount" });

export const TagList = z.object({ items: z.array(TagCount) }).meta({ id: "TagList" });

export const RenameTag = z
  .object({
    from: TagName,
    /** Bookmarks that already have this tag keep one copy of it (a merge). */
    to: TagName,
  })
  .meta({ id: "RenameTag" });

export const TagChange = z
  .object({
    /** Bookmarks changed; each got a new `seq`. */
    updated: z.number().int(),
  })
  .meta({ id: "TagChange" });

export const CreateHighlight = z
  .object({
    id: id.optional(),
    quote: z.string().min(1).max(50_000),
    prefix: z.string().max(256).default(""),
    suffix: z.string().max(256).default(""),
    note: z.string().max(100_000).nullable().optional(),
    color: z.string().max(32).nullable().optional(),
  })
  .meta({ id: "CreateHighlight" });

export const UpdateHighlight = z
  .object({ note: z.string().max(100_000).nullable(), color: z.string().max(32).nullable() })
  .partial()
  .meta({ id: "UpdateHighlight" });

export const SyncQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

/**
 * Delta sync: every write bumps a global, monotonic `seq`. Clients keep the
 * last `cursor` and pull everything after it; deletions arrive as rows with
 * `deletedAt` set.
 */
export const SyncResponse = z
  .object({
    cursor: z.number().int(),
    hasMore: z.boolean(),
    bookmarks: z.array(Bookmark),
    collections: z.array(Collection),
    highlights: z.array(Highlight),
    /**
     * The database's identity. It changes when the database is replaced (a
     * backup restored): a client that saw another one must sync from 0.
     */
    generation: z.string(),
    /** The newest seq on the server. */
    serverSeq: z.number().int(),
  })
  .meta({ id: "SyncResponse" });

/** A site, as typed (`example.com`, or an address on it); stored as its bare domain. */
export const SiteDomain = z
  .string()
  .max(253)
  .transform((s, ctx) => {
    const d = siteDomain(s);
    if (!d) ctx.addIssue({ code: "custom", message: `not a site: ${s}` });
    return d ?? "";
  });

const skipDomains =
  "Sites whose pages the server doesn't read: their bookmarks open as the page itself, " +
  "and a subdomain counts as its site (`x.com` covers `mobile.x.com`)";

/** Settings kept on the server, shared by every client. */
export const Settings = z
  .object({ skipDomains: z.array(z.string()).describe(skipDomains) })
  .meta({ id: "Settings" });
export type Settings = z.infer<typeof Settings>;

export const UpdateSettings = z
  .object({ skipDomains: z.array(SiteDomain).max(1000).describe(skipDomains) })
  .partial()
  .meta({ id: "UpdateSettings" });
export type UpdateSettings = z.infer<typeof UpdateSettings>;

export const ApiError = z
  .object({
    error: z.string(),
    /**
     * Stable machine-readable code: INVALID_REQUEST, UNAUTHORIZED, FORBIDDEN,
     * NOT_FOUND, CONFLICT, SEQ_CONFLICT, PAYLOAD_TOO_LARGE,
     * UNSUPPORTED_MEDIA_TYPE, SEARCH_UNAVAILABLE, INTERNAL_ERROR; for
     * `GET /v1/bookmarks/{id}/content` also CONTENT_PENDING (409),
     * CONTENT_FAILED and CONTENT_SKIPPED (422), CONTENT_NOT_FOUND (404).
     */
    code: z.string().optional(),
    details: z.unknown().optional(),
  })
  .meta({ id: "ApiError" });

export const ImportReport = z
  .object({
    /** Data rows in the file. */
    total: z.number().int(),
    /** New bookmarks (or ones revived from trash). */
    created: z.number().int(),
    /** URLs that were already saved; tags merged and provided fields applied. */
    merged: z.number().int(),
    skipped: z.array(z.object({ row: z.number().int(), url: z.string(), reason: z.string() })),
    collectionsCreated: z.array(z.string()),
    highlightsAdded: z.number().int(),
    /** Pages queued for fetching and extraction (runs in the background). */
    queued: z.number().int(),
    durationMs: z.number(),
  })
  .meta({ id: "ImportReport" });
export type ImportReport = z.infer<typeof ImportReport>;

/** Waiting for a page to be read before answering (`POST /v1/bookmarks`, refetch). */
export const WaitQuery = z.object({
  /** Wait up to 10 s for extraction to finish. */
  wait: boolParam.optional(),
  /** Wait up to this many milliseconds (0..15000) for extraction to finish. */
  waitMs: z.coerce.number().int().min(0).max(15_000).optional(),
});

export const RefetchBookmark = z
  .object({
    /** The page as the client's browser rendered it; the server doesn't fetch it then. */
    html: z
      .string()
      .max(20 * 1024 * 1024)
      .optional(),
  })
  .meta({ id: "RefetchBookmark" });

export const BatchBookmarks = z
  .object({
    ids: z.array(id).min(1).max(200),
    /** Applied to each (not `expectedSeq`). */
    patch: UpdateBookmark.optional(),
    /** true deletes them all (for good: not the Trash). */
    delete: z.boolean().optional(),
  })
  .meta({ id: "BatchBookmarks" });

export const BatchResult = z
  .object({
    updated: z.number().int(),
    deleted: z.number().int(),
    /** Ids with no live bookmark. */
    missingIds: z.array(z.string()),
  })
  .meta({ id: "BatchResult" });

export const LookupBookmarks = z
  .object({
    urls: z.array(z.string().min(1).max(8192)).min(1).max(200),
    /** Bookmarks in the Trash count too (left out by default). */
    includeTrashed: z.boolean().optional(),
  })
  .meta({ id: "LookupBookmarks" });

export const LookupResult = z
  .object({
    /** Each URL as given: its bookmark, or null (none, or not an http(s) URL). */
    items: z.record(z.string(), Bookmark.nullable()),
  })
  .meta({ id: "LookupResult" });

export const HighlightWithBookmark = Highlight.extend({
  bookmarkTitle: z.string(),
  bookmarkUrl: z.string(),
  bookmarkDomain: z.string(),
}).meta({ id: "HighlightWithBookmark" });

export const ListHighlightsQuery = z.object({
  bookmarkId: z.string().optional(),
  color: z.string().max(32).optional(),
  hasNote: boolParam.optional(),
  /** Of bookmarks with this tag. */
  tag: TagName.optional(),
  /** Of bookmarks in this collection (`unsorted`: in none). */
  collectionId: z.string().optional(),
  /** Of bookmarks outside the Trash (false, the default), in it (true), or both (all). */
  trashed: trashedParam,
  /** Text in the quote or the note (case-insensitive). */
  q: z.string().max(1000).optional(),
  createdAfter: isoDate.optional(),
  createdBefore: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const HighlightPage = z
  .object({ items: z.array(HighlightWithBookmark), nextCursor: z.string().nullable() })
  .meta({ id: "HighlightPage" });

/** Bookmarks in the Trash count too (left out by default). */
export const IncludeTrashedParam = boolParam
  .optional()
  .describe("Bookmarks in the Trash count too (left out by default)");

export const ListTagsQuery = z.object({ includeTrashed: IncludeTrashedParam });

export const Stats = z
  .object({
    bookmarks: z.object({
      /** Live bookmarks, the Trash included. */
      total: z.number().int(),
      /** Not in the Trash. */
      active: z.number().int(),
      unsorted: z.number().int(),
      favorites: z.number().int(),
      trashed: z.number().int(),
      withHighlights: z.number().int(),
      /** Of the active ones. */
      byType: z.record(z.string(), z.number().int()),
      byContentStatus: z.record(z.string(), z.number().int()),
    }),
    /** Live highlights of active bookmarks. */
    highlights: z.number().int(),
    collections: z.number().int(),
    /** Tags on active bookmarks. */
    tags: z.number().int(),
  })
  .meta({ id: "Stats" });

export const TokenScope = z.enum(["read", "write", "delete", "admin"]);
export type TokenScope = z.infer<typeof TokenScope>;

export const Capabilities = z
  .object({
    version: z.string(),
    commit: z.string(),
    /** What answers `/v1/search`. */
    search: z.enum(["meilisearch", "sqlite"]),
    semanticSearch: z.boolean(),
    /** A headless browser renders pages plain fetching can't read. */
    browserExtraction: z.boolean(),
    /** PDFs' text is extracted (poppler). */
    pdfExtraction: z.boolean(),
    /** What the calling token may do. */
    scopes: z.array(TokenScope),
  })
  .meta({ id: "Capabilities" });
