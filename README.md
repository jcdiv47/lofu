<div align="center">
  <img src="design/logo/icon-192.png" alt="lofu logo" width="96" height="96" />
  <h1>lofu</h1>
  <p><strong>Self-hosted bookmarks and read-later, built for speed, offline reading, and AI agents.</strong></p>
  <p>
    <a href="https://github.com/jcdiv47/lofu/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/jcdiv47/lofu/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
    <a href="https://github.com/jcdiv47/lofu/commits/main"><img src="https://img.shields.io/github/last-commit/jcdiv47/lofu" alt="Last Commit" /></a>
    <a href="https://github.com/jcdiv47/lofu/issues"><img src="https://img.shields.io/github/issues/jcdiv47/lofu" alt="Open Issues" /></a>
    <a href="https://github.com/jcdiv47/lofu/pkgs/container/lofu-server"><img src="https://img.shields.io/badge/ghcr.io-lofu--server-2496ED?logo=docker&logoColor=white" alt="Container Image" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/jcdiv47/lofu" alt="MIT License" /></a>
  </p>
  <p>
    <a href="#features">Features</a> &middot;
    <a href="#quick-start">Quick Start</a> &middot;
    <a href="#self-hosting">Self-Hosting</a> &middot;
    <a href="#clients">Clients</a> &middot;
    <a href="#importing-from-raindropio">Migration</a> &middot;
    <a href="#api">API</a> &middot;
    <a href="#architecture-and-benchmarks">Architecture</a> &middot;
    <a href="#development">Development</a>
  </p>
</div>

**lofu** is a self-hosted bookmark manager and read-later server in the spirit of Raindrop.io and Pocket. It runs on your home server and is reached privately over your LAN or Tailscale, with native apps for macOS, iOS, Android, and the web, a browser extension for Chromium and Firefox, and a fast Rust CLI designed for both humans and AI agents.

## Features

- **Clean content extraction**: Extracts readable Markdown, HTML, and plain text on a worker-thread pool with site-specific adapters (GitHub, WeChat, V2EX, Xiaohongshu, Zhihu, arXiv), PDF full-text extraction via Poppler, headless Chromium fallback for JS-only and bot-walled pages, inline SVG figure & MathJax rendering, and zstd storage compression.
- **Fast full-text search**: Meilisearch-backed indexing (including CJK) hydrated from SQLite with local snippet highlighting.
- **Native offline-first clients**: Cross-platform [Native Shell](https://nsh.dev) reader for macOS, iOS, Android, and web with delta sync (`/v1/sync`), offline article caching, W3C text-quote highlights, collections, tags, and reading progress.
- **Browser extension**: Saves pages directly from your logged-in browser session (handling login walls and bot checks), shows a saved-page badge on the toolbar, and offers opt-in auto-repair for failed extractions.
- **Rust CLI & AI agent skill**: A 2.6 MB static `lofu` binary with sub-millisecond startup, compact JSON output when piped, and a ready-to-use [`SKILL.md`](skills/lofu/SKILL.md) for coding agents.
- **Zero-trust home-server deployment**: Tailscale sidecar for automatic HTTPS without exposing ports to the public internet, immutable CI-built GHCR images with rollback, automated SQLite snapshots, and SSRF/container isolation.
- **Raindrop.io migration**: Idempotent CSV importer preserving collections, tags, notes, highlights, favorites, and original save timestamps.

## Repository Layout

| Path | Description |
| --- | --- |
| [`apps/server`](apps/server) | Bun + Hono API, SQLite storage, durable job queue, extraction workers, search indexer |
| [`apps/reader`](apps/reader/README.md) | Cross-platform [Native Shell](https://nsh.dev) app (macOS, iOS, Android, web) for library, search, reading, and highlights |
| [`apps/extension`](apps/extension) | WXT browser extension for Chrome, Edge, Brave, and Firefox |
| [`crates/lofu-cli`](crates/lofu-cli) | Static Rust CLI (`lofu`) for humans and AI agents |
| [`packages/shared`](packages/shared) | Zod schemas (API contract &rarr; OpenAPI 3.1), URL normalization, and highlight anchoring |
| [`skills/lofu`](skills/lofu/SKILL.md) | Agent skill documenting the `lofu` CLI |
| [`docker/`](docker) | Production and development Compose stacks, Tailscale sidecar, Dockerfile, and backup units |

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) 1.4+, Docker (for Meilisearch), and [Rust](https://rustup.rs) (optional, for the CLI).

```sh
bun install
cp .env.example .env                             # set MEILI_MASTER_KEY
bun run services:up                              # Meilisearch in Docker on 127.0.0.1:7700
bun run --cwd apps/server token create laptop    # prints an API token once (--scopes read,write,delete,admin)
bun run dev                                      # API on http://127.0.0.1:8787
```

Build and try the CLI:

```sh
bun run cli:build                                # → target/release/lofu
./target/release/lofu login --url http://127.0.0.1:8787 --token lofu_...
lofu add https://www.paulgraham.com/greatwork.html -t essays
lofu search great work
```

### Local Docker Stack

To run the full containerized stack built from your checkout (compose project `lofu` on `127.0.0.1:8787`, data in `data/`, configured via `docker/.env` from [`docker/.env.example`](docker/.env.example)):

```sh
bun run stack:up
```

`stack:up` runs through [`docker/compose.sh`](docker/compose.sh), which automatically includes an untracked `docker/compose.override.yaml` if present. Use that override to publish the API on your LAN or allow extra CORS origins on a single machine while keeping [`docker/compose.yaml`](docker/compose.yaml) loopback-only.

## Self-Hosting

Production runs from its own directory (`~/lofu-prod`, configurable via `LOFU_PROD_DIR`), with its own data, Compose project, and ports so work in a git checkout never touches production. It runs immutable images built by CI for commits on `main` (`ghcr.io/jcdiv47/lofu-server:<sha>`), never a local build.

```sh
docker/prod.sh init                              # writes ~/lofu-prod/.env with a fresh MEILI_MASTER_KEY
$EDITOR ~/lofu-prod/.env                         # add a Tailscale auth key (TS_AUTHKEY)
docker/prod.sh deploy                            # deploys origin/main, or: docker/prod.sh deploy <commit>
docker/prod.sh exec server bun src/admin.ts token create phone
docker/prod.sh status                            # shows deployed commit & https://lofu.<tailnet>.ts.net
```

How [`docker/prod.sh`](docker/prod.sh) keeps deployments safe:

- **Pre-pull gate**: `deploy` pulls the target image before modifying anything, refusing commits CI hasn't built or whose tests failed.
- **Health verification & rollback**: It snapshots the database, starts the release, waits for every container to report healthy, and verifies `/health` matches the deployed commit. If anything fails, `docker/prod.sh rollback` restores the previous release. Because migrations are forward-only and older builds refuse a newer schema, rollback also restores the pre-deploy SQLite snapshot (preserving the newer database under `backups/failed-*`) and rebuilds the search index.
- **Single-writer guard**: Two stacks must never share a data directory. Both `prod.sh` and `docker/compose.sh` refuse to start if another Compose project already mounts the same directory.
- **Compose passthrough**: Any unrecognized arguments pass straight to `docker compose` (for example, `docker/prod.sh logs -f server`).

### Tailscale Networking

lofu joins your tailnet as its own node through a Tailscale sidecar ([`docker/compose.tailscale.yaml`](docker/compose.tailscale.yaml), inspired by [ScaleTail](https://github.com/tailscale-dev/ScaleTail)):

- Serves `https://<TS_HOSTNAME>.<tailnet>.ts.net` with a valid TLS certificate (required by iOS App Transport Security).
- Tailscale Funnel is disabled so the server is never exposed to the public internet.
- The server shares the sidecar's network namespace and listens on its loopback — Tailscale HTTPS is the only ingress, and nothing is published on the host except Meilisearch on `127.0.0.1:7701` for debugging.
- `TS_AUTHKEY` is used only once; node identity persists in `<LOFU_DATA>/tailscale`.

To serve from the host's own Tailscale daemon instead, leave `TS_HOSTNAME` empty in `.env` and run:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8788
```

### Backups

Back up `<LOFU_DATA>/server/lofu.db` using `docker/prod.sh backup` rather than `cp` — copying a live SQLite database can produce a torn file. The command writes an integrity-checked snapshot (`VACUUM INTO`) to `<LOFU_DATA>/server/backups/`, retains the newest 14 snapshots, and optionally mirrors each snapshot to `LOFU_BACKUP_COPY_TO` (a local/mounted directory or an `rsync` target) when configured in `.env`.

To schedule nightly backups with a systemd user timer:

```sh
mkdir -p ~/.config/systemd/user
cp docker/systemd/lofu-backup.* ~/.config/systemd/user/   # edit the path in the .service if your checkout isn't ~/Code/lofu
systemctl --user enable --now lofu-backup.timer
loginctl enable-linger "$USER"                            # keep running while logged out
```

`<LOFU_DATA>/meili/` is derived data: delete it and run `admin.ts reindex` to rebuild the search index at any time.

### Updates

The Bun base image, Meilisearch, and headless Chromium are pinned by digest. Dependabot ([`.github/dependabot.yml`](.github/dependabot.yml)) opens PRs when updates land — merge headless browser updates promptly since it executes scripts on saved pages. Merging a PR triggers CI to publish a new server image, which you roll out with `docker/prod.sh deploy`.

Dependabot tracks Meilisearch patch updates only. Because minor Meilisearch releases cannot open an index from an earlier minor version, upgrade manually: bump the tag, delete `<LOFU_DATA>/meili`, deploy, and run `admin.ts reindex`.

### Security Model

Saving a web page means fetching untrusted URLs and, for JS-only sites, executing untrusted scripts. lofu enforces the following boundaries:

- **SSRF protection (no private network requests)**: Page fetches, every redirect hop, image probes, the image proxy, short-link expansion, and browser requests must resolve to public IP addresses ([`apps/server/src/extract/netguard.ts`](apps/server/src/extract/netguard.ts)). Loopback, private, link-local, CGNAT/Tailscale, and IPv6 equivalents are blocked so a saved page cannot reach your router, tailnet, or sibling containers. Set `LOFU_FETCH_PRIVATE=1` only if you intentionally bookmark internal LAN pages. *(Known residual gaps: a DNS server returning a different IP on a second lookup could send one blind request, and browser WebSockets are not filtered.)*
- **Isolated headless browser**: In Docker, Chromium (`chromedp/headless-shell`) runs in its own container as `nobody`, read-only filesystem, all capabilities dropped, no volumes, on a private network shared only with the server — a browser exploit cannot reach the database or API keys. Outside Docker, the server spawns local Chromium on demand.
- **Sandboxed stored content**: `/content?format=html` and `/img` are served with sandbox CSP headers so stored HTML cannot execute on the API's origin.
- **Loopback-only auth bypass**: `LOFU_AUTH_DISABLED=1` is refused unless the server binds to loopback.

## Clients

### Reader App (macOS, iOS, Android, Web)

The reader app in [`apps/reader`](apps/reader/README.md) is a single TSX + Rust codebase built on [Native Shell](https://nsh.dev), running natively on macOS (AppKit), iOS (UIKit), Android, and the web. It maintains an offline local mirror via `/v1/sync`, caches articles for offline reading, tracks reading progress, and supports collections, tags, search, and W3C-anchored highlights.

```sh
nsh run apps/reader                      # native desktop window (macOS)
bun run reader:web                       # web target on http://127.0.0.1:8790
nsh run apps/reader --target ios         # iOS Simulator (requires Xcode)
```

See [`apps/reader/README.md`](apps/reader/README.md) for packaging, iOS share extension builds, and platform notes, and [`apps/reader/android/README.md`](apps/reader/android/README.md) for Android APK builds and physical-device testing.

### Browser Extension (Chromium & Firefox)

```sh
bun run ext:build                        # → apps/extension/.output/chrome-mv3 and firefox-mv3
```

- **Chrome / Edge / Brave**: Open `chrome://extensions`, enable *Developer mode*, and click *Load unpacked* pointing to `apps/extension/.output/chrome-mv3`.
- **Firefox**: Open `about:debugging` &rarr; *Load Temporary Add-on* (or run `bun run --cwd apps/extension zip` to package a signed-ready zip).
- Open the extension's options page to configure your server URL and API token.

Key capabilities:

- **Saved-page indicator**: Displays a persistent blue `✓` badge on the toolbar icon for pages already in your library (excluding Trash). Status checks query URLs only; page contents are never sent during checks.
- **One-action saving**: Clicking the toolbar button or pressing <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> saves immediately; tags, collection, note, and favorite autosave. Context menus save the current page or any link.
- **Browser-rendered capture**: Sends the DOM as rendered in your browser (gzip-compressed over 32 KB), letting pages behind logins and bot checks (Zhihu, Medium, V2EX) save in full.
- **Opt-in auto-repair**: Revisiting a bookmark that the server previously failed to extract automatically submits the rendered page from a local repair list. The options page lists pages waiting for a visit.
- **Minimal permissions**: `tabs` reads URLs for the saved-page badge; saving relies on `activeTab`. All-sites access is requested only if you enable auto-repair.

Run end-to-end extension tests against a real server in Chrome for Testing with `bun run ext:e2e` (screenshots are written to `apps/extension/e2e/screens/`).

### CLI & AI Agent Skill

[`crates/lofu-cli`](crates/lofu-cli) builds a 2.6 MB static Rust binary (`bun run cli:build`). When stdout is not a TTY, it outputs compact JSON directly from the API — making it straightforward to script or pair with coding agents via [`skills/lofu/SKILL.md`](skills/lofu/SKILL.md).

```sh
lofu add https://example.com/article -t reading,systems --note "Great overview"
lofu search "consensus algorithms" -t systems -n 5
lofu content <id> --format text          # clean extracted text for LLM context
lofu ls -c unsorted                      # the Trash is left out; --trashed true|all to see it
```

### Saving from iOS Share Sheet

The iOS app includes a native share extension ([`apps/reader/share`](apps/reader/share); see [`apps/reader/README.md`](apps/reader/README.md)) that adds **lofu** to every app's share sheet.

If you're running a build without the share extension (e.g., plain `nsh package`), you can achieve the same zero-launch save with an Apple Shortcut. Create a shortcut, open **ⓘ**, enable *Show in Share Sheet*, and allow **URLs**, **Safari web pages**, and **Text**, then add:

1. **Get URLs from Input** (*Shortcut Input*) — extracts links even from wrapped share text (e.g., Xiaohongshu or Douyin).
2. **Get Item from List**: *First Item*.
3. **Get Contents of URL**: `https://<your-server>/v1/bookmarks` — Method `POST`, header `Authorization: Bearer lofu_…`, JSON body with `url` set to *Item from List*.
4. **Show Notification**: `"Saved to lofu"`.

> **Tip:** For apps that share nothing, or for Back Tap / Action button triggers, insert **Get Clipboard** before step 1 when *Shortcut Input* is empty. Short links (`t.co`, `t.cn`, etc.) are expanded server-side automatically.

## Importing from Raindrop.io

Export your library from Raindrop.io (*Settings &rarr; Export* or the `raindrop` CLI) and pipe or pass the CSV to `lofu`:

```sh
raindrop bookmark export --format csv | lofu import raindrop -
# or from a file:
lofu import raindrop export.csv
```

The import is idempotent and safe to re-run:

- Folders map to collections; tags, notes, excerpts, highlights, favorites, and original save timestamps are preserved.
- Duplicates within the export are merged via normalized URL comparison.
- Raindrop's `rdl.ink` screenshot covers are dropped in favor of each page's own image; placeholder titles (raw URLs, filenames, `"Webpage: …"`) are discarded so extracted titles win; unfetchable schemes (e.g., `chrome-extension://`) are skipped and reported.
- Background fetching runs at **bulk priority** in randomized order, throttled per host by `LOFU_FETCH_HOST_INTERVAL_MS` (default `1000` ms), so newly saved bookmarks stay responsive and bulk imports don't trip host rate limits.

## API

The full OpenAPI 3.1 specification is served live at `/openapi.json`, generated directly from the Zod schemas in [`packages/shared`](packages/shared); every operation has an `operationId` and tags. Request bodies support `Content-Encoding: gzip` (up to 32 MiB decoded). Errors are `{ error, code, details? }`, with a stable `code` (`INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `SEQ_CONFLICT`, `PAYLOAD_TOO_LARGE`, `SEARCH_UNAVAILABLE`, `INTERNAL_ERROR`; for `/content`, `CONTENT_PENDING`, `CONTENT_FAILED`, `CONTENT_SKIPPED`, `CONTENT_NOT_FOUND`). Every list comes as `{ items, … }`.

| Method & Path | Description |
| --- | --- |
| `POST /v1/bookmarks` | Save a bookmark (idempotent on normalized URL). Pass `html` to skip server fetching; otherwise short links (`t.co`, `t.cn`, `xhslink.com`, `b23.tv`, `bit.ly`, …) and wrappers (`weibo.cn/sinaurl?u=`, `link.zhihu.com/?target=`) are unwrapped automatically. `?wait=true` (10 s) or `?waitMs=` (≤ 15000) answers once the page is read. Saving one in the Trash again restores it. |
| `GET /v1/bookmarks` | List bookmarks with keyset pagination (`collectionId` + `includeSubcollections`, `tags`, `trashed=false\|true\|all` (default `false`: the Trash left out), `favorite`, `type`, `contentStatus`, `ids`, `domain`, `hasNote`, `hasHighlights`, `untagged`, `createdAfter`/`createdBefore`; `sort=newest\|oldest\|updated\|manual`). |
| `GET /v1/bookmarks/lookup?url=`, `POST /v1/bookmarks/lookup` | Look up a bookmark by any normalized (or wrapped) variant of a URL; the POST takes up to 200 `urls` at once. Bookmarks in the Trash are found only with `includeTrashed`. |
| `POST /v1/bookmarks/batch` | One `patch` for up to 200 bookmarks, or `delete: true`, in one transaction. |
| `GET \| PATCH \| DELETE /v1/bookmarks/{id}` | Read, update, or permanently delete a bookmark. With `?content=markdown`, also returns measured article `images` (`src`, `width`, `height`, `proxy`); `include=media,highlights,none` picks the extras, `contentOffset`/`contentMaxChars` slice the content (with `headings` for Markdown). PATCH takes `addTags`/`removeTags`, and `expectedSeq` (or `If-Match`) for optimistic concurrency. |
| `POST /v1/bookmarks/{id}/refetch` | Re-queue page extraction; an optional `{ html }` body supplies the page, `wait`/`waitMs` wait for it. Title, excerpt and cover change only if the page is read. |
| `GET /v1/bookmarks/{id}/content` | Fetch extracted content (`?format=markdown\|html\|text`, Markdown by default), serving stored zstd bytes directly when accepted. Has an `ETag` (`If-None-Match` → 304); `offset`/`maxChars` slice it. Without content: 409 `CONTENT_PENDING` while it's being read, 422 `CONTENT_FAILED` or `CONTENT_SKIPPED`, 404 `CONTENT_NOT_FOUND` (404 `NOT_FOUND`: no such bookmark). |
| `GET /v1/search` | Full-text search via Meilisearch hydrated from SQLite; queries of conditions only, or every query without Meilisearch, are answered from SQLite (`engine`). `maxSnippets` (≤ 5) excerpts from the text, note, highlights, description or title. Takes the list's filters, `trashed` included (the Trash left out by default). |
| `GET /v1/sync?since=<cursor>` | Incremental delta sync of all changes and deletion tombstones since `<cursor>`. `generation` changes when a backup is restored (sync again from 0). |
| `GET /v1/tags`, `POST /v1/tags/rename`, `DELETE /v1/tags/{name}` | List tags (`{ items }`; the Trash's only with `includeTrashed`), rename/merge tags (`{from, to}`), or remove a tag across all bookmarks. |
| `/v1/collections` | Manage collections (deleting a collection moves its bookmarks to Unsorted); each comes with its `bookmarkCount`; the list is `{ items }`. |
| `/v1/bookmarks/{id}/highlights`, `/v1/highlights`, `/v1/highlights/{id}` | Create (idempotent on a client `id`), list (per bookmark as `{ items }`, or across the library with filters, `trashed` among them), update, and delete highlights. |
| `GET /v1/stats`, `GET /v1/capabilities` | Library counts; what the server (search, browser, PDF) and the calling token can do. |
| `POST /v1/import/raindrop` | Import a Raindrop.io CSV body and return an import report. |
| `GET /img/<signature>?u=<url>` | Signed image proxy for covers and article images (no bearer token required; only server-issued URLs are signed). |

> **Notes on API fields:**
> - `trashed` is the **Trash**. Lists, search, lookups, highlights and tags leave it out unless asked (`trashed=true|all`, `includeTrashed`); `/v1/sync` sends everything. Deleting a bookmark already in the Trash removes it permanently.
> - Tokens have scopes: `read` (GETs and URL lookups), `write` (changes), `delete` (DELETEs and batch deletes), `admin` (settings and imports); a missing one is a 403 `FORBIDDEN`. Tokens made before scopes existed have all four.
> - `coverProxy` is a computed server-relative proxy path (or `null` without an HTTP(S) cover) for cover images hosted on domains that reject hotlinks (such as WeChat and CSDN).
> - If a short link is dead or lands on a login wall or site homepage, lofu saves the original URL rather than overwriting it with the dead target.

## Architecture and Benchmarks

All performance numbers below were measured on the dev box (32 cores, loopback) running the real stack.

### Core Design Decisions

| Area | Decision | Measured Impact & Rationale |
| --- | --- | --- |
| **Runtime** | Bun, preferring built-ins (`bun:sqlite`, zstd, workers, `fetch`) | Fewer dependencies and native-speed primitives. |
| **Storage** | SQLite in WAL mode, 64 MiB page cache, 256 MiB mmap, prepared statements only | API list/sync: **~15–18k req/s, p50 ≈ 2 ms** at 32 concurrent requests. |
| **Change feed** | Single global `seq` counter allocated in memory on every write | Feeds both client delta sync (`/v1/sync`) and the search indexer; gap-free with a single main-thread writer and zero counter-row contention. |
| **Search** | Meilisearch returns **IDs only**; SQLite hydrates records and snippets are cut locally | Letting Meilisearch crop/highlight bodies cut throughput from **~35k to ~620 req/s**. Local snippets deliver **~4k req/s** (p50 7.7 ms), or **~13k req/s** with `snippets=false`. |
| **Content storage** | Article HTML, Markdown, and text stored zstd-compressed in a separate table | 866 MB of fetched HTML across 897 bookmarks compressed to **16 MB**. Lists never page in large blobs, and `/content` streams stored zstd bytes at zero CPU cost. |
| **Job queue** | Durable SQLite queue, up to 64 jobs in flight; interactive saves preempt randomized bulk jobs | Importing 1,161 Raindrop rows takes **31 ms** without starving interactive saves or other hosts. |
| **Indexing** | Incremental, batched, driven by `seq`; cursor advances only after Meilisearch confirms | Bursts collapse into a few batches; a Meilisearch outage simply catches up upon recovery. |
| **CLI** | Rust (`clap` + `ureq`), 2.6 MB static binary | `lofu ls`: **0.7 ms** round trip; `--help`: **0.3 ms** (vs. ~2 ms startup and ~86 MB for a compiled Bun binary). |
| **Auth** | 256-bit bearer tokens, SHA-256 hashed, verified once and cached in memory | Avoids per-request KDF overhead; revocation takes effect within 60 s. |

### Content Extraction & Media Pipeline

- **Worker-thread extraction**: Defuddle + linkedom run on a worker-thread pool that replaces timed-out workers. Defuddle costs ~450 ms CPU per large page (pre-stripping scripts/styles saved almost nothing), so worker parallelism keeps the API event loop responsive.
- **Fetching**: Attempts HTTP/2 first for HTTPS with remembered per-host HTTP/1.1 fallback (some hosts such as `paulgraham.com` return 500 on HTTP/1.1), global + per-host concurrency limits, and CJK charset detection (GBK, Big5, Shift_JIS).
- **Hard pages & bot walls**: Unreadable responses are detected rather than stored as junk. 401/403 bot walls and JS-only shells fall back to headless Chromium over raw CDP (blocking images, fonts, and media and polling until challenges clear). HTTP 200 captcha/challenge pages are detected, WeChat rate-limit captchas back off that host, PDFs are extracted via Poppler, and arXiv papers pull titles/abstracts from their abstract pages. On a real 897-link Raindrop library, honest failures dropped from **195 to 126** while extracted pages rose to **736** (Weibo, Notion, Feishu, and Google Docs now extract cleanly; Cloudflare Turnstile and Zhihu/Xiaohongshu login walls remain best saved via the browser extension).
- **Site adapters** ([`apps/server/src/extract/sites/`](apps/server/src/extract/sites)): Per-site hooks can customize fetch behavior, call APIs directly, skip futile browser fallbacks, or rewrite parsed DOM before Defuddle runs (for both server fetches and extension captures). Includes adapters for GitHub (API READMEs with optional `LOFU_GITHUB_TOKEN`, raw files), WeChat (article body, author, publish date), V2EX (honest UA + replies), Xiaohongshu (page-state extraction + login-wall detection), and Zhihu (fast fail with actionable advice). On a 15-bookmark sample, a large GitHub README grew from **104 to 19,870 words**, all 203 WeChat articles gained missing publish dates, and 46 of 47 Xiaohongshu error pages stopped being stored as `ok`.
- **Clean Markdown, SVG figures & Math** ([`apps/server/src/extract/markdown.ts`](apps/server/src/extract/markdown.ts)): Rewrites HTML constructs that raw Markdown drops before conversion — inline SVG diagrams are sanitized and stored as images under `/figures/<hash>` ([`extract/figures.ts`](apps/server/src/extract/figures.ts)), KaTeX/MathML stay TeX (`$…$`, `$$…$$`) and are rendered as signed SVGs via MathJax (`/math/`), merged-cell tables are flattened cleanly, and tag-like prose stays text. Bumping `MARKDOWN_VERSION` re-converts stored HTML off-thread. Across 731 saved articles, 131 with raw HTML were cleaned with zero changes to the other 600 in **~1.7 s** of worker CPU.
- **Article images & proxy cache**: Images stay at their original URLs, are probed for dimensions (PNG, GIF, JPEG with EXIF rotation, WebP, AVIF, SVG) so native readers lay them out without 0&times;0 jumps, and load through `/img/<signature>?u=` without a `Referer` (avoiding WeChat/CSDN hotlink blocks). With `&w=1360`, wide JPEG/PNG/WebP assets are resized to WebP off the main thread via `Bun.Image`, deduplicated in-flight, and LRU-cached on disk (`data/server/images/`, bounded by `LOFU_IMAGE_CACHE_MB`, default `2048`). On a real library, **94% of 1,305 images** were measured; a GitHub README with 471 screenshots shrank from **122 MB to 35 MB**, with cached images serving in **~20 ms** (vs. 0.4–2.7 s origin fetches) and all 471 loading in **3.3 s** instead of **55 s**.

## Development

Run the full verification suite before opening a PR:

```sh
bun test                         # server & shared tests (Meilisearch tests skip if MEILI_URL is unset)
bun run typecheck                # TypeScript 7 (server, shared, extension)
bun run lint                     # Biome check
cargo clippy -p lofu-cli         # Rust CLI lints
bun run ext:e2e                  # browser extension end-to-end tests in Chrome for Testing
bun run reader:test              # Native Shell reader headless checks
```

See [`CLAUDE.md`](CLAUDE.md) for core architectural invariants (single-writer `seq` ordering, append-only SQLite migrations, bounded prepared SQL shapes, and extraction quality guards).

## License

Licensed under the [MIT License](LICENSE).

Reader icons are from [Lucide](https://lucide.dev) (ISC). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full third-party license notices.
