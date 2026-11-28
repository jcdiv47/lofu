import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes a consistent copy of the database to `dest` while the server keeps
 * running. Copying the files of a live WAL database can tear; `VACUUM INTO`
 * reads one snapshot and writes a compact, self-contained file. The live
 * database is only read, so this is safe from an admin script.
 *
 * The copy goes to `<dest>.partial` and is checked before it's renamed into
 * place, so a file at `dest` is always a complete, readable backup.
 */
export function backupDb(db: Database, dest: string): void {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  rmSync(tmp, { force: true });
  try {
    db.run("VACUUM INTO ?", [tmp]);
    // A restored copy is another database to sync against: its seq may be behind.
    const writable = new Database(tmp);
    try {
      writable
        .query("UPDATE meta SET value = ? WHERE key = 'db_generation'")
        .run(Bun.randomUUIDv7());
    } finally {
      writable.close();
    }
    const copy = new Database(tmp, { readonly: true });
    try {
      const check = copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
      if (check?.integrity_check !== "ok") {
        throw new Error(`backup failed its integrity check: ${check?.integrity_check}`);
      }
      const want = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
      const got = copy.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
      if (got.user_version !== want.user_version) {
        throw new Error(`backup has schema v${got.user_version}, expected v${want.user_version}`);
      }
    } finally {
      copy.close();
    }
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A timestamped file name that sorts in time order: `lofu-20261117T053000Z[-label].db`. */
export function backupName(now: Date, label?: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const safe = label?.replace(/[^A-Za-z0-9._-]/g, "") ?? "";
  return `lofu-${stamp}${safe ? `-${safe}` : ""}.db`;
}

/** Deletes all but the newest `keep` backups in `dir`. Returns the names removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const old = readdirSync(dir)
    .filter((f) => /^lofu-\d{8}T\d{6}Z.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(Math.max(0, keep));
  for (const f of old) rmSync(join(dir, f));
  return old;
}
