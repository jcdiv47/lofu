import {
  type Bookmark,
  type BookmarkType,
  type ContentStatus,
  type CreateBookmark,
  domainOf,
  normalizeUrl,
  type UpdateBookmark,
  unwrapUrl,
} from "@lofu/shared";
import type { Db } from "../db/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import type { Figure } from "../extract/figures.ts";
import type { ImageProxy, ImageSizes } from "../extract/images.ts";
import type { Hooks } from "./hooks.ts";
import { encodeExtractPayload, type JobStore, Priority } from "./jobs.ts";
import { type BookmarkRow, toBookmark } from "./rows.ts";

export { ConflictError, NotFoundError };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Extra fields importers can set that the public create API doesn't expose. */
export interface ImportFields {
  excerpt?: string | null | undefined;
  coverUrl?: string | null | undefined;
}

/** Narrowing shared by the list, the database search and the stats. */
export interface BookmarkFilter {
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
  /** ISO dates. */
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  ids?: string[] | undefined;
}

export type ListSort = "newest" | "oldest" | "updated" | "manual";

export interface ListFilter extends BookmarkFilter {
  sort?: ListSort | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface ExtractedContent {
  html: Uint8Array; // zstd
  markdown: Uint8Array; // zstd
  text: Uint8Array; // zstd
  /** Inline SVG figures the Markdown points at (extract/figures.ts). */
  figures?: Figure[];
  rawBytes: number;
  extractor: string | null;
  type: BookmarkType;
  title: string | null;
  excerpt: string | null;
  coverUrl: string | null;
  faviconUrl: string | null;
  wordCount: number | null;
  lang: string | null;
  author: string | null;
  publishedAt: string | null;
}

/** The columns a patch sets directly (tags are worked out from tags/addTags/removeTags). */
const UPDATE_COLUMNS = {
  title: "title",
  note: "note",
  collectionId: "collection_id",
  favorite: "favorite",
  archived: "archived",
  readProgress: "read_progress",
  coverUrl: "cover_url",
  sort: "sort",
} as const satisfies Partial<Record<keyof UpdateBookmark, string>>;

const SORTS = {
  newest: { col: "created_at", dir: "DESC", cmp: "<" },
  oldest: { col: "created_at", dir: "ASC", cmp: ">" },
  updated: { col: "updated_at", dir: "DESC", cmp: "<" },
  manual: { col: "sort", dir: "ASC", cmp: ">" },
} as const;

const encodeCursor = (value: number, id: string) =>
  Buffer.from(`${value}:${id}`).toString("base64url");

export function decodeCursor(cursor: string): [number, string] {
  const s = Buffer.from(cursor, "base64url").toString();
  const i = s.indexOf(":");
  const t = Number(s.slice(0, i));
  if (i < 0 || !Number.isFinite(t)) throw new RangeError("invalid cursor");
  return [t, s.slice(i + 1)];
}
export { encodeCursor };

const dedupeTags = (tags: readonly string[]) => [...new Set(tags)];
const sqlBool = (b: boolean | undefined) => (b === undefined ? undefined : b ? 1 : 0);
const isoMs = (s: string) => {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new BadRequestError(`not a date: ${s}`);
  return t;
};

/**
 * WHERE clauses for a filter, on the bookmarks table under alias `b`. Every
 * clause has a fixed shape (lists go in as one JSON parameter), so the
 * statements stay a bounded set.
 */
export function bookmarkWhere(f: BookmarkFilter): { where: string[]; params: (string | number)[] } {
  const where = ["b.deleted_at IS NULL"];
  const params: (string | number)[] = [];
  if (f.collectionId !== undefined) {
    // "unsorted" is the pseudo-collection of bookmarks with no collection.
    if (f.collectionId === "unsorted") where.push("b.collection_id IS NULL");
    else if (f.includeSubcollections) {
      where.push(`b.collection_id IN (
        WITH RECURSIVE sub(id) AS (
          SELECT ? UNION
          SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id WHERE c.deleted_at IS NULL)
        SELECT id FROM sub)`);
      params.push(f.collectionId);
    } else {
      where.push("b.collection_id = ?");
      params.push(f.collectionId);
    }
  }
  if (f.archived !== undefined) {
    where.push("b.archived = ?");
    params.push(f.archived ? 1 : 0);
  }
  if (f.favorite !== undefined) {
    where.push("b.favorite = ?");
    params.push(f.favorite ? 1 : 0);
  }
  if (f.type !== undefined) {
    where.push("b.type = ?");
    params.push(f.type);
  }
  if (f.contentStatus !== undefined) {
    where.push("b.content_status = ?");
    params.push(f.contentStatus);
  }
  if (f.domain !== undefined) {
    where.push("b.domain = ?");
    params.push(
      f.domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, ""),
    );
  }
  if (f.hasNote !== undefined) {
    where.push(`${f.hasNote ? "" : "NOT "}(b.note IS NOT NULL AND trim(b.note) != '')`);
  }
  if (f.hasHighlights !== undefined) {
    where.push(
      `${f.hasHighlights ? "" : "NOT "}EXISTS (SELECT 1 FROM highlights h
        WHERE h.bookmark_id = b.id AND h.deleted_at IS NULL)`,
    );
  }
  if (f.untagged !== undefined) {
    where.push(
      `${f.untagged ? "NOT " : ""}EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id)`,
    );
  }
  if (f.createdAfter !== undefined) {
    where.push("b.created_at >= ?");
    params.push(isoMs(f.createdAfter));
  }
  if (f.createdBefore !== undefined) {
    where.push("b.created_at < ?");
    params.push(isoMs(f.createdBefore));
  }
  if (f.tags?.length) {
    // AND semantics; json_each keeps a single cached statement shape for any tag count.
    const tags = dedupeTags(f.tags);
    where.push(`b.id IN (SELECT bookmark_id FROM bookmark_tags
      WHERE tag IN (SELECT value FROM json_each(?)) GROUP BY bookmark_id HAVING count(*) = ?)`);
    params.push(JSON.stringify(tags), tags.length);
  }
  if (f.ids !== undefined) {
    where.push("b.id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(f.ids));
  }
  return { where, params };
}

/** How long a save or refetch waits for its page, at most (`?wait=true`). */
export const DEFAULT_WAIT_MS = 10_000;

export class BookmarkStore {
  /** Callers waiting for a bookmark's extraction to settle (see `waitForExtraction`). */
  private waiters = new Map<string, Set<() => void>>();

  constructor(
    private db: Db,
    private jobs: JobStore,
    private hooks: Hooks,
    private images: ImageProxy,
  ) {}

  get(id: string): Bookmark {
    const row = this.db
      .query<BookmarkRow, [string]>("SELECT * FROM bookmarks WHERE id = ?")
      .get(id);
    if (!row || row.deleted_at !== null) throw new NotFoundError(`bookmark ${id} not found`);
    return toBookmark(row, this.images);
  }

  /** The live row, or NotFoundError. */
  private liveRow(id: string): BookmarkRow {
    const row = this.db
      .query<BookmarkRow, [string]>("SELECT * FROM bookmarks WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    if (!row) throw new NotFoundError(`bookmark ${id} not found`);
    return row;
  }

  /** Finds a live bookmark by URL, compared after unwrapping and normalization. */
  findByUrl(url: string): Bookmark {
    const row = this.db
      .query<BookmarkRow, [string]>(
        "SELECT * FROM bookmarks WHERE url_key = ? AND deleted_at IS NULL",
      )
      .get(normalizeUrl(unwrapUrl(url)));
    if (!row) throw new NotFoundError("no bookmark for this URL");
    return toBookmark(row, this.images);
  }

  /**
   * The live bookmark of each URL (null for none, or for what isn't an
   * http(s) URL), keyed by the URL as given. One query for them all.
   */
  findManyByUrl(urls: readonly string[]): Record<string, Bookmark | null> {
    const keys = new Map<string, string>();
    for (const url of urls) {
      try {
        keys.set(url, normalizeUrl(unwrapUrl(url)));
      } catch {
        // Not an http(s) URL: no bookmark.
      }
    }
    const rows = this.db
      .query<BookmarkRow, [string]>(
        `SELECT * FROM bookmarks
         WHERE url_key IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
      )
      .all(JSON.stringify([...new Set(keys.values())]));
    const byKey = new Map(rows.map((r) => [r.url_key, r]));
    const out: Record<string, Bookmark | null> = {};
    for (const url of urls) {
      const row = byKey.get(keys.get(url) ?? "");
      out[url] = row ? toBookmark(row, this.images) : null;
    }
    return out;
  }

  /** Bulk fetch preserving the order of `ids`; missing/deleted ids are skipped. */
  getMany(ids: readonly string[]): Bookmark[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .query<BookmarkRow, [string]>(
        "SELECT * FROM bookmarks WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
      )
      .all(JSON.stringify(ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: Bookmark[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r) out.push(toBookmark(r, this.images));
    }
    return out;
  }

  /** A bookmark may only be filed in a live collection (as a collection's parent must be). */
  private assertCollection(id: string | null | undefined): void {
    if (!id) return;
    const live = this.db
      .query<{ x: number }, [string]>(
        "SELECT 1 AS x FROM collections WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id);
    if (!live) throw new NotFoundError(`collection ${id} not found`);
  }

  /**
   * Idempotent save keyed on the normalized URL. Re-saving an existing URL
   * merges tags and applies any provided fields instead of duplicating; saving
   * a previously deleted URL revives the original row (same id). Saving one
   * in the Trash takes it out, unless `archived` says otherwise (or, for an
   * importer, `restoreFromTrash: false`).
   */
  create(
    input: CreateBookmark & ImportFields,
    opts: { priority?: Priority; restoreFromTrash?: boolean } = {},
  ): { bookmark: Bookmark; created: boolean } {
    const priority = opts.priority ?? Priority.interactive;
    const urlKey = normalizeUrl(input.url);
    const now = Date.now();
    const createdAt = input.createdAt ? Date.parse(input.createdAt) : now;
    // An empty title is no title: it must not replace the one it has.
    const title = input.title?.trim() ? input.title : undefined;

    const result = this.db.transaction(() => {
      this.assertCollection(input.collectionId);
      const existing = this.db
        .query<BookmarkRow, [string]>("SELECT * FROM bookmarks WHERE url_key = ?")
        .get(urlKey);
      const seq = this.db.nextSeq();

      if (!existing) {
        const id = input.id ?? Bun.randomUUIDv7();
        this.db
          .query(
            `INSERT INTO bookmarks (id, url, url_key, title, title_locked, note, excerpt, cover_url,
               domain, tags, collection_id, favorite, archived, sort, created_at, updated_at, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.url,
            urlKey,
            title ?? "",
            title ? 1 : 0,
            input.note ?? null,
            input.excerpt ?? null,
            input.coverUrl ?? null,
            domainOf(input.url),
            JSON.stringify(dedupeTags(input.tags ?? [])),
            input.collectionId ?? null,
            input.favorite ? 1 : 0,
            input.archived ? 1 : 0,
            // New ones go on top of the manual order, as they come.
            -createdAt,
            createdAt,
            now,
            seq,
          );
        this.jobs.enqueue("extract", id, input.html ?? null, priority);
        return { id, created: true };
      }

      const revived = existing.deleted_at !== null;
      const tags = revived
        ? dedupeTags(input.tags ?? [])
        : dedupeTags([...(JSON.parse(existing.tags) as string[]), ...(input.tags ?? [])]);
      const restore = revived || opts.restoreFromTrash !== false;
      this.db
        .query(
          `UPDATE bookmarks SET
             title = coalesce(?, title), title_locked = max(title_locked, ?),
             note = coalesce(?, note), tags = ?,
             excerpt = coalesce(excerpt, ?), cover_url = coalesce(cover_url, ?),
             collection_id = CASE WHEN ? THEN ?
               -- A tombstone may still name a collection deleted since.
               WHEN collection_id IN (SELECT id FROM collections WHERE deleted_at IS NOT NULL) THEN NULL
               ELSE collection_id END,
             favorite = coalesce(?, favorite), archived = coalesce(?, archived),
             deleted_at = NULL, updated_at = ?, seq = ?
           WHERE id = ?`,
        )
        .run(
          title ?? null,
          title ? 1 : 0,
          input.note ?? null,
          JSON.stringify(tags),
          input.excerpt ?? null,
          input.coverUrl ?? null,
          input.collectionId !== undefined ? 1 : 0,
          input.collectionId ?? null,
          sqlBool(input.favorite) ?? (revived ? 0 : null),
          sqlBool(input.archived) ?? (restore ? 0 : null),
          now,
          seq,
          existing.id,
        );
      if (revived || input.html || existing.content_status === "failed") {
        this.jobs.enqueue("extract", existing.id, input.html ?? null, priority);
      }
      return { id: existing.id, created: revived };
    })();

    this.hooks.changed();
    return { bookmark: this.get(result.id), created: result.created };
  }

  /**
   * Applies a patch to a live row, within the caller's transaction. Returns
   * false (and writes nothing) when the patch sets nothing.
   */
  private applyPatch(row: BookmarkRow, patch: UpdateBookmark, now: number): boolean {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [key, col] of Object.entries(UPDATE_COLUMNS) as [keyof UpdateBookmark, string][]) {
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      if (typeof v === "boolean") params.push(v ? 1 : 0);
      else params.push(v as string | number | null);
    }
    if (patch.tags !== undefined || patch.addTags?.length || patch.removeTags?.length) {
      let tags = patch.tags ?? (JSON.parse(row.tags) as string[]);
      if (patch.addTags) tags = [...tags, ...patch.addTags];
      if (patch.removeTags) {
        const drop = new Set(patch.removeTags);
        tags = tags.filter((t) => !drop.has(t));
      }
      tags = dedupeTags(tags);
      if (tags.length > 100) throw new BadRequestError("a bookmark has at most 100 tags");
      sets.push("tags = ?");
      params.push(JSON.stringify(tags));
    }
    if (patch.title !== undefined) sets.push("title_locked = 1");
    if (sets.length === 0) return false;
    this.db
      .query(`UPDATE bookmarks SET ${sets.join(", ")}, updated_at = ?, seq = ? WHERE id = ?`)
      .run(...params, now, this.db.nextSeq(), row.id);
    return true;
  }

  private static checkPatch(patch: UpdateBookmark): void {
    if (patch.tags !== undefined && (patch.addTags !== undefined || patch.removeTags !== undefined))
      throw new BadRequestError("tags replaces every tag: not with addTags or removeTags");
  }

  /**
   * Updates a live bookmark. With `expectedSeq` (in the patch, or an
   * If-Match header) it is refused when the bookmark changed since.
   */
  update(id: string, patch: UpdateBookmark, opts: { expectedSeq?: number } = {}): Bookmark {
    BookmarkStore.checkPatch(patch);
    const expected = patch.expectedSeq ?? opts.expectedSeq;
    const changed = this.db.transaction(() => {
      const row = this.liveRow(id);
      if (expected !== undefined && row.seq !== expected) {
        throw new ConflictError(
          `bookmark ${id} changed since seq ${expected} (now ${row.seq})`,
          "SEQ_CONFLICT",
          { seq: row.seq },
        );
      }
      if (patch.collectionId !== undefined) this.assertCollection(patch.collectionId);
      return this.applyPatch(row, patch, Date.now());
    })();
    if (changed) this.hooks.changed();
    return this.get(id);
  }

  /**
   * One patch for many bookmarks, or deletes them, in one transaction. Each
   * changed bookmark gets its own seq. Ids with no live bookmark are reported.
   */
  batch(
    ids: readonly string[],
    op: { patch: UpdateBookmark } | { delete: true },
  ): { updated: number; deleted: number; missingIds: string[] } {
    if ("patch" in op) {
      BookmarkStore.checkPatch(op.patch);
      if (op.patch.expectedSeq !== undefined)
        throw new BadRequestError("expectedSeq is for one bookmark, not a batch");
    }
    const unique = [...new Set(ids)];
    const result = this.db.transaction(() => {
      const rows = new Map(
        this.db
          .query<BookmarkRow, [string]>(
            `SELECT * FROM bookmarks
             WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
          )
          .all(JSON.stringify(unique))
          .map((r) => [r.id, r]),
      );
      const missingIds = unique.filter((id) => !rows.has(id));
      const now = Date.now();
      let updated = 0;
      let deleted = 0;
      if ("patch" in op) {
        if (op.patch.collectionId !== undefined) this.assertCollection(op.patch.collectionId);
        for (const row of rows.values()) if (this.applyPatch(row, op.patch, now)) updated++;
      } else {
        for (const id of rows.keys()) if (this.softDelete(id, now)) deleted++;
      }
      return { updated, deleted, missingIds };
    })();
    if (result.updated + result.deleted > 0) this.hooks.changed();
    if (result.deleted > 0) for (const id of unique) this.settle(id);
    return result;
  }

  /**
   * Soft delete within the caller's transaction: a tombstone for sync, the
   * content dropped, its jobs cancelled and its highlights tombstoned too.
   */
  private softDelete(id: string, now: number): boolean {
    const changes = this.db
      .query(
        `UPDATE bookmarks SET deleted_at = ?, updated_at = ?, extracted_at = NULL, seq = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, this.db.nextSeq(), id).changes;
    if (changes === 0) return false;
    this.db.query("DELETE FROM contents WHERE bookmark_id = ?").run(id);
    this.jobs.cancel("extract", id);
    this.jobs.cancel("images", id);
    this.jobs.cancel("markdown", id);
    const live = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM highlights WHERE bookmark_id = ? AND deleted_at IS NULL ORDER BY created_at",
      )
      .all(id);
    const tombstone = this.db.query(
      "UPDATE highlights SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ?",
    );
    for (const h of live) tombstone.run(now, now, this.db.nextSeq(), h.id);
    return true;
  }

  /** Soft delete: leaves a tombstone for sync, drops the content blob. */
  delete(id: string): void {
    this.db.transaction(() => {
      if (!this.softDelete(id, Date.now())) throw new NotFoundError(`bookmark ${id} not found`);
    })();
    this.hooks.changed();
    this.settle(id);
  }

  list(f: ListFilter): { items: Bookmark[]; nextCursor: string | null } {
    const { where, params } = bookmarkWhere(f);
    const sort = SORTS[f.sort ?? "newest"];
    if (f.cursor) {
      const [v, cid] = decodeCursor(f.cursor);
      where.push(`(b.${sort.col}, b.id) ${sort.cmp} (?, ?)`);
      params.push(v, cid);
    }
    const rows = this.db
      .query<BookmarkRow, (string | number)[]>(
        `SELECT b.* FROM bookmarks b WHERE ${where.join(" AND ")}
         ORDER BY b.${sort.col} ${sort.dir}, b.id ${sort.dir} LIMIT ?`,
      )
      .all(...params, f.limit + 1);
    const hasMore = rows.length > f.limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    const key = (r: BookmarkRow) =>
      f.sort === "updated" ? r.updated_at : f.sort === "manual" ? r.sort : r.created_at;
    return {
      items: rows.map((r) => toBookmark(r, this.images)),
      nextCursor: hasMore && last ? encodeCursor(key(last), last.id) : null,
    };
  }

  /**
   * A batch of filtered rows in save order, after a (created_at, id) key, with
   * their live highlight counts: what the database search (search/search.ts)
   * scans.
   */
  scan(
    f: BookmarkFilter,
    order: "newest" | "oldest",
    after: [number, string] | null,
    limit: number,
  ): (BookmarkRow & { highlight_count: number })[] {
    const { where, params } = bookmarkWhere(f);
    const sort = SORTS[order];
    if (after) {
      where.push(`(b.created_at, b.id) ${sort.cmp} (?, ?)`);
      params.push(after[0], after[1]);
    }
    return this.db
      .query<BookmarkRow & { highlight_count: number }, (string | number)[]>(
        `SELECT b.*, (SELECT count(*) FROM highlights h
           WHERE h.bookmark_id = b.id AND h.deleted_at IS NULL) AS highlight_count
         FROM bookmarks b WHERE ${where.join(" AND ")}
         ORDER BY b.created_at ${sort.dir}, b.id ${sort.dir} LIMIT ?`,
      )
      .all(...params, limit);
  }

  /** A live collection's id and those of its live subcollections, at any depth. */
  collectionTree(id: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? UNION
           SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id WHERE c.deleted_at IS NULL)
         SELECT id FROM sub`,
      )
      .all(id)
      .map((r) => r.id);
  }

  /** Tags with the number of bookmarks that have them; the Trash's are left out unless asked. */
  tagCounts(
    opts: { includeTrashed?: boolean | undefined } = {},
  ): { name: string; count: number }[] {
    return this.db
      .query<{ name: string; count: number }, [number]>(
        `SELECT bt.tag AS name, count(*) AS count
         FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id
         WHERE b.deleted_at IS NULL AND (b.archived = 0 OR ?)
         GROUP BY bt.tag ORDER BY count DESC, name`,
      )
      .all(opts.includeTrashed ? 1 : 0);
  }

  /** Counts across the library (GET /v1/stats). */
  stats() {
    const counts = this.db
      .query<
        {
          total: number;
          active: number;
          unsorted: number;
          favorites: number;
          trashed: number;
          withHighlights: number;
        },
        []
      >(
        `SELECT count(*) AS total,
           coalesce(sum(archived = 0), 0) AS active,
           coalesce(sum(archived = 0 AND collection_id IS NULL), 0) AS unsorted,
           coalesce(sum(archived = 0 AND favorite = 1), 0) AS favorites,
           coalesce(sum(archived = 1), 0) AS trashed,
           coalesce(sum(archived = 0 AND EXISTS (SELECT 1 FROM highlights h
             WHERE h.bookmark_id = bookmarks.id AND h.deleted_at IS NULL)), 0) AS withHighlights
         FROM bookmarks WHERE deleted_at IS NULL`,
      )
      .get()!;
    const group = (col: "type" | "content_status") =>
      Object.fromEntries(
        this.db
          .query<{ k: string; n: number }, []>(
            `SELECT ${col} AS k, count(*) AS n FROM bookmarks
             WHERE deleted_at IS NULL AND archived = 0 GROUP BY ${col} ORDER BY ${col}`,
          )
          .all()
          .map((r) => [r.k, r.n]),
      ) as Record<string, number>;
    const one = (sql: string) => this.db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      bookmarks: {
        ...counts,
        byType: group("type"),
        byContentStatus: group("content_status"),
      },
      highlights: one(
        `SELECT count(*) AS n FROM highlights h JOIN bookmarks b ON b.id = h.bookmark_id
         WHERE h.deleted_at IS NULL AND b.deleted_at IS NULL AND b.archived = 0`,
      ),
      collections: one("SELECT count(*) AS n FROM collections WHERE deleted_at IS NULL"),
      tags: one(
        `SELECT count(DISTINCT bt.tag) AS n FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id
         WHERE b.deleted_at IS NULL AND b.archived = 0`,
      ),
    };
  }

  /**
   * Renames a tag on every bookmark that has it. A bookmark that already has
   * `to` keeps one copy (the tags merge). Returns the number of bookmarks changed.
   */
  renameTag(from: string, to: string): number {
    if (from === to) return 0;
    return this.rewriteTag(from, (tags) => dedupeTags(tags.map((t) => (t === from ? to : t))));
  }

  /** Removes a tag from every bookmark. Returns the number of bookmarks changed. */
  deleteTag(tag: string): number {
    return this.rewriteTag(tag, (tags) => tags.filter((t) => t !== tag));
  }

  /**
   * Rewrites the tags of every live bookmark that has `tag`, in one
   * transaction. Like any update, each one gets a new `seq` (sync and the
   * search index see the change) and `updated_at`.
   */
  private rewriteTag(tag: string, edit: (tags: string[]) => string[]): number {
    const changed = this.db.transaction(() => {
      const rows = this.db
        .query<{ id: string; tags: string }, [string]>(
          `SELECT b.id, b.tags FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id
           WHERE bt.tag = ? AND b.deleted_at IS NULL ORDER BY b.seq`,
        )
        .all(tag);
      const now = Date.now();
      const update = this.db.query(
        "UPDATE bookmarks SET tags = ?, updated_at = ?, seq = ? WHERE id = ?",
      );
      for (const r of rows) {
        const tags = edit(JSON.parse(r.tags) as string[]);
        update.run(JSON.stringify(tags), now, this.db.nextSeq(), r.id);
      }
      return rows.length;
    })();
    if (changed > 0) this.hooks.changed();
    return changed;
  }

  /** Raw zstd-compressed content column, or null if not extracted. */
  contentBlob(id: string, format: "html" | "markdown" | "text"): Uint8Array | null {
    const row = this.db
      .query<{ blob: Uint8Array }, [string]>(
        `SELECT ${format} AS blob FROM contents WHERE bookmark_id = ?`,
      )
      .get(id);
    return row?.blob ?? null;
  }

  /** The number of live highlights a bookmark has. */
  highlightCount(id: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM highlights WHERE bookmark_id = ? AND deleted_at IS NULL",
        )
        .get(id)?.n ?? 0
    );
  }

  /** Live highlights' quotes and notes, for snippets. */
  highlightTexts(id: string): { quote: string; note: string | null }[] {
    return this.db
      .query<{ quote: string; note: string | null }, [string]>(
        "SELECT quote, note FROM highlights WHERE bookmark_id = ? AND deleted_at IS NULL ORDER BY created_at",
      )
      .all(id);
  }

  /** Image sizes kept with the content (null: not measured yet, or no content). */
  imageSizes(id: string): ImageSizes | null {
    const row = this.db
      .query<{ images: string | null }, [string]>(
        "SELECT images FROM contents WHERE bookmark_id = ?",
      )
      .get(id);
    return row?.images ? (JSON.parse(row.images) as ImageSizes) : null;
  }

  /** The Markdown the images job measures, and which extraction it came from. */
  markdownForImages(id: string): { markdown: Uint8Array; extractedAt: number } | null {
    return this.db
      .query<{ markdown: Uint8Array; extractedAt: number }, [string]>(
        "SELECT markdown, extracted_at AS extractedAt FROM contents WHERE bookmark_id = ?",
      )
      .get(id);
  }

  /**
   * Saves measured image sizes, unless the page was extracted again in the
   * meantime (that extraction queued its own measuring). Sizes are layout
   * data of the content, which clients fetch on demand and never cache, so
   * this doesn't bump `seq`: it changes neither the synced bookmark nor its
   * search document.
   */
  saveImageSizes(id: string, extractedAt: number, sizes: ImageSizes): void {
    this.db
      .query("UPDATE contents SET images = ? WHERE bookmark_id = ? AND extracted_at = ?")
      .run(JSON.stringify(sizes), id, extractedAt);
  }

  /** Bookmarks whose content was saved before images were measured. */
  unmeasuredImages(): string[] {
    return this.db
      .query<{ id: string }, []>("SELECT bookmark_id AS id FROM contents WHERE images IS NULL")
      .all()
      .map((r) => r.id);
  }

  /**
   * Queues every article converted from HTML for a new Markdown conversion
   * when `version` (extract/markdown.ts) is newer than the one recorded.
   */
  queueMarkdownUpgrade(version: number, plainExtractors: readonly string[]): void {
    this.db.transaction(() => {
      const row = this.db
        .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
        .get("markdown_version");
      if (Number(row?.value ?? 0) >= version) return;
      const ids = this.db
        .query<{ id: string }, [string]>(
          `SELECT bookmark_id AS id FROM contents
           WHERE coalesce(extractor, '') NOT IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(plainExtractors))
        .map((r) => r.id);
      this.jobs.enqueueMissing("markdown", ids);
      this.db
        .query(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run("markdown_version", String(version));
    })();
  }

  /** What the markdown job converts again: the saved article HTML and current Markdown. */
  articleForMarkdown(
    id: string,
  ): { url: string; html: Uint8Array; markdown: Uint8Array; extractedAt: number } | null {
    return this.db
      .query<
        { url: string; html: Uint8Array; markdown: Uint8Array; extractedAt: number },
        [string]
      >(
        `SELECT b.url, c.html, c.markdown, c.extracted_at AS extractedAt
         FROM contents c JOIN bookmarks b ON b.id = c.bookmark_id
         WHERE c.bookmark_id = ? AND b.deleted_at IS NULL`,
      )
      .get(id);
  }

  /**
   * Replaces an article's Markdown and text, unless it was extracted again in
   * the meantime. Bumps `seq`: the text is the bookmark's search document.
   * The bookmark's `extracted_at` moves too: its content changed.
   */
  saveMarkdown(
    id: string,
    extractedAt: number,
    markdown: Uint8Array,
    text: Uint8Array,
    figures: Figure[] = [],
  ): boolean {
    const saved = this.db.transaction(() => {
      const changes = this.db
        .query(
          "UPDATE contents SET markdown = ?, text = ? WHERE bookmark_id = ? AND extracted_at = ?",
        )
        .run(markdown, text, id, extractedAt).changes;
      if (changes === 0) return false;
      this.saveFigures(id, figures);
      // Measured again for images the new Markdown gained; the old sizes serve until then.
      this.jobs.enqueue("images", id, null, Priority.bulk);
      this.db
        .query("UPDATE bookmarks SET extracted_at = ?, seq = ? WHERE id = ?")
        .run(Math.max(Date.now(), extractedAt + 1), this.db.nextSeq(), id);
      return true;
    })();
    if (saved) this.hooks.changed();
    return saved;
  }

  /** Replaces the article's figures (extract/figures.ts); within the caller's transaction. */
  private saveFigures(id: string, figures: Figure[]): void {
    this.db.query("DELETE FROM figures WHERE bookmark_id = ?").run(id);
    const insert = this.db.query(
      "INSERT OR IGNORE INTO figures (bookmark_id, hash, svg, width, height) VALUES (?, ?, ?, ?, ?)",
    );
    for (const f of figures) {
      insert.run(id, f.hash, Bun.zstdCompressSync(enc.encode(f.svg)), f.width, f.height);
    }
  }

  /** A figure's SVG by its hash (any article's: the same picture is the same file). */
  figure(hash: string): string | null {
    const row = this.db
      .query<{ svg: Uint8Array }, [string]>("SELECT svg FROM figures WHERE hash = ? LIMIT 1")
      .get(hash);
    return row ? dec.decode(Bun.zstdDecompressSync(row.svg)) : null;
  }

  /** The sizes of an article's figures, by hash. */
  figureSizes(id: string): Map<string, [number, number]> {
    const rows = this.db
      .query<{ hash: string; width: number; height: number }, [string]>(
        "SELECT hash, width, height FROM figures WHERE bookmark_id = ?",
      )
      .all(id);
    return new Map(rows.map((r) => [r.hash, [r.width, r.height]]));
  }

  /**
   * Called by the extract job with results computed off-thread. With
   * `forceMetadata` (a refetch) a successful extraction's title, excerpt and
   * cover replace the bookmark's, even ones set by hand; a failed one leaves
   * them as they were.
   */
  saveExtraction(
    id: string,
    c: ExtractedContent,
    outcome: { status: "ok" } | { status: "failed"; error: string } = { status: "ok" },
    opts: { forceMetadata?: boolean } = {},
  ): boolean {
    const now = Date.now();
    const force = opts.forceMetadata === true && outcome.status === "ok" ? 1 : 0;
    const saved = this.db.transaction(() => {
      // The bookmark may have been deleted while the page was being fetched.
      const live = this.db
        .query<{ x: number }, [string]>(
          "SELECT 1 AS x FROM bookmarks WHERE id = ? AND deleted_at IS NULL",
        )
        .get(id);
      if (!live) return false;
      this.db
        .query(
          `INSERT INTO contents (bookmark_id, html, markdown, text, raw_bytes, extractor, extracted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (bookmark_id) DO UPDATE SET html = excluded.html, markdown = excluded.markdown,
             text = excluded.text, raw_bytes = excluded.raw_bytes, extractor = excluded.extractor,
             extracted_at = excluded.extracted_at, images = NULL`,
        )
        .run(id, c.html, c.markdown, c.text, c.rawBytes, c.extractor, now);
      this.saveFigures(id, c.figures ?? []);
      this.jobs.enqueue("images", id);
      this.db
        .query(
          `UPDATE bookmarks SET
             title = CASE WHEN ?1 IS NULL OR (title_locked = 1 AND NOT ?2) THEN title ELSE ?1 END,
             title_locked = CASE WHEN ?2 AND ?1 IS NOT NULL THEN 0 ELSE title_locked END,
             excerpt = CASE WHEN ?2 THEN coalesce(?3, excerpt) ELSE coalesce(excerpt, ?3) END,
             cover_url = CASE WHEN ?2 THEN coalesce(?4, cover_url) ELSE coalesce(cover_url, ?4) END,
             favicon_url = coalesce(?5, favicon_url), type = ?6, word_count = ?7, lang = ?8,
             author = ?9, published_at = ?10, content_status = ?11, content_error = ?12,
             extracted_at = ?13, updated_at = ?13, seq = ?14
           WHERE id = ?15 AND deleted_at IS NULL`,
        )
        .run(
          c.title,
          force,
          c.excerpt,
          c.coverUrl,
          c.faviconUrl,
          c.type,
          c.wordCount,
          c.lang,
          c.author,
          c.publishedAt,
          outcome.status,
          outcome.status === "failed" ? outcome.error : null,
          now,
          this.db.nextSeq(),
          id,
        );
      return true;
    })();
    if (saved) this.hooks.changed();
    this.settle(id);
    return saved;
  }

  /** Records a terminal non-article outcome (e.g. a PDF) or a failure. */
  setContentStatus(
    id: string,
    status: "failed" | "skipped",
    opts: { error?: string; type?: BookmarkType; title?: string } = {},
  ): void {
    this.db
      .query(
        `UPDATE bookmarks SET content_status = ?, content_error = ?, type = coalesce(?, type),
           title = CASE WHEN title_locked = 1 OR title != '' OR ? IS NULL THEN title ELSE ? END,
           updated_at = ?, seq = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(
        status,
        opts.error ?? null,
        opts.type ?? null,
        opts.title ?? null,
        opts.title ?? null,
        Date.now(),
        this.db.nextSeq(),
        id,
      );
    this.hooks.changed();
    this.settle(id);
  }

  /**
   * Reads the page again (`html`: as the client's browser has it). Its title,
   * excerpt and cover are taken from the page this time, even ones the user
   * or the saving client set: a client's title is often the interstitial it
   * saw ("Sina Visitor System"). Only once the page is read: if it can't be,
   * they stay as they were, as does a title the page doesn't provide.
   */
  refetch(id: string, opts: { html?: string | undefined } = {}): Bookmark {
    this.db.transaction(() => {
      const changes = this.db
        .query(
          `UPDATE bookmarks SET content_status = 'pending', content_error = NULL, updated_at = ?, seq = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(Date.now(), this.db.nextSeq(), id).changes;
      if (changes === 0) throw new NotFoundError(`bookmark ${id} not found`);
      this.jobs.enqueue(
        "extract",
        id,
        encodeExtractPayload({ html: opts.html ?? null, forceMetadata: true }),
      );
    })();
    this.hooks.changed();
    return this.get(id);
  }

  /**
   * Resolves once the bookmark's extraction settles (read, failed, skipped,
   * or the bookmark deleted), or after `ms`, whichever is first. Resolves at
   * once when no extraction is queued. Event-driven: the store's writes
   * wake the waiters; nothing polls.
   */
  waitForExtraction(id: string, ms: number): Promise<void> {
    if (ms <= 0 || !this.jobs.has("extract", id)) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = () => {
        clearTimeout(timer);
        const s = this.waiters.get(id);
        s?.delete(done);
        if (s?.size === 0) this.waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }

  /** Wakes whoever waits on the bookmark's extraction (the extract job calls it when it's done). */
  settle(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const done of [...set]) done();
  }

  /** Raw row access for the extract job (needs the URL even before extraction). */
  row(id: string): BookmarkRow | null {
    return this.db.query<BookmarkRow, [string]>("SELECT * FROM bookmarks WHERE id = ?").get(id);
  }

  /** Bumps seq so the indexer/sync pick the bookmark up again (e.g. highlight changes). */
  touch(id: string): void {
    this.db.query("UPDATE bookmarks SET seq = ? WHERE id = ?").run(this.db.nextSeq(), id);
  }
}
