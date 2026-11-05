/**
 * Local admin commands. They open the database directly, so run them on the
 * server host (or `docker compose exec server bun src/admin.ts ...`).
 *
 *   bun src/admin.ts token create <name>
 *   bun src/admin.ts token list
 *   bun src/admin.ts token revoke <id>
 *   bun src/admin.ts reindex
 */
import { config } from "./config.ts";
import { openDb } from "./db/index.ts";
import { TokenStore } from "./store/tokens.ts";

const [cmd, sub, arg] = process.argv.slice(2);
const db = openDb(config.dbPath);
const tokens = new TokenStore(db);

function usage(): never {
  console.error("usage: admin.ts token create <name> | token list | token revoke <id> | reindex");
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
} else usage();

db.close();
