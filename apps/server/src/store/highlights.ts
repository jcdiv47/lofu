import type { Highlight } from "@lofu/shared";
import type { Db } from "../db/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";
import { type BookmarkStore, decodeCursor, encodeCursor } from "./bookmarks.ts";
import type { Hooks } from "./hooks.ts";
import { type HighlightRow, toHighlight } from "./rows.ts";

export interface HighlightInput {
  id?: string | undefined;
  quote: string;
  prefix: string;
  suffix: string;
  note?: string | null | undefined;
  color?: string | null | undefined;
}

export interface HighlightFilter {
  bookmarkId?: string | undefined;
  color?: string | undefined;
  hasNote?: boolean | undefined;
  tag?: string | undefined;
  collectionId?: string | undefined;
  archived?: boolean | undefined;
  q?: string | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

const isoMs = (s: string) => {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new BadRequestError(`not a date: ${s}`);
  return t;
};

export class HighlightStore {
  constructor(
    private db: Db,
    private bookmarks: BookmarkStore,
    private hooks: Hooks,
  ) {}

  listFor(bookmarkId: string): Highlight[] {
    this.bookmarks.get(bookmarkId);
    return this.db
      .query<HighlightRow, [string]>(
        "SELECT * FROM highlights WHERE bookmark_id = ? AND deleted_at IS NULL ORDER BY created_at",
      )
      .all(bookmarkId)
      .map(toHighlight);
  }

  /**
   * Live highlights of live bookmarks, newest first, with their bookmark's
   * title, URL and domain (keyset pagination on created_at, id).
   */
  list(f: HighlightFilter) {
    const where = ["h.deleted_at IS NULL", "b.deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (f.bookmarkId !== undefined) {
      where.push("h.bookmark_id = ?");
      params.push(f.bookmarkId);
    }
    if (f.color !== undefined) {
      where.push("h.color = ?");
      params.push(f.color);
    }
    if (f.hasNote !== undefined) {
      where.push(`${f.hasNote ? "" : "NOT "}(h.note IS NOT NULL AND trim(h.note) != '')`);
    }
    if (f.tag !== undefined) {
      where.push("h.bookmark_id IN (SELECT bookmark_id FROM bookmark_tags WHERE tag = ?)");
      params.push(f.tag);
    }
    if (f.collectionId !== undefined) {
      if (f.collectionId === "unsorted") where.push("b.collection_id IS NULL");
      else {
        where.push("b.collection_id = ?");
        params.push(f.collectionId);
      }
    }
    if (f.archived !== undefined) {
      where.push("b.archived = ?");
      params.push(f.archived ? 1 : 0);
    }
    if (f.q?.trim()) {
      const q = f.q.trim().toLowerCase();
      where.push("(instr(lower(h.quote), ?) > 0 OR instr(lower(coalesce(h.note, '')), ?) > 0)");
      params.push(q, q);
    }
    if (f.createdAfter !== undefined) {
      where.push("h.created_at >= ?");
      params.push(isoMs(f.createdAfter));
    }
    if (f.createdBefore !== undefined) {
      where.push("h.created_at < ?");
      params.push(isoMs(f.createdBefore));
    }
    if (f.cursor) {
      const [t, id] = decodeCursor(f.cursor);
      where.push("(h.created_at, h.id) < (?, ?)");
      params.push(t, id);
    }
    const rows = this.db
      .query<
        HighlightRow & { bookmark_title: string; bookmark_url: string; bookmark_domain: string },
        (string | number)[]
      >(
        `SELECT h.*, b.title AS bookmark_title, b.url AS bookmark_url, b.domain AS bookmark_domain
         FROM highlights h JOIN bookmarks b ON b.id = h.bookmark_id
         WHERE ${where.join(" AND ")}
         ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
      )
      .all(...params, f.limit + 1);
    const hasMore = rows.length > f.limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((r) => ({
        ...toHighlight(r),
        bookmarkTitle: r.bookmark_title,
        bookmarkUrl: r.bookmark_url,
        bookmarkDomain: r.bookmark_domain,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  get(id: string): Highlight {
    const row = this.db
      .query<HighlightRow, [string]>("SELECT * FROM highlights WHERE id = ?")
      .get(id);
    if (!row || row.deleted_at !== null) throw new NotFoundError(`highlight ${id} not found`);
    return toHighlight(row);
  }

  /**
   * Adds a highlight. Idempotent on a client's id: sending one again for the
   * same bookmark returns the highlight it made (`created: false`).
   */
  create(bookmarkId: string, h: HighlightInput): { highlight: Highlight; created: boolean } {
    this.bookmarks.get(bookmarkId);
    if (h.id !== undefined) {
      const had = this.db
        .query<HighlightRow, [string]>("SELECT * FROM highlights WHERE id = ?")
        .get(h.id);
      if (had) {
        if (had.bookmark_id === bookmarkId && had.deleted_at === null) {
          return { highlight: toHighlight(had), created: false };
        }
        throw new ConflictError(`highlight ${h.id} already exists`);
      }
    }
    const id = h.id ?? Bun.randomUUIDv7();
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO highlights (id, bookmark_id, quote, prefix, suffix, note, color, created_at, updated_at, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          bookmarkId,
          h.quote,
          h.prefix,
          h.suffix,
          h.note ?? null,
          h.color ?? null,
          now,
          now,
          this.db.nextSeq(),
        );
      this.bookmarks.touch(bookmarkId); // highlights are part of the bookmark's search document
    })();
    this.hooks.changed();
    return { highlight: this.get(id), created: true };
  }

  update(
    id: string,
    patch: { note?: string | null | undefined; color?: string | null | undefined },
  ): Highlight {
    const cur = this.get(id);
    this.db.transaction(() => {
      this.db
        .query("UPDATE highlights SET note = ?, color = ?, updated_at = ?, seq = ? WHERE id = ?")
        .run(
          patch.note !== undefined ? patch.note : cur.note,
          patch.color !== undefined ? patch.color : cur.color,
          Date.now(),
          this.db.nextSeq(),
          id,
        );
      this.bookmarks.touch(cur.bookmarkId);
    })();
    this.hooks.changed();
    return this.get(id);
  }

  delete(id: string): void {
    const cur = this.get(id);
    this.db.transaction(() => {
      const now = Date.now();
      this.db
        .query("UPDATE highlights SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ?")
        .run(now, now, this.db.nextSeq(), id);
      this.bookmarks.touch(cur.bookmarkId);
    })();
    this.hooks.changed();
  }
}
