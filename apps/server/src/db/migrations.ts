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
];
