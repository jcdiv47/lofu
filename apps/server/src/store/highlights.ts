import type { Highlight } from "@lofu/shared";
import type { Db } from "../db/index.ts";
import { type BookmarkStore, NotFoundError } from "./bookmarks.ts";
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

  get(id: string): Highlight {
    const row = this.db
      .query<HighlightRow, [string]>("SELECT * FROM highlights WHERE id = ?")
      .get(id);
    if (!row || row.deleted_at !== null) throw new NotFoundError(`highlight ${id} not found`);
    return toHighlight(row);
  }

  create(bookmarkId: string, h: HighlightInput): Highlight {
    this.bookmarks.get(bookmarkId);
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
    return this.get(id);
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
