/**
 * Local admin commands. They open the database directly, so run them on the
 * server host (or `docker compose exec server bun src/admin.ts ...`).
 *
 *   bun src/admin.ts token create <name>
 *   bun src/admin.ts token list
 *   bun src/admin.ts token revoke <id>
 *   bun src/admin.ts reindex
 *   bun src/admin.ts backup [--keep N] [--label L] [path]
 *
 * `backup` writes a consistent snapshot of the live database, by default to
 * <data dir>/backups/, keeping the newest N there (14 if not given).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config.ts";
import { backupDb, backupName, pruneBackups } from "./db/backup.ts";
import { openDb } from "./db/index.ts";
import { TokenStore } from "./store/tokens.ts";

const [cmd, sub, arg] = process.argv.slice(2);
// Backing up a database that isn't there would create an empty one and copy that.
if (cmd === "backup" && !existsSync(config.dbPath)) {
  console.error(`no database at ${config.dbPath}`);
  process.exit(1);
}
const db = openDb(config.dbPath);
const tokens = new TokenStore(db);

function usage(): never {
  console.error(
    "usage: admin.ts token create <name> | token list | token revoke <id> | reindex | " +
      "backup [--keep N] [--label L] [path]",
  );
  process.exit(2);
}

if (cmd === "token" && sub === "create" && arg) {
  const { id, token } = tokens.create(arg);
  console.log(`created token ${id} (${arg}). It is shown only once:\n\n  ${token}\n`);
} else if (cmd === "token" && sub === "list") {
  for (const t of tokens.list()) {
    const used = t.last_used_at ? new Date(t.last_used_at).toISOString() : "never";
    console.log(
      `${t.id}  ${t.name.padEnd(20)} created ${new Date(t.created_at).toISOString()}  last used ${used}`,
    );
  }
} else if (cmd === "token" && sub === "revoke" && arg) {
  console.log(tokens.revoke(arg) ? "revoked (takes effect within a minute)" : "no such token");
} else if (cmd === "reindex") {
  // The running server's indexer notices the reset cursor within a minute.
  db.query("DELETE FROM meta WHERE key LIKE 'meili:%'").run();
  console.log("search index will be rebuilt by the running server");
} else if (cmd === "backup") {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: { keep: { type: "string" }, label: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length > 1) usage();
  const dir = join(config.dataDir, "backups");
  const dest = positionals[0] ?? join(dir, backupName(new Date(), values.label));
  backupDb(db, dest);
  console.log(dest);
  if (!positionals[0] || values.keep) {
    const keep = Number.parseInt(values.keep ?? "14", 10);
    if (!(keep >= 1)) usage();
    for (const f of pruneBackups(dir, keep)) console.error(`removed old backup ${f}`);
  }
} else usage();

db.close();
