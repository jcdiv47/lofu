import type { Collection, CollectionWithCount } from "@lofu/shared";
import type { Db } from "../db/index.ts";
import { NotFoundError } from "../errors.ts";
import type { Hooks } from "./hooks.ts";
import { type CollectionRow, toCollection } from "./rows.ts";

export interface CollectionInput {
  id?: string | undefined;
  name: string;
  parentId?: string | null | undefined;
  sort?: number | undefined;
  color?: string | null | undefined;
}

export class CollectionStore {
  constructor(
    private db: Db,
    private hooks: Hooks,
  ) {}

  /** Live collections, each with its count of live bookmarks outside the Trash. */
  list(): CollectionWithCount[] {
    return this.db
      .query<CollectionRow & { bookmark_count: number }, []>(
        `SELECT c.*, (SELECT count(*) FROM bookmarks b
           WHERE b.collection_id = c.id AND b.deleted_at IS NULL AND b.archived = 0) AS bookmark_count
         FROM collections c WHERE c.deleted_at IS NULL ORDER BY c.parent_id NULLS FIRST, c.sort, c.name`,
      )
      .all()
      .map((r) => ({ ...toCollection(r), bookmarkCount: r.bookmark_count }));
  }

  /** A live collection with its count of live bookmarks outside the Trash. */
  getWithCount(id: string): CollectionWithCount {
    const c = this.get(id);
    const n = this.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM bookmarks WHERE collection_id = ? AND deleted_at IS NULL AND archived = 0",
      )
      .get(id)!.n;
    return { ...c, bookmarkCount: n };
  }

  get(id: string): Collection {
    const row = this.db
      .query<CollectionRow, [string]>("SELECT * FROM collections WHERE id = ?")
      .get(id);
    if (!row || row.deleted_at !== null) throw new NotFoundError(`collection ${id} not found`);
    return toCollection(row);
  }

  create(input: CollectionInput): Collection {
    const id = input.id ?? Bun.randomUUIDv7();
    const now = Date.now();
    if (input.parentId) this.get(input.parentId);
    this.db
      .query(
        `INSERT INTO collections (id, name, parent_id, sort, color, created_at, updated_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.parentId ?? null,
        input.sort ?? now,
        input.color ?? null,
        now,
        now,
        this.db.nextSeq(),
      );
    this.hooks.changed();
    return this.get(id);
  }

  update(id: string, patch: Partial<Omit<CollectionInput, "id">>): Collection {
    const current = this.get(id);
    if (patch.parentId) {
      // Reject cycles: walk up from the new parent and make sure we never hit `id`.
      const hit = this.db
        .query<{ id: string }, [string, string]>(
          `WITH RECURSIVE up(id, parent_id) AS (
             SELECT id, parent_id FROM collections WHERE id = ?
             UNION ALL SELECT c.id, c.parent_id FROM collections c JOIN up ON c.id = up.parent_id)
           SELECT id FROM up WHERE id = ?`,
        )
        .get(patch.parentId, id);
      if (hit) throw new RangeError("a collection cannot be moved inside itself");
      this.get(patch.parentId);
    }
    this.db
      .query(
        `UPDATE collections SET name = ?, parent_id = ?, sort = ?, color = ?, updated_at = ?, seq = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.parentId !== undefined ? patch.parentId : current.parentId,
        patch.sort ?? current.sort,
        patch.color !== undefined ? patch.color : current.color,
        Date.now(),
        this.db.nextSeq(),
        id,
      );
    this.hooks.changed();
    return this.get(id);
  }

  /**
   * Soft delete. Child collections move up to the deleted collection's parent;
   * its bookmarks become unsorted (each gets a new seq so clients and the
   * search index see the move).
   */
  delete(id: string): void {
    const current = this.get(id);
    this.db.transaction(() => {
      const now = Date.now();
      for (const { id: child } of this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM collections WHERE parent_id = ? AND deleted_at IS NULL",
        )
        .all(id)) {
        this.db
          .query("UPDATE collections SET parent_id = ?, updated_at = ?, seq = ? WHERE id = ?")
          .run(current.parentId, now, this.db.nextSeq(), child);
      }
      for (const { id: bid } of this.db
        .query<{ id: string }, [string]>(
          // Tombstones keep theirs: they aren't shown, and a new seq would only resend them.
          "SELECT id FROM bookmarks WHERE collection_id = ? AND deleted_at IS NULL",
        )
        .all(id)) {
        this.db
          .query("UPDATE bookmarks SET collection_id = NULL, updated_at = ?, seq = ? WHERE id = ?")
          .run(now, this.db.nextSeq(), bid);
      }
      this.db
        .query("UPDATE collections SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ?")
        .run(now, now, this.db.nextSeq(), id);
    })();
    this.hooks.changed();
  }
}
