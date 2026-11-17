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
