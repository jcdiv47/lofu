# lofu

Self-hosted bookmarks and read-later, in the spirit of Raindrop.io and Pocket. It runs on a home server and you reach it over your LAN or Tailscale. Clients: web, iOS, macOS, and a CLI built for agents.

```
apps/server       Bun + Hono API, SQLite, job queue, extraction workers, search indexer
packages/shared   zod schemas (API contract → OpenAPI) and URL normalization
crates/lofu-cli   `lofu` CLI in Rust
apps/extension    Browser extension (WXT; Chrome/Edge/Brave and Firefox)
apps/reader       The app on nsh (TSX) for macOS, iOS and the web: library, search, reading, highlights; see its README
skills/lofu       Agent skill describing the CLI
docker/           compose stack (server + Meilisearch) and Dockerfile
```

Still to come: the Safari extension. See the roadmap below.

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
bun run stack:up                    # builds and starts server, Meilisearch and the browser
bun run stack:token create phone
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

The server binds to loopback only and the other two containers publish nothing to your network (Meilisearch takes `127.0.0.1:7700` for debugging). `tailscale serve` (not `tailscale funnel`, which would put it on the internet) gives you `https://<machine>.<tailnet>.ts.net` with a real certificate, which iOS App Transport Security requires. Back up `data/server/` (SQLite). `data/meili/` is derived and can be rebuilt with `bun src/admin.ts reindex`. Update the browser container now and then: `docker compose -f docker/compose.yaml pull browser && bun run stack:up`.

### What a saved page can't do

Saving a page means fetching what it points to and, for JavaScript-only pages, running its scripts. So:

- **No requests to your network.** Page fetches, redirects (each hop), image probes, the image proxy, short-link hops and every request the browser makes must go to public addresses (`apps/server/src/extract/netguard.ts`). Loopback, private, link-local, CGNAT/Tailscale and their IPv6 forms are refused, so a bookmark can't reach your router, the tailnet or the other containers. `LOFU_FETCH_PRIVATE=1` lifts this for bookmarking pages on your LAN. What's left: a DNS server that answers differently on the second lookup can get one blind request through, and the browser's WebSockets aren't checked.
- **Chromium runs in its own container** (`chromedp/headless-shell`, as `nobody`, read-only, no capabilities, no volumes, on a network shared only with the server), so a browser exploit finds no database or keys. Without Docker, the server launches a local Chromium on demand.
- **Stored HTML doesn't run on the API's origin**: `/content?format=html` is served with a sandbox CSP, and `/img` with one too.
- `LOFU_AUTH_DISABLED=1` is refused unless the server listens on loopback.

## Architecture and performance decisions

Numbers below were measured on the dev box (32 cores, loopback) with the real stack.

| Area | Decision | Why |
|---|---|---|
| Runtime | Bun, using built-ins where they exist (`bun:sqlite`, zstd, workers, fetch) | Fewer dependencies and native-speed primitives. |
| Storage | SQLite in WAL mode, a 64 MiB page cache, 256 MiB mmap, prepared statements only | API list/sync: **~15–18k req/s, p50 ≈ 2 ms** at 32 concurrent requests. |
| Change feed | One global `seq` number, allocated in memory and assigned on every write | One change number feeds both client delta sync (`/v1/sync`) and the search indexer. It's gap-free because the main thread is the only writer, and there's no counter row to contend on. |
| Extraction | Defuddle + linkedom on a **worker-thread pool** that replaces timed-out workers | Defuddle costs ~450 ms CPU per large page. Pre-stripping scripts and styles (a candidate for a Rust pre-pass) saved almost nothing, so parallelism is the fix. The API's event loop never blocks. |
| Fetching | HTTP/2 first for https with fallback to HTTP/1.1 (remembered per host); global + per-host concurrency caps; charset detection | Some sites reject HTTP/1.1 clients (paulgraham.com returns 500). GBK, Big5 and Shift_JIS pages decode correctly. |
| Hard pages | Unreadable pages are recognized and handled instead of being saved as junk. **401/403 bot walls** and **JavaScript-only pages** fall back to headless Chromium, driven over raw CDP: launched on demand and closed when idle, or in the Docker stack a container of its own. It blocks images, fonts and media, and polls until the page stops looking like a challenge. **Captcha/challenge pages** served with a 200 are detected. Rate-limit captchas (WeChat) slow down that host instead. **PDFs** get full text via poppler, and arXiv titles and abstracts come from the abstract page. | On a real 897-link Raindrop library, honest failures fell from 195 to 126 while extracted pages rose to 736. Weibo, Notion, Feishu and Google Docs now work. The ones that still fail: Cloudflare Turnstile (Medium, linux.do) and the login walls of Zhihu and Xiaohongshu. Those need HTML from your own browser (the `html` field, or the extension). |
| Site adapters | Per-site steps around the generic pipeline, in `apps/server/src/extract/sites/`. An adapter can set fetch options, replace the fetch (an API), skip a browser fallback that never works, and edit the parsed page in the worker before Defuddle runs (for every HTML source, the extension included). GitHub repos get their README from the API (set `LOFU_GITHUB_TOKEN` to lift the 60-an-hour limit) and files are fetched raw. WeChat keeps only the article and reads its author and date. V2EX is fetched with an honest user agent and keeps replies. Xiaohongshu notes are built from the page state, and its login-wall page fails instead of being stored. Zhihu fails at once with advice instead of a futile browser render. A 403 for our Chrome user agent is retried once with an honest one before the browser. | Re-fetching a sample of 15 real bookmarks: the README of a large GitHub repo went from 104 to 19,870 words. V2EX and two Cloudflare-fronted blogs went from failed to extracted. WeChat articles gained publish dates (missing on all 203 before). 46 of 47 Xiaohongshu bookmarks held the same 97-word error page as `ok`; re-fetched, they fail with advice instead. |
| Markdown | Defuddle's cleaned HTML, converted by its own converter after rewriting what Markdown can't express (`apps/server/src/extract/markdown.ts`): inline SVG diagrams become their accessible name, MathJax formulas their text (xₘₐₓ = (a − b)/σ), `sup`/`sub` raised characters, players a link, tables with merged cells a Markdown table (or, for forum layouts, their content). Text that only looks like a tag stays text. Saved articles are converted again from their stored HTML, off-thread, when `MARKDOWN_VERSION` goes up. | Defuddle keeps those as raw HTML, which the app's editor shows as literal tags: 131 of 731 saved articles had some. After the backfill none do, and the other 600 are byte-for-byte unchanged. The backfill took ~1.7 s of worker CPU. |
| Content storage | Article HTML, markdown and text stored zstd-compressed, in a separate table | 866 MB of fetched HTML for 897 bookmarks became **16 MB** stored. Lists never page in large blobs. `/content` sends the stored zstd bytes unchanged to clients that accept zstd, at zero CPU cost. |
| Article images | Images stay at their original URLs. After extraction a job reads the first bytes of each one for its size (PNG, GIF, JPEG with EXIF rotation, WebP, AVIF, SVG), and readers load them through `/img/<signature>?u=`, a signed proxy that fetches without a Referer. Article images come with `&w=1360` (twice the reader's measure): JPEG, PNG and WebP wider than that are resized to WebP with `Bun.Image`, off the main thread. What the proxy fetched is kept on disk (`data/server/images/`, derived, least recently used out past `LOFU_IMAGE_CACHE_MB`, 2048 by default), and a picture asked for twice at once is fetched once | nsh's `RichEditor` lays out an image only at an explicit size, so unmeasured images showed at 0×0. WeChat and CSDN answer another site's Referer with a placeholder or a 403. On a real library, 94% of 1,305 images were measured; most of the rest are gone (404) or behind Cloudflare. Bookmarks saved before this are measured by a background backfill at startup. A GitHub README with 471 screenshots went from **122 MB to 35 MB**; a picture the proxy has kept takes **~20 ms** instead of 0.4–2.7 s (the site, every time), and all 471 come in 3.3 s instead of 55 s. |
| Search | Meilisearch returns **ids only**; bookmarks are hydrated from SQLite, and snippets are cut locally | Letting Meilisearch crop/highlight article bodies cut throughput from **~35k to ~620 req/s**. With local snippets: **~4k req/s** (p50 7.7 ms), or **~13k req/s** with `snippets=false`. |
| Jobs | Durable SQLite queue; up to 64 jobs in flight (waiting ones are just parked promises); interactive work before bulk; random order within bulk | Importing 1,161 Raindrop rows takes **31 ms**, and the import never starves interactive saves or the other hosts. |
| Indexing | Incremental and batched, driven by `seq`. The cursor only advances after Meilisearch confirms the write. | Bursts (imports) collapse into a few batches. A Meilisearch outage just means indexing catches up later. |
| CLI | Rust (clap + ureq), 2.6 MB static binary | `lofu ls`: **0.7 ms** round trip; `--help`: 0.3 ms. A compiled Bun binary would start in ~2 ms and weigh ~86 MB. |
| Auth | 256-bit bearer tokens, SHA-256 hashed, verified once and cached in memory | No KDF on every request. Revocation takes effect within 60 s. |

## Browser extension

```sh
bun run ext:build      # → apps/extension/.output/chrome-mv3 and firefox-mv3
```

Chrome/Edge/Brave: open `chrome://extensions`, turn on developer mode, and use *Load unpacked* on `apps/extension/.output/chrome-mv3`. Firefox: `about:debugging` → *Load Temporary Add-on* (or `bun run --cwd apps/extension zip` to produce a zip you can sign). Then enter the server address and a token in the options page.

- **Saved-page indicator:** a persistent blue ✓ on the toolbar icon marks pages already in your library (not in Trash). Status is checked on navigation/tab activation and after extension edits; changes from other clients appear on the next activation or periodic refresh. URLs are looked up on your configured server; page contents are not sent for these checks.
- **Saving:** the toolbar button or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> saves the page the moment the popup opens. Tags, collection, note and favorite autosave. Right-click menus save a page or a link.
- **Pages are sent as your browser rendered them**, so pages behind your logins and bot checks (Zhihu, Medium, V2EX) save in full. Bodies over 32 KB are gzipped.
- **Auto-repair (opt-in):** when you revisit a saved page the server couldn't read, the extension sends it. Repair checks use a local list of those URLs, with no extra URL lookups beyond the saved-page indicator. The options page lists the pages that need a visit.
- **Permissions:** `tabs` reads page URLs for the saved-page indicator. Saving uses `activeTab`, the access a browser grants when you click the button, use the shortcut or right-click. All-sites access is requested only when you turn on auto-repair. The server allows extension origins through CORS, and every request still needs your token.

`bun run ext:e2e` builds the extension and drives it in Chrome for Testing against a real server: popup save of a 403 bot wall, autosave, the "on shelf" state, auto-repair. Screenshots go to `apps/extension/e2e/screens/`.

## Saving from the iOS share sheet

The app's share extension puts *lofu* in every app's share sheet (`apps/reader/share`, see `apps/reader/README.md`). Without it (a build made by `nsh package` alone), a Shortcut does the same, and it saves without opening the app. In the Shortcuts app, make a shortcut and, under its ⓘ, turn on *Show in Share Sheet* and let it receive URLs, Safari web pages and Text. Then add these actions:

1. **Get URLs from Input** (Shortcut Input). Share text from apps like Xiaohongshu or Douyin ("【Title】 http://xhslink.com/a/… 复制本条信息…") gives its link.
2. **Get Item from List**: First Item.
3. **Get Contents of URL**: `https://<your server>/v1/bookmarks`. Set Method to POST, add the header `Authorization` = `Bearer lofu_…`, and set Request Body to JSON with one field, `url` = *Item from List*.
4. **Show Notification**: "Saved to lofu".

For a share sheet that hands over nothing, or for Back Tap or the Action button, put **Get Clipboard** in front of step 1 when Shortcut Input has no value. Short links are followed by the server, so a t.co or t.cn link saves the article it points to.

## Importing from Raindrop.io

```sh
raindrop bookmark export --format csv | lofu import raindrop -   # or: lofu import raindrop export.csv
```

The import takes the CSV export from Raindrop (Settings → Export, or the `raindrop` CLI) and is safe to re-run. Folders become collections. Tags, notes, excerpts, highlights, favorites and the original save dates are carried over. Duplicates within the export are merged, since URLs are compared after normalization. Raindrop's `rdl.ink` screenshot covers are dropped in favor of the page's own image. Unfetchable URLs such as `chrome-extension://` are skipped and listed in the report. Placeholder titles (the URL, a file name, "Webpage: x") aren't kept, so the real title wins. Pages are then fetched in the background at **bulk priority**, so anything you save meanwhile is fetched first. Bulk jobs run in random order and each host is limited to one request per `LOFU_FETCH_HOST_INTERVAL_MS` (default 1 s), so a backlog of WeChat links doesn't block other sites or trip rate limits.

## API

The OpenAPI 3.1 document is served at `/openapi.json`, generated from the zod schemas in `packages/shared`. Main endpoints:

- `POST /v1/bookmarks`: idempotent on the normalized URL (tracking params, `www.`, fragments and scheme are ignored). Pass `html` to skip fetching (for pages behind a login). Without `html`, short links (t.co, t.cn, xhslink.com, b23.tv, bit.ly…) are followed and wrapper pages (`weibo.cn/sinaurl?u=`, `link.zhihu.com/?target=`) unwrapped first, so the bookmark is the page they lead to. A short link that dies or ends on a login wall or its site's home page is saved as given.
- Bookmarks: `archived` means **in the Trash** (the field kept its old name). Clients show it as the Trash, and deleting from there deletes for good. `coverProxy` is the cover through the image proxy below (computed, a path relative to the server; null without an http(s) cover), for covers whose hosts refuse hotlinks (WeChat, CSDN).
- `GET /v1/bookmarks` (keyset pagination; filters `collectionId`, `tags`, `archived`, `favorite`, `type`), `GET|PATCH|DELETE /v1/bookmarks/{id}`, `POST /v1/bookmarks/{id}/refetch`, `GET /v1/bookmarks/{id}/content?format=markdown|html|text`. With `?content=markdown`, `GET /v1/bookmarks/{id}` also lists the article's `images`: each one's `src`, measured `width`/`height`, and `proxy` path.
- `GET /img/<signature>?u=<url>`: an article image or cover through the server (no token: the signature is the authorization, and only URLs the API handed out are signed)
- `POST /v1/tags/rename` (`{from, to}`; merges into `to` where a bookmark already has it) and `DELETE /v1/tags/{name}`: change every bookmark with the tag and return `{updated}`
- `GET /v1/search`, `GET /v1/tags`, `/v1/collections` (deleting one moves its bookmarks to Unsorted), `/v1/bookmarks/{id}/highlights`, `/v1/highlights/{id}`
- `GET /v1/sync?since=<cursor>`: everything changed since the cursor, deletions included
- `POST /v1/import/raindrop` (body: the CSV file): returns an import report
- `GET /v1/bookmarks/lookup?url=`: the bookmark for any variant of a URL. Request bodies may be `Content-Encoding: gzip`.

## Roadmap

1. More importers as needed: Netscape bookmark HTML (browsers), Pocket export.
2. Per-site cookies for the browser fallback (Zhihu and other login walls); screenshot thumbnails.
3. **Permanent copies**: single-file archives via `monolith`; periodic broken-link checks.
4. **Clients**: the nsh app (`apps/reader`) runs on macOS, iOS and the web: a sidebar and card grid on the Mac, a native navigation stack on the phone, both over a `/v1/sync` mirror (findings in `apps/reader/README.md`; a Linux desktop app is deferred). The apps keep the reading list and changes on the device for offline use, track reading progress, and edit titles, tags, notes, collections and tags. Next: verify long-press selection, highlighting and reading progress on an iPhone by hand. The extension's Safari build comes along with the Apple apps.
5. Semantic search (a Meilisearch embedder, e.g. Ollama → `MEILI_EMBEDDER`), suggested tags, text-to-speech.
