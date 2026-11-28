import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations.ts";

export type Db = Database & {
  nextSeq(): number;
  /** The newest seq handed out. */
  currentSeq(): number;
  /**
   * This database's identity (`meta.db_generation`), made once. A backup's
   * copy gets a new one (db/backup.ts), so a client that synced against the
   * live database notices when a backup is restored and its seq went back.
   */
  generation: string;
};

export const GENERATION_KEY = "db_generation";

/**
 * Opens the database, applies pragmas and migrations, and attaches a `seq`
 * allocator.
 *
 * Invariant: this process is the only writer, and every write happens on the
 * main thread (worker threads only compute). bun:sqlite is synchronous, so
 * transactions commit in exactly the order their seq values were allocated.
 * That makes "everything with seq > cursor" a gap-free change feed for both
 * client sync and the search indexer, with no counter row to contend on.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true }) as Db;

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL"); // durable across app crashes; WAL fsyncs at checkpoint
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA temp_store = MEMORY");
  db.run("PRAGMA cache_size = -65536"); // 64 MiB page cache
  db.run("PRAGMA mmap_size = 268435456"); // 256 MiB memory-mapped reads
  db.run("PRAGMA journal_size_limit = 67108864");

  migrate(db);

  const maxSeq = db
    .query<{ s: number | null }, []>(
      `SELECT max(s) AS s FROM (
         SELECT max(seq) AS s FROM bookmarks
         UNION ALL SELECT max(seq) FROM collections
         UNION ALL SELECT max(seq) FROM highlights)`,
    )
    .get();
  let seq = maxSeq?.s ?? 0;
  db.nextSeq = () => ++seq;
  db.currentSeq = () => seq;

  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
    GENERATION_KEY,
    Bun.randomUUIDv7(),
  );
  db.generation = db
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(GENERATION_KEY)!.value;

  return db;
}

function migrate(db: Database): void {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (current > migrations.length) {
    throw new Error(
      `database schema v${current} is newer than this build (v${migrations.length}); refusing to start`,
    );
  }
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.run(migrations[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  if (current < migrations.length) db.run("PRAGMA optimize = 0x10002");
}
