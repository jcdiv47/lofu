# lofu — notes for coding agents

See README.md for layout and commands. Before finishing a change, run `bun test`, `bun run typecheck` (server and extension), `bun run lint`, `cargo clippy -p lofu-cli`, for extension changes `bun run ext:e2e`, and for reader changes `bun run reader:test` (plus `apps/reader/e2e/web.ts`; see apps/reader/README.md). Look at the screenshots it writes, because UI regressions don't fail assertions.

Invariants that the code relies on:

- **The server process is the only writer, and all writes happen on the main thread.** `db.nextSeq()` is an in-memory counter. Sync and the indexer depend on rows being committed in seq order. Worker threads compute only; never open the DB from a worker. Admin scripts may write only to `api_tokens` and `meta`.
- **Every user-visible change bumps `seq`.** That covers soft deletes (tombstones) and highlight changes, which also call `bookmarks.touch()` because highlights are part of the bookmark's search document.
- **SQLite is the source of truth.** Meilisearch is derived and stores only what search needs. Search returns ids, and bookmarks are loaded from SQLite.
- **Prepared statements must keep a bounded number of SQL shapes.** Pass variable-length lists as one JSON parameter through `json_each(?)` instead of generating `IN (?, ?, …)`.
- **Schema changes are append-only** entries in `apps/server/src/db/migrations.ts`.
- **API shapes live in `packages/shared/src/schemas.ts`** (zod). The OpenAPI document is generated from them. The Rust CLI passes JSON through rather than mirroring the types.
- **Extraction must never store junk as `ok`.** Captcha/challenge pages, empty JS shells and error JSON are detected (`extract/blocked.ts`; the browser's own `ready` verdict). Add a signature when you find a new one. Detection only runs on short pages, so long articles that mention "captcha" aren't affected.

Performance claims in README.md are measured. Re-measure before you change one.
