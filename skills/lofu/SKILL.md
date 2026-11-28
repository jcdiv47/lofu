---
name: lofu
description: Search, read, save and organize the user's bookmarks and read-later articles with the `lofu` CLI. Use when the user mentions their bookmarks, saved links, reading list or highlights, asks to save or tag a URL, or wants to find something they read before.
---

# lofu CLI

`lofu` talks to the user's self-hosted bookmark server. When stdout is not a terminal it prints **compact JSON** (the server's API objects), so you can parse it directly. Errors go to stderr as JSON: `{"error": "...", "exitCode": N, "status": HTTP}`.

Exit codes: `0` ok · `2` usage · `3` not found · `4` unauthorized · `5` server unreachable · `6` invalid request or conflict (including content not ready, below) · `1` other.

## Finding things

```sh
lofu search sourdough hydration          # full text: title, tags, note, highlights, page content
lofu search rust async -t rust --sort newest -n 5
lofu search 副作用                        # CJK works
lofu ls -t essays -n 20                  # newest first, Trash left out; pass the returned nextCursor via --cursor
lofu ls --all -c unsorted                # follow every page
lofu ls --trashed true                   # only the Trash; --include-trashed (or --trashed all) for both
lofu tags                                # all tags with counts
lofu collections ls
```

Search hits are `{bookmark, snippet}`. In `snippet`, the matched terms are wrapped in `<mark>`.

`ls` and `search` leave the Trash out unless you pass `--trashed true` (only the Trash) or `--include-trashed` (everything). In the JSON, a bookmark in the Trash has `"trashed": true`.

`tags`, `collections ls` and `highlights` print the server's `{"items": [...]}`; `ls` prints `{"items": [...], "nextCursor": ...}`.

## Reading

```sh
lofu content <id>                  # extracted article as markdown (raw, not JSON)
lofu content <id> --format text    # plain text: fewest tokens
lofu get <id>                      # metadata only
lofu highlights <id>
```

`contentStatus` tells you whether the page has been extracted: `pending` (being fetched), `ok`, `skipped` (not read, e.g. a video or a site the user opens as a page) or `failed` (see `contentError`). Run `lofu refetch <id>` to retry.

`lofu content` without content exits `6` with `status` 409 (`CONTENT_PENDING`: wait a few seconds and try again) or 422 (`CONTENT_FAILED`, `CONTENT_SKIPPED`: it won't come by waiting); exit `3` means no such bookmark, or no content of that format.

## Saving and editing

```sh
lofu add <url> -t tag1,tag2 --note "why it matters"   # idempotent; re-adding merges tags
lofu add <url> --html page.html                       # use HTML you already have (e.g. behind a login)
lofu update <id> --add-tag later --remove-tag inbox   # atomic on the server: safe alongside other edits
lofu update <id> --trashed true  # move to the Trash (false restores it)
lofu update <id> --tags a,b      # replace all tags;  --collection none  → unsorted
lofu rm <id> [<id>...]           # deletes for good; prefer --trashed true unless the user asked to delete
lofu collections add "Reading list" [--parent <id>]
```

Tags are lowercased. Saving returns immediately with `contentStatus: "pending"`; extraction finishes in the background, usually within a few seconds.

## Importing

```sh
raindrop bookmark export --format csv | lofu import raindrop -   # idempotent; prints a report
```

## Setup

Configuration comes from `LOFU_URL` / `LOFU_TOKEN` or `~/.config/lofu/config.json`, written by `lofu login --url <server> --token <token>`. If you get exit code 5 or 4, tell the user; don't guess a different server.
