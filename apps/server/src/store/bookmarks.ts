import {
  type Bookmark,
  type BookmarkType,
  type ContentStatus,
  type CreateBookmark,
  domainOf,
  normalizeUrl,
  type UpdateBookmark,
} from "@lofu/shared";
import type { Db } from "../db/index.ts";
import type { ImageProxy, ImageSizes } from "../extract/images.ts";
import type { Hooks } from "./hooks.ts";
import { type JobStore, Priority } from "./jobs.ts";
import { type BookmarkRow, toBookmark } from "./rows.ts";

export class NotFoundError extends Error {}

/** Extra fields importers can set that the public create API doesn't expose. */
export interface ImportFields {
  excerpt?: string | null | undefined;
  coverUrl?: string | null | undefined;
}
export class ConflictError extends Error {}

export interface ListFilter {
  collectionId?: string | undefined;
  tags?: string[] | undefined;
  archived?: boolean | undefined;
  favorite?: boolean | undefined;
  type?: BookmarkType | undefined;
  contentStatus?: ContentStatus | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface ExtractedContent {
  html: Uint8Array; // zstd
  markdown: Uint8Array; // zstd
  text: Uint8Array; // zstd
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

const UPDATE_COLUMNS = {
  title: "title",
  note: "note",
  tags: "tags",
  collectionId: "collection_id",
  favorite: "favorite",
  archived: "archived",
  readProgress: "read_progress",
  coverUrl: "cover_url",
  sort: "sort",
} as const satisfies Record<keyof UpdateBookmark, string>;

const encodeCursor = (createdAt: number, id: string) =>
  Buffer.from(`${createdAt}:${id}`).toString("base64url");

function decodeCursor(cursor: string): [number, string] {
  const s = Buffer.from(cursor, "base64url").toString();
  const i = s.indexOf(":");
  const t = Number(s.slice(0, i));
  if (i < 0 || !Number.isFinite(t)) throw new RangeError("invalid cursor");
  return [t, s.slice(i + 1)];
}

const dedupeTags = (tags: readonly string[]) => [...new Set(tags)];
const sqlBool = (b: boolean | undefined) => (b === undefined ? undefined : b ? 1 : 0);

export class BookmarkStore {
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

  /** Finds a live bookmark by URL, compared after normalization. */
  findByUrl(url: string): Bookmark {
    const row = this.db
      .query<BookmarkRow, [string]>(
        "SELECT * FROM bookmarks WHERE url_key = ? AND deleted_at IS NULL",
      )
      .get(normalizeUrl(url));
    if (!row) throw new NotFoundError("no bookmark for this URL");
    return toBookmark(row, this.images);
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

  /**
   * Idempotent save keyed on the normalized URL. Re-saving an existing URL
   * merges tags and applies any provided fields instead of duplicating; saving
   * a previously deleted URL revives the original row (same id).
   */
  create(
    input: CreateBookmark & ImportFields,
    opts: { priority?: Priority } = {},
  ): { bookmark: Bookmark; created: boolean } {
    const priority = opts.priority ?? Priority.interactive;
    const urlKey = normalizeUrl(input.url);
    const now = Date.now();
    const createdAt = input.createdAt ? Date.parse(input.createdAt) : now;

    const result = this.db.transaction(() => {
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
            input.title ?? "",
            input.title ? 1 : 0,
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
      this.db
        .query(
          `UPDATE bookmarks SET
             title = coalesce(?, title), title_locked = max(title_locked, ?),
             note = coalesce(?, note), tags = ?,
             excerpt = coalesce(excerpt, ?), cover_url = coalesce(cover_url, ?),
             collection_id = CASE WHEN ? THEN ? ELSE collection_id END,
             favorite = coalesce(?, favorite), archived = coalesce(?, archived),
             deleted_at = NULL, updated_at = ?, seq = ?
           WHERE id = ?`,
        )
        .run(
          input.title ?? null,
          input.title ? 1 : 0,
          input.note ?? null,
          JSON.stringify(tags),
          input.excerpt ?? null,
          input.coverUrl ?? null,
          input.collectionId !== undefined ? 1 : 0,
          input.collectionId ?? null,
          sqlBool(input.favorite) ?? (revived ? 0 : null),
          sqlBool(input.archived) ?? (revived ? 0 : null),
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

  update(id: string, patch: UpdateBookmark): Bookmark {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [key, col] of Object.entries(UPDATE_COLUMNS) as [keyof UpdateBookmark, string][]) {
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      if (key === "tags") params.push(JSON.stringify(dedupeTags(v as string[])));
      else if (typeof v === "boolean") params.push(v ? 1 : 0);
      else params.push(v as string | number | null);
    }
    if (patch.title !== undefined) sets.push("title_locked = 1");
    if (sets.length === 0) return this.get(id);

    const changes = this.db
      .query(
        `UPDATE bookmarks SET ${sets.join(", ")}, updated_at = ?, seq = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(...params, Date.now(), this.db.nextSeq(), id).changes;
    if (changes === 0) throw new NotFoundError(`bookmark ${id} not found`);
    this.hooks.changed();
    return this.get(id);
  }

  /** Soft delete: leaves a tombstone for sync, drops the content blob. */
  delete(id: string): void {
    this.db.transaction(() => {
      const now = Date.now();
      const changes = this.db
        .query(
          "UPDATE bookmarks SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .run(now, now, this.db.nextSeq(), id).changes;
      if (changes === 0) throw new NotFoundError(`bookmark ${id} not found`);
      this.db.query("DELETE FROM contents WHERE bookmark_id = ?").run(id);
      this.jobs.cancel("extract", id);
      this.jobs.cancel("images", id);
    })();
    this.hooks.changed();
  }

  list(f: ListFilter): { items: Bookmark[]; nextCursor: string | null } {
    const where = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (f.collectionId !== undefined) {
      // "unsorted" is the pseudo-collection of bookmarks with no collection.
      if (f.collectionId === "unsorted") where.push("collection_id IS NULL");
      else {
        where.push("collection_id = ?");
        params.push(f.collectionId);
      }
    }
    if (f.archived !== undefined) {
      where.push("archived = ?");
      params.push(f.archived ? 1 : 0);
    }
    if (f.favorite !== undefined) {
      where.push("favorite = ?");
      params.push(f.favorite ? 1 : 0);
    }
    if (f.type !== undefined) {
      where.push("type = ?");
      params.push(f.type);
    }
    if (f.contentStatus !== undefined) {
      where.push("content_status = ?");
      params.push(f.contentStatus);
    }
    if (f.tags?.length) {
      // AND semantics; json_each keeps a single cached statement shape for any tag count.
      const tags = dedupeTags(f.tags);
      where.push(`id IN (SELECT bookmark_id FROM bookmark_tags
        WHERE tag IN (SELECT value FROM json_each(?)) GROUP BY bookmark_id HAVING count(*) = ?)`);
      params.push(JSON.stringify(tags), tags.length);
    }
    if (f.cursor) {
      const [t, cid] = decodeCursor(f.cursor);
      where.push("(created_at, id) < (?, ?)");
      params.push(t, cid);
    }
    const rows = this.db
      .query<BookmarkRow, (string | number)[]>(
        `SELECT * FROM bookmarks WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, f.limit + 1);
    const hasMore = rows.length > f.limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((r) => toBookmark(r, this.images)),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  tagCounts(): { name: string; count: number }[] {
    return this.db
      .query<{ name: string; count: number }, []>(
        `SELECT bt.tag AS name, count(*) AS count
         FROM bookmark_tags bt JOIN bookmarks b ON b.id = bt.bookmark_id
         WHERE b.deleted_at IS NULL GROUP BY bt.tag ORDER BY count DESC, name`,
      )
      .all();
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
   */
  saveMarkdown(id: string, extractedAt: number, markdown: Uint8Array, text: Uint8Array): boolean {
    const saved = this.db.transaction(() => {
      const changes = this.db
        .query(
          "UPDATE contents SET markdown = ?, text = ? WHERE bookmark_id = ? AND extracted_at = ?",
        )
        .run(markdown, text, id, extractedAt).changes;
      if (changes === 0) return false;
      // Measured again for images the new Markdown gained; the old sizes serve until then.
      this.jobs.enqueue("images", id, null, Priority.bulk);
      this.touch(id);
      return true;
    })();
    if (saved) this.hooks.changed();
    return saved;
  }

  /** Called by the extract job with results computed off-thread. */
  saveExtraction(
    id: string,
    c: ExtractedContent,
    outcome: { status: "ok" } | { status: "failed"; error: string } = { status: "ok" },
  ): boolean {
    const now = Date.now();
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
      this.jobs.enqueue("images", id);
      this.db
        .query(
          `UPDATE bookmarks SET
             title = CASE WHEN title_locked = 1 OR ? IS NULL THEN title ELSE ? END,
             excerpt = coalesce(excerpt, ?), cover_url = coalesce(cover_url, ?),
             favicon_url = coalesce(?, favicon_url), type = ?, word_count = ?, lang = ?,
             author = ?, published_at = ?, content_status = ?, content_error = ?,
             updated_at = ?, seq = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(
          c.title,
          c.title,
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
  }

  /** Re-runs extraction (e.g. after a failure or a site redesign). */
  refetch(id: string): Bookmark {
    this.db.transaction(() => {
      const changes = this.db
        .query(
          `UPDATE bookmarks SET content_status = 'pending', content_error = NULL, updated_at = ?, seq = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(Date.now(), this.db.nextSeq(), id).changes;
      if (changes === 0) throw new NotFoundError(`bookmark ${id} not found`);
      this.jobs.enqueue("extract", id);
    })();
    this.hooks.changed();
    return this.get(id);
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
