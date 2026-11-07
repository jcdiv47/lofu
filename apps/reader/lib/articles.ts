import { type ArticleImage, api, type Bookmark, type Highlight, OfflineError } from "./api";
import { listText, onDisk, readText, removeText, writeText } from "./files";

/**
 * Articles kept on the device for reading offline (files: `lib/files.ts`).
 * Every article opened is kept, and after a sync the newest unread ones are
 * fetched in the background, so the reading list is there on a plane. The
 * web keeps none. Images still load from the network.
 */
export interface Kept {
  markdown: string | null;
  images: ArticleImage[];
  highlights: Highlight[];
}

const PREFIX = "article-";
const file = (id: string) => `${PREFIX}${id}.json`;
/** How many unread articles are fetched ahead. */
const AHEAD = 80;

export async function keptArticle(id: string): Promise<Kept | null> {
  if (!onDisk) return null;
  try {
    const raw = await readText(file(id));
    return raw ? (JSON.parse(raw) as Kept) : null;
  } catch {
    return null;
  }
}

export async function keepArticle(id: string, a: Kept): Promise<void> {
  if (onDisk) await writeText(file(id), JSON.stringify(a));
}

export const removeArticle = (id: string) => (onDisk ? removeText(file(id)) : Promise.resolve());

export async function clearArticles() {
  for (const name of await listText(PREFIX)) await removeText(name);
}

/** The article and its highlights from the server, kept for next time. */
export async function fetchArticle(id: string): Promise<Kept> {
  const [{ markdown, images }, highlights] = await Promise.all([
    api.article(id),
    api.highlights(id),
  ]);
  const a = { markdown, images, highlights };
  if (markdown) await keepArticle(id, a);
  return a;
}

let prefetching = false;

/**
 * Fetches the newest unread articles not kept yet, one at a time (bulk work
 * stays out of the way), and forgets those deleted or put in the Trash.
 * Stops quietly when the server can't be reached.
 */
export async function prefetchArticles(all: Bookmark[]) {
  if (!onDisk || prefetching) return;
  prefetching = true;
  try {
    const kept = new Set(
      (await listText(PREFIX)).map((n) => n.slice(PREFIX.length, -".json".length)),
    );
    const live = new Map(all.map((b) => [b.id, b]));
    for (const id of kept) {
      const b = live.get(id);
      if (!b || b.deletedAt || b.archived) {
        await removeText(file(id));
        kept.delete(id);
      }
    }
    const wanted = all
      .filter(
        (b) => !b.archived && !b.deletedAt && b.contentStatus === "ok" && b.readProgress < 0.98,
      )
      .slice(0, AHEAD)
      .filter((b) => !kept.has(b.id));
    for (const b of wanted) {
      try {
        await fetchArticle(b.id);
      } catch (e) {
        if (e instanceof OfflineError) return;
      }
    }
  } finally {
    prefetching = false;
  }
}
