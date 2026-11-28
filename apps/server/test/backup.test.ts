import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDb, backupName, pruneBackups } from "../src/db/backup.ts";
import { openDb } from "../src/db/index.ts";
import { migrations } from "../src/db/migrations.ts";

const dir = mkdtempSync(join(tmpdir(), "lofu-backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("backup", () => {
  test("copies a live WAL database, schema version included", () => {
    const db = openDb(join(dir, "live.db"));
    db.run("CREATE TABLE t (x)");
    db.run("INSERT INTO t VALUES (42)");
    // Still open, with the write sitting in the WAL.
    expect(existsSync(join(dir, "live.db-wal"))).toBe(true);

    const dest = join(dir, "out", "copy.db");
    backupDb(db, dest);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    const copy = new Database(dest, { readonly: true });
    expect(copy.query("SELECT x FROM t").get()).toEqual({ x: 42 });
    expect(copy.query("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
    copy.close();

    expect(() => backupDb(db, dest)).toThrow("already exists");
    db.close();
  });

  test("names sort in time order and prune keeps the newest", () => {
    expect(backupName(new Date("2026-11-17T05:30:00.123Z"), "pre-abc/1")).toBe(
      "lofu-20261117T053000Z-pre-abc1.db",
    );
    const b = join(dir, "backups");
    rmSync(b, { recursive: true, force: true });
    const names = [1, 2, 3, 4].map((d) => backupName(new Date(Date.UTC(2026, 10, d))));
    mkdirSync(b, { recursive: true });
    for (const n of [...names, "unrelated.db"]) writeFileSync(join(b, n), "");
    expect(pruneBackups(b, 2).sort()).toEqual(names.slice(0, 2));
    expect(readdirSync(b).sort()).toEqual([...names.slice(2), "unrelated.db"].sort());
  });
});

describe("migrations 6 and 7", () => {
  test("backfill extracted_at from contents, and give old tokens every scope", () => {
    const path = join(dir, "old.db");
    const old = new Database(path, { create: true, strict: true });
    for (const m of migrations.slice(0, 5)) old.run(m);
    old.run("PRAGMA user_version = 5");
    old.run(
      `INSERT INTO bookmarks (id, url, url_key, domain, created_at, updated_at, seq)
       VALUES ('a', 'https://a.test/', 'a.test', 'a.test', 1, 1, 1),
              ('b', 'https://b.test/', 'b.test', 'b.test', 1, 1, 2)`,
    );
    old.run(
      `INSERT INTO contents (bookmark_id, html, markdown, text, raw_bytes, extracted_at)
       VALUES ('a', x'', x'', x'', 0, 1234)`,
    );
    old.run("INSERT INTO api_tokens (id, name, hash, created_at) VALUES ('t', 'old', 'h', 1)");
    old.close();

    const db = openDb(path);
    expect(db.query("SELECT id, extracted_at FROM bookmarks ORDER BY id").all()).toEqual([
      { id: "a", extracted_at: 1234 },
      { id: "b", extracted_at: null },
    ]);
    expect(db.query("SELECT scopes FROM api_tokens").get()).toEqual({
      scopes: '["read","write","delete","admin"]',
    });
    // Seq is where it was: nothing was resent.
    expect(db.currentSeq()).toBe(2);
    db.close();
  });
});

describe("migration 8", () => {
  test("deletes the live highlights of deleted bookmarks, each with a new seq", () => {
    const path = join(dir, "orphans.db");
    const old = new Database(path, { create: true, strict: true });
    for (const m of migrations.slice(0, 7)) old.run(m);
    old.run("PRAGMA user_version = 7");
    old.run(
      `INSERT INTO bookmarks (id, url, url_key, domain, created_at, updated_at, deleted_at, seq)
       VALUES ('live', 'https://a.test/', 'a.test', 'a.test', 1, 1, NULL, 1),
              ('gone', 'https://b.test/', 'b.test', 'b.test', 1, 500, 500, 5)`,
    );
    old.run(
      `INSERT INTO highlights (id, bookmark_id, quote, created_at, updated_at, deleted_at, seq)
       VALUES ('h-live', 'live', 'q', 1, 1, NULL, 2),
              ('h-orphan-1', 'gone', 'q', 1, 1, NULL, 3),
              ('h-orphan-2', 'gone', 'q', 1, 900, NULL, 4),
              ('h-dead', 'gone', 'q', 1, 300, 300, 6)`,
    );
    old.close();

    const db = openDb(path);
    expect(
      db.query("SELECT id, deleted_at, updated_at, seq FROM highlights ORDER BY id").all(),
    ).toEqual([
      { id: "h-dead", deleted_at: 300, updated_at: 300, seq: 6 },
      { id: "h-live", deleted_at: null, updated_at: 1, seq: 2 },
      { id: "h-orphan-1", deleted_at: 500, updated_at: 500, seq: 7 },
      { id: "h-orphan-2", deleted_at: 500, updated_at: 900, seq: 8 },
    ]);
    // The allocator goes on past them, so sync sends them.
    expect(db.currentSeq()).toBe(8);
    expect(db.nextSeq()).toBe(9);
    db.close();
  });
});

describe("generation", () => {
  test("is kept across opens, and a backup gets its own", () => {
    const path = join(dir, "gen.db");
    const first = openDb(path);
    const gen = first.generation;
    first.close();
    const again = openDb(path);
    expect(again.generation).toBe(gen);
    const dest = join(dir, "gen-backup.db");
    backupDb(again, dest);
    again.close();
    const restored = openDb(dest);
    expect(restored.generation).not.toBe(gen);
    expect(restored.generation).toMatch(/^[0-9a-f-]{36}$/);
    restored.close();
  });
});
