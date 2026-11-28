import { type ImportReport, normalizeUrl } from "@lofu/shared";
import type { Db } from "../db/index.ts";
import type { BookmarkStore } from "../store/bookmarks.ts";
import type { CollectionStore } from "../store/collections.ts";
import type { HighlightStore } from "../store/highlights.ts";
import { Priority } from "../store/jobs.ts";
import { parseCsvRecords } from "./csv.ts";

/**
 * Imports a Raindrop.io CSV export (Settings → Export, or
 * `raindrop bookmark export --format csv`). Columns:
 * id, title, note, excerpt, url, folder, tags, created, cover, highlights, favorite.
 *
 * Re-importing is safe: bookmarks dedupe on the normalized URL (tags merge),
 * collections match by name, and highlights dedupe on their text.
 */
export interface ImportDeps {
  db: Db;
  bookmarks: BookmarkStore;
  collections: CollectionStore;
  highlights: HighlightStore;
}

const REQUIRED = ["url", "title", "folder", "tags", "created"];
/** Raindrop's own screenshot service; dropped so extraction picks the page's image. */
const RAINDROP_RENDER_HOSTS = new Set(["rdl.ink", "render.raindrop.io"]);

const trimOrUndef = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/**
 * Highlights column: one highlight per `Highlight:` line; a following
 * `Note:` line attaches a note to it.
 */
export function parseRaindropHighlights(cell: string): { quote: string; note?: string }[] {
  const out: { quote: string; note?: string }[] = [];
  for (const raw of cell.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^highlight:/i.test(line)) out.push({ quote: line.slice(10).trim() });
    else if (/^note:/i.test(line) && out.length) {
      const last = out[out.length - 1]!;
      last.note = [last.note, line.slice(5).trim()].filter(Boolean).join("\n");
    } else if (out.length) {
      // Continuation of a multi-line highlight.
      const last = out[out.length - 1]!;
      if (last.note === undefined) last.quote += `\n${line}`;
      else last.note += `\n${line}`;
    }
  }
  return out.filter((h) => h.quote);
}

/**
 * Titles that are just the URL, the file name, the domain or a "Webpage: x"
 * stub. Importing these would lock a junk title over the page's real one
 * (e.g. arXiv PDFs saved as "1910.10683.pdf").
 */
export function isPlaceholderTitle(title: string, url: string): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (/^(webpage|网页)\s*[:：]/.test(t)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const bare = (s: string) => s.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let decoded = url;
  try {
    decoded = decodeURI(url);
  } catch {}
  const file = u.pathname.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  return (
    bare(t) === bare(url.toLowerCase()) ||
    bare(t) === bare(decoded.toLowerCase()) ||
    t === host ||
    t === host.replace(/^www\./, "") ||
    (file !== "" && t === file)
  );
}

function coverOf(cell: string): string | undefined {
  const url = trimOrUndef(cell);
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (RAINDROP_RENDER_HOSTS.has(u.hostname)) return undefined;
    return u.protocol === "https:" || u.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function importRaindropCsv(csv: string, deps: ImportDeps): ImportReport {
  const t0 = performance.now();
  const records = parseCsvRecords(csv);
  const first = records[0];
  if (first) {
    const missing = REQUIRED.filter((k) => !(k in first));
    if (missing.length) {
      throw new RangeError(`not a Raindrop CSV export (missing columns: ${missing.join(", ")})`);
    }
  }

  const report: ImportReport = {
    total: records.length,
    created: 0,
    merged: 0,
    skipped: [],
    collectionsCreated: [],
    highlightsAdded: 0,
    queued: 0,
    durationMs: 0,
  };

  const collectionIds = new Map<string, string>();
  for (const c of deps.collections.list()) {
    if (c.parentId === null && !collectionIds.has(c.name)) collectionIds.set(c.name, c.id);
  }
  const collectionFor = (folder: string): string | null => {
    const name = folder.trim();
    // Raindrop's export names its system collection "Unsorted".
    if (!name || name === "Unsorted") return null;
    let id = collectionIds.get(name);
    if (!id) {
      id = deps.collections.create({ name }).id;
      collectionIds.set(name, id);
      report.collectionsCreated.push(name);
    }
    return id;
  };

  const queued = new Set<string>();
  const existingQuotes = deps.db.query<{ quote: string }, [string]>(
    "SELECT quote FROM highlights WHERE bookmark_id = ? AND deleted_at IS NULL",
  );

  // One transaction: ~1k rows commit in milliseconds and the import is all-or-nothing
  // except for rows skipped individually below.
  deps.db.transaction(() => {
    records.forEach((r, idx) => {
      const rowNum = idx + 2; // 1-based, after the header
      const url = (r.url ?? "").trim();
      try {
        normalizeUrl(url); // reject unsupported URLs before creating their collection
        const created = Date.parse(r.created ?? "");
        const tags = (r.tags ?? "")
          .split(",")
          .map((t) => t.trim().toLowerCase().slice(0, 64))
          .filter(Boolean);
        const { bookmark, created: isNew } = deps.bookmarks.create(
          {
            url,
            title: isPlaceholderTitle(r.title ?? "", url)
              ? undefined
              : trimOrUndef(r.title)?.slice(0, 1000),
            note: trimOrUndef(r.note),
            excerpt: trimOrUndef(r.excerpt),
            coverUrl: coverOf(r.cover ?? ""),
            tags,
            collectionId: collectionFor(r.folder ?? ""),
            favorite: r.favorite?.trim() === "true" ? true : undefined,
            createdAt: Number.isFinite(created) ? new Date(created).toISOString() : undefined,
          },
          // Importing again mustn't take what the user trashed out of the Trash.
          { priority: Priority.bulk, restoreFromTrash: false },
        );
        if (isNew) report.created++;
        else report.merged++;
        if (bookmark.contentStatus === "pending") queued.add(bookmark.id);

        const hs = parseRaindropHighlights(r.highlights ?? "");
        if (hs.length) {
          const have = new Set(existingQuotes.all(bookmark.id).map((h) => h.quote));
          for (const h of hs) {
            if (have.has(h.quote)) continue;
            deps.highlights.create(bookmark.id, {
              quote: h.quote,
              prefix: "",
              suffix: "",
              note: h.note ?? null,
            });
            have.add(h.quote);
            report.highlightsAdded++;
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        report.skipped.push({
          row: rowNum,
          url,
          reason: /scheme|Invalid URL|cannot be parsed/i.test(msg)
            ? `unsupported URL: ${msg}`
            : msg,
        });
      }
    });
  })();

  report.queued = queued.size;
  report.durationMs = Math.round(performance.now() - t0);
  return report;
}
