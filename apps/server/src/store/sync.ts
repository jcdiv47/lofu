import type { Db } from "../db/index.ts";
import type { ImageProxy } from "../extract/images.ts";
import {
  type BookmarkRow,
  type CollectionRow,
  type HighlightRow,
  toBookmark,
  toCollection,
  toHighlight,
} from "./rows.ts";

/**
 * Delta feed over the global seq. Returns at most `limit` changed rows across
 * all tables, cut at a seq boundary so a page never splits a seq.
 */
export function syncSince(db: Db, images: ImageProxy, since: number, limit: number) {
  const cutoffRow = db
    .query<{ seq: number }, [number, number]>(
      `SELECT seq FROM (
         SELECT seq FROM bookmarks WHERE seq > ?1
         UNION ALL SELECT seq FROM collections WHERE seq > ?1
         UNION ALL SELECT seq FROM highlights WHERE seq > ?1)
       ORDER BY seq LIMIT 1 OFFSET ?2`,
    )
    .get(since, limit - 1);
  const upTo = cutoffRow?.seq ?? Number.MAX_SAFE_INTEGER;

  const bookmarks = db
    .query<BookmarkRow, [number, number]>(
      "SELECT * FROM bookmarks WHERE seq > ? AND seq <= ? ORDER BY seq",
    )
    .all(since, upTo);
  const collections = db
    .query<CollectionRow, [number, number]>(
      "SELECT * FROM collections WHERE seq > ? AND seq <= ? ORDER BY seq",
    )
    .all(since, upTo);
  const highlights = db
    .query<HighlightRow, [number, number]>(
      "SELECT * FROM highlights WHERE seq > ? AND seq <= ? ORDER BY seq",
    )
    .all(since, upTo);

  const maxSeen = Math.max(
    since,
    bookmarks.at(-1)?.seq ?? 0,
    collections.at(-1)?.seq ?? 0,
    highlights.at(-1)?.seq ?? 0,
  );
  const hasMore =
    cutoffRow !== null &&
    db
      .query<{ x: number }, [number]>(
        `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM bookmarks WHERE seq > ?1)
           OR EXISTS (SELECT 1 FROM collections WHERE seq > ?1)
           OR EXISTS (SELECT 1 FROM highlights WHERE seq > ?1)`,
      )
      .get(maxSeen) !== null;

  return {
    generation: db.generation,
    serverSeq: db.currentSeq(),
    cursor: maxSeen,
    hasMore,
    bookmarks: bookmarks.map((r) => toBookmark(r, images)),
    collections: collections.map(toCollection),
    highlights: highlights.map(toHighlight),
  };
}
