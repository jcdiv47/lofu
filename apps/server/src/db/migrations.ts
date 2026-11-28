/**
 * Forward-only migrations, tracked with PRAGMA user_version.
 * Append new entries; never edit one that has shipped.
 */
export const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

  CREATE TABLE collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   TEXT REFERENCES collections(id) ON DELETE SET NULL,
    sort        REAL NOT NULL DEFAULT 0,
    color       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    seq         INTEGER NOT NULL
  );
  CREATE INDEX collections_seq ON collections(seq);

  CREATE TABLE bookmarks (
    id             TEXT PRIMARY KEY,
    url            TEXT NOT NULL,
    url_key        TEXT NOT NULL UNIQUE,      -- normalizeUrl(url); dedupe key
    title          TEXT NOT NULL DEFAULT '',
    title_locked   INTEGER NOT NULL DEFAULT 0, -- user-set title; extraction won't overwrite
    excerpt        TEXT,
    note           TEXT,
    cover_url      TEXT,
    favicon_url    TEXT,
    domain         TEXT NOT NULL,
    type           TEXT NOT NULL DEFAULT 'link',
    tags           TEXT NOT NULL DEFAULT '[]', -- JSON array, mirrored into bookmark_tags
    collection_id  TEXT REFERENCES collections(id) ON DELETE SET NULL,
    favorite       INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    read_progress  REAL NOT NULL DEFAULT 0,
    word_count     INTEGER,
    lang           TEXT,
    author         TEXT,
    published_at   TEXT,
    content_status TEXT NOT NULL DEFAULT 'pending',
    content_error  TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    deleted_at     INTEGER,
    seq            INTEGER NOT NULL
  );
  CREATE INDEX bookmarks_seq ON bookmarks(seq);
  CREATE INDEX bookmarks_recent ON bookmarks(created_at DESC, id DESC) WHERE deleted_at IS NULL;
  CREATE INDEX bookmarks_collection ON bookmarks(collection_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

  -- Tag lookup table, maintained by triggers so writers only touch bookmarks.tags.
  CREATE TABLE bookmark_tags (
    tag         TEXT NOT NULL,
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    PRIMARY KEY (tag, bookmark_id)
  ) WITHOUT ROWID;
  CREATE INDEX bookmark_tags_bookmark ON bookmark_tags(bookmark_id);

  CREATE TRIGGER bookmarks_tags_ai AFTER INSERT ON bookmarks BEGIN
    INSERT OR IGNORE INTO bookmark_tags(tag, bookmark_id)
      SELECT value, NEW.id FROM json_each(NEW.tags);
  END;
  CREATE TRIGGER bookmarks_tags_au AFTER UPDATE OF tags ON bookmarks BEGIN
    DELETE FROM bookmark_tags WHERE bookmark_id = NEW.id;
    INSERT OR IGNORE INTO bookmark_tags(tag, bookmark_id)
      SELECT value, NEW.id FROM json_each(NEW.tags);
  END;

  -- Extracted article bodies, zstd-compressed. Kept out of bookmarks so list
  -- scans never page in large blobs.
  CREATE TABLE contents (
    bookmark_id  TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
    html         BLOB NOT NULL,
    markdown     BLOB NOT NULL,
    text         BLOB NOT NULL,
    raw_bytes    INTEGER NOT NULL,
    extractor    TEXT,
    extracted_at INTEGER NOT NULL
  );

  CREATE TABLE highlights (
    id          TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    quote       TEXT NOT NULL,
    prefix      TEXT NOT NULL DEFAULT '',
    suffix      TEXT NOT NULL DEFAULT '',
    note        TEXT,
    color       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    seq         INTEGER NOT NULL
  );
  CREATE INDEX highlights_bookmark ON highlights(bookmark_id) WHERE deleted_at IS NULL;
  CREATE INDEX highlights_seq ON highlights(seq);

  CREATE TABLE jobs (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,
    bookmark_id  TEXT NOT NULL,
    payload      TEXT,
    run_at       INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    last_error   TEXT,
    UNIQUE (kind, bookmark_id)
  );
  CREATE INDEX jobs_due ON jobs(run_at);

  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL UNIQUE,  -- sha256 hex; tokens are 256-bit random, no KDF needed
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,

  /* 2: job priority (0 = interactive, 1 = bulk import) */ `
  ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  `,

  /* 3: image sizes, JSON {url: [width, height]}; NULL until measured (extract/images.ts) */ `
  ALTER TABLE contents ADD COLUMN images TEXT;
  `,

  /*
   * 4: a bookmark's place in its collection's manual order (Raindrop's
   * "Manual (Drag'n'drop)"), ascending. It starts at minus the save time, so
   * the manual order begins newest first and a new bookmark goes on top; a
   * drag puts one between its neighbours (their midpoint). Seq is left alone:
   * clients without the field compute the same value from createdAt.
   */ `
  ALTER TABLE bookmarks ADD COLUMN sort REAL NOT NULL DEFAULT 0;
  UPDATE bookmarks SET sort = -created_at;
  `,

  /*
   * 5: inline SVG figures taken out of saved articles (extract/figures.ts),
   * zstd-compressed, served by hash from /figures/<hash>. Written with the
   * article's Markdown, which points at them; they go with its content.
   */ `
  CREATE TABLE figures (
    bookmark_id TEXT NOT NULL REFERENCES contents(bookmark_id) ON DELETE CASCADE,
    hash        TEXT NOT NULL,
    svg         BLOB NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    PRIMARY KEY (bookmark_id, hash)
  ) WITHOUT ROWID;
  CREATE INDEX figures_hash ON figures(hash);
  `,

  /*
   * 6: when a bookmark's stored content last changed (an extraction, or the
   * Markdown converted again), for `extractedAt` and the content's ETag.
   * Backfilled from the content; seq is left alone, so synced copies learn
   * it with the bookmark's next change (the field is nullable for them).
   */ `
  ALTER TABLE bookmarks ADD COLUMN extracted_at INTEGER;
  UPDATE bookmarks SET extracted_at =
    (SELECT c.extracted_at FROM contents c WHERE c.bookmark_id = bookmarks.id);
  `,

  /* 7: what each API token may do (JSON array of read, write, delete, admin) */ `
  ALTER TABLE api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT '["read","write","delete","admin"]';
  `,

  /*
   * 8: highlights left live on a deleted bookmark (by builds before deleting
   * a bookmark tombstoned its highlights) are deleted with it. Each gets a
   * new seq past every one handed out (this runs before the allocator reads
   * the max), so synced clients learn of it.
   */ `
  CREATE TEMP TABLE orphan_highlights AS
    SELECT h.id AS id, max(h.updated_at, b.deleted_at) AS at, b.deleted_at AS gone,
      (SELECT coalesce(max(s), 0) FROM (
         SELECT max(seq) AS s FROM bookmarks
         UNION ALL SELECT max(seq) FROM collections
         UNION ALL SELECT max(seq) FROM highlights))
        + row_number() OVER (ORDER BY h.seq, h.id) AS seq
    FROM highlights h JOIN bookmarks b ON b.id = h.bookmark_id
    WHERE h.deleted_at IS NULL AND b.deleted_at IS NOT NULL;
  UPDATE highlights SET
    deleted_at = (SELECT o.gone FROM orphan_highlights o WHERE o.id = highlights.id),
    updated_at = (SELECT o.at FROM orphan_highlights o WHERE o.id = highlights.id),
    seq = (SELECT o.seq FROM orphan_highlights o WHERE o.id = highlights.id)
  WHERE id IN (SELECT id FROM orphan_highlights);
  DROP TABLE orphan_highlights;
  `,
];
