# lofu

Self-hosted bookmarks and read-later, in the spirit of Raindrop.io and Pocket. It runs on a home server and you reach it over your LAN or Tailscale. Clients: web, iOS, macOS, and a CLI built for agents.

```
apps/server       Bun + Hono API, SQLite, job queue, extraction workers, search indexer
packages/shared   zod schemas (API contract → OpenAPI) and URL normalization
crates/lofu-cli   `lofu` CLI in Rust
skills/lofu       Agent skill describing the CLI
docker/           compose stack (server + Meilisearch) and Dockerfile
```

Clients (nsh app, browser extension, iOS share extension) come next. See the roadmap below.

## Quick start (development)

```sh
bun install
cp .env.example .env              # set MEILI_MASTER_KEY
bun run services:up               # Meilisearch in Docker on 127.0.0.1:7700
bun run --cwd apps/server token create laptop   # prints a token once
bun run dev                       # API on http://127.0.0.1:8787

bun run cli:build                 # → target/release/lofu
./target/release/lofu login --url http://127.0.0.1:8787 --token lofu_...
lofu add https://www.paulgraham.com/greatwork.html -t essays
lofu search great work
```

Checks: `bun test` (needs Meilisearch for the search tests; they're skipped if `MEILI_URL` is unset), `bun run typecheck` (TypeScript 7), `bun run lint` (Biome), `cargo clippy`.

## Running on the home server

```sh
cp docker/.env.example docker/.env  # set MEILI_MASTER_KEY
bun run stack:up                    # builds and starts server + Meilisearch
bun run stack:token create phone
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Both containers bind to loopback only. `tailscale serve` gives you `https://<machine>.<tailnet>.ts.net` with a real certificate, which iOS App Transport Security requires. Back up `data/server/` (SQLite). `data/meili/` is derived and can be rebuilt with `bun src/admin.ts reindex`.

## Architecture and performance decisions

Numbers below were measured on the dev box (32 cores, loopback) with the real stack.

| Area | Decision | Why |
|---|---|---|
| Runtime | Bun, using built-ins where they exist (`bun:sqlite`, zstd, workers, fetch) | Fewer dependencies and native-speed primitives. |
| Storage | SQLite in WAL mode, a 64 MiB page cache, 256 MiB mmap, prepared statements only | API list/sync: **~15–18k req/s, p50 ≈ 2 ms** at 32 concurrent requests. |
| Change feed | One global `seq` number, allocated in memory and assigned on every write | One change number feeds both client delta sync (`/v1/sync`) and the search indexer. It's gap-free because the main thread is the only writer, and there's no counter row to contend on. |
| Extraction | Defuddle + linkedom on a **worker-thread pool** that replaces timed-out workers | Defuddle costs ~450 ms CPU per large page. Pre-stripping scripts and styles (a candidate for a Rust pre-pass) saved almost nothing, so parallelism is the fix. The API's event loop never blocks. |
| Fetching | HTTP/2 first for https with fallback to HTTP/1.1 (remembered per host); global + per-host concurrency caps; charset detection | Some sites reject HTTP/1.1 clients (paulgraham.com returns 500). GBK, Big5 and Shift_JIS pages decode correctly. |
| Content storage | Article HTML, markdown and text stored zstd-compressed, in a separate table | Lists never page in large blobs. `/content` sends the stored zstd bytes unchanged to clients that accept zstd, at zero CPU cost. |
| Search | Meilisearch returns **ids only**; bookmarks are hydrated from SQLite, and snippets are cut locally | Letting Meilisearch crop/highlight article bodies cut throughput from **~35k to ~620 req/s**. With local snippets: **~4k req/s** (p50 7.7 ms), or **~13k req/s** with `snippets=false`. |
| Indexing | Incremental and batched, driven by `seq`. The cursor only advances after Meilisearch confirms the write. | Bursts (imports) collapse into a few batches. A Meilisearch outage just means indexing catches up later. |
| CLI | Rust (clap + ureq), 2.6 MB static binary | `lofu ls`: **0.7 ms** round trip; `--help`: 0.3 ms. A compiled Bun binary would start in ~2 ms and weigh ~86 MB. |
| Auth | 256-bit bearer tokens, SHA-256 hashed, verified once and cached in memory | No KDF on every request. Revocation takes effect within 60 s. |

## API

The OpenAPI 3.1 document is served at `/openapi.json`, generated from the zod schemas in `packages/shared`. Main endpoints:

- `POST /v1/bookmarks`: idempotent on the normalized URL (tracking params, `www.`, fragments and scheme are ignored). Pass `html` to skip fetching (for pages behind a login).
- `GET /v1/bookmarks` (keyset pagination; filters `collectionId`, `tags`, `archived`, `favorite`, `type`), `GET|PATCH|DELETE /v1/bookmarks/{id}`, `POST /v1/bookmarks/{id}/refetch`, `GET /v1/bookmarks/{id}/content?format=markdown|html|text`
- `GET /v1/search`, `GET /v1/tags`, `/v1/collections`, `/v1/bookmarks/{id}/highlights`, `/v1/highlights/{id}`
- `GET /v1/sync?since=<cursor>`: everything changed since the cursor, deletions included

## Roadmap

1. **Importers**: Netscape bookmark HTML (browsers, Raindrop), Pocket export, Raindrop CSV.
2. **Headless fallback**: Playwright/Chromium for pages built in JavaScript; screenshot thumbnails.
3. **Permanent copies**: single-file archives via `monolith`; periodic broken-link checks.
4. **Clients**: nsh prototype of the reader view with highlights (the riskiest part), then a web app, then iOS/macOS with a Swift share extension and keychain; a WXT browser extension that sends rendered HTML.
5. Semantic search (a Meilisearch embedder, e.g. Ollama → `MEILI_EMBEDDER`), suggested tags, text-to-speech.
