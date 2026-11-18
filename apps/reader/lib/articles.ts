import { computed, Storage, signal } from "nsh";
import {
  type ArticleFormula,
  type ArticleImage,
  api,
  type Bookmark,
  formulaUrl,
  type Highlight,
  OfflineError,
} from "./api";
import {
  filePath,
  listText,
  onDisk,
  picturesOnDisk,
  readText,
  removeText,
  sizeOf,
  writeBytes,
  writeText,
} from "./files";
import { inks } from "./look";

/**
 * Articles kept on the device for reading offline (files: `lib/files.ts`).
 * Every article opened is kept, and after a sync the ones `keepMode` asks
 * for are fetched in the background, so the reading list is there on a
 * plane and opens without waiting for the server. Their pictures are kept
 * beside them, as files of the app's own (`picture-<id>-<hash of the URL>`)
 * rather than in nsh's image cache, which holds 256 MB for every image the
 * app shows and which the system may clear. The reader shows the kept
 * copies, online too. The web keeps none, and phones keep the text only
 * (`picturesOnDisk`): nsh shows no image from a file there, so their
 * pictures load from the server, through nsh's cache.
 */
export interface Kept {
  markdown: string | null;
  images: ArticleImage[];
  /** Formula pictures (copies kept before there were any have none). */
  formulas?: ArticleFormula[];
  highlights: Highlight[];
}

const PREFIX = "article-";
const file = (id: string) => `${PREFIX}${id}.json`;
const idOf = (name: string) => name.slice(PREFIX.length, -".json".length);
const PICTURE = "picture-";
/** How many unread articles `"recent"` fetches ahead. */
export const AHEAD = 80;
/** Articles fetched at once: enough to fill a short wait, few enough for a home server. */
const AT_ONCE = 3;

// ---- What is kept ahead -------------------------------------------------

/**
 * Which articles are fetched ahead: none (only those opened), the newest
 * unread ones, every unread one, or every readable one outside the Trash.
 */
export type KeepMode = "opened" | "recent" | "unread" | "all";

export const keepModes: { mode: KeepMode; label: string }[] = [
  { mode: "recent", label: `The newest ${AHEAD} unread` },
  { mode: "unread", label: "Everything unread" },
  { mode: "all", label: "Everything" },
  { mode: "opened", label: "Only what I open" },
];

const MODE_KEY = "offline.v1";
export const keepMode = signal<KeepMode>("recent");
void Storage.getItem(MODE_KEY)
  .then((v) => {
    if (v && keepModes.some((m) => m.mode === v)) keepMode.set(v as KeepMode);
  })
  .catch(() => {});

export function setKeepMode(mode: KeepMode) {
  keepMode.set(mode);
  void Storage.setItem(MODE_KEY, mode).catch(() => {});
}

/** The bookmarks `mode` keeps on the device, in the order given (newest first). */
export function toKeep(all: Bookmark[], mode: KeepMode): Bookmark[] {
  if (mode === "opened") return [];
  const readable = all.filter((b) => !b.archived && !b.deletedAt && b.contentStatus === "ok");
  if (mode === "all") return readable;
  const unread = readable.filter((b) => b.readProgress < 0.98);
  return mode === "unread" ? unread : unread.slice(0, AHEAD);
}

// ---- What is on the device ----------------------------------------------

/** Ids of the articles on the device, as the files say (read once at launch). */
const keptIds = signal(new Set<string>(), { equals: false });
if (onDisk) {
  void listText(PREFIX).then((names) =>
    keptIds.update((s) => {
      for (const n of names) s.add(idOf(n));
      return s;
    }),
  );
  // Pictures an earlier version kept on a phone, which nsh never showed.
  if (!picturesOnDisk) {
    void listText(PICTURE).then(async (names) => {
      for (const name of names) await removeText(name);
    });
  }
}

/** Whether the article `id` can be read without the server. */
export const isKept = (id: string) => keptIds().has(id);
export const keptCount = computed(() => keptIds().size);

const mark = (id: string, kept: boolean) =>
  keptIds.update((s) => {
    if (kept) s.add(id);
    else s.delete(id);
    return s;
  });

/** The bytes the kept articles take, with their pictures. */
export const keptBytes = async () => (await sizeOf(PREFIX)) + (await sizeOf(PICTURE));

/**
 * Articles whose pictures are all kept (or given up on), so a sync doesn't
 * look for them again: in `Storage`, not in the article's file, which the
 * reader rewrites as highlights change.
 */
const PICTURES_KEY = "offline.pictures.v1";
let pictured: Set<string> | null = null;
const loadPictured = async () => {
  if (pictured) return pictured;
  try {
    const raw = await Storage.getItem(PICTURES_KEY);
    pictured = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    pictured = new Set();
  }
  return pictured;
};
const savePictured = () =>
  pictured ? Storage.setItem(PICTURES_KEY, JSON.stringify([...pictured])).catch(() => {}) : null;

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
  if (onDisk && (await writeText(file(id), JSON.stringify(a)))) mark(id, true);
}

export async function removeArticle(id: string): Promise<void> {
  if (!onDisk) return;
  await removeText(file(id));
  for (const name of await listText(`${PICTURE}${id}-`)) await removeText(name);
  mark(id, false);
  if ((await loadPictured()).delete(id)) await savePictured();
}

export async function clearArticles() {
  for (const name of await listText(PREFIX)) await removeText(name);
  for (const name of await listText(PICTURE)) await removeText(name);
  keptIds.set(new Set());
  pictured = new Set();
  await Storage.removeItem(PICTURES_KEY).catch(() => {});
}

/** The article and its highlights from the server, kept for next time. */
export async function fetchArticle(id: string): Promise<Kept> {
  const [{ markdown, images, formulas }, highlights] = await Promise.all([
    api.article(id),
    api.highlights(id),
  ]);
  const a = { markdown, images, formulas, highlights };
  if (markdown) await keepArticle(id, a);
  return a;
}

/** Where the article's pictures load from, as the reader loads them. */
export function pictureUrls(a: Pick<Kept, "images" | "formulas">): string[] {
  const urls = a.images.map((i) => i.proxy ?? i.src);
  // A formula in the ink of each appearance: the system's may change offline.
  for (const f of a.formulas ?? []) urls.push(...inks.map((ink) => formulaUrl(f, ink)));
  return [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
}

/** FNV-1a: a short, stable name for a picture's URL. */
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
/** The file a picture of the article `id` is kept in. */
export const pictureFile = (id: string, url: string) => `${PICTURE}${id}-${hash(url)}`;
/** Pictures of one article fetched at once. */
const PICTURES_AT_ONCE = 3;

/**
 * The article with its kept pictures shown from their files, for showing
 * (the copy on the disk keeps the URLs it came with). Where nsh shows no
 * file (phones), unchanged.
 */
export async function withKeptPictures(id: string, a: Kept): Promise<Kept> {
  if (!picturesOnDisk || !(a.images.length || a.formulas?.length)) return a;
  const here = new Set(await listText(`${PICTURE}${id}-`));
  if (!here.size) return a;
  const local = (url: string) => {
    const name = pictureFile(id, url);
    return here.has(name) ? filePath(name) : null;
  };
  return {
    ...a,
    images: a.images.map((i) => {
      const path = local(i.proxy ?? i.src);
      return path ? { ...i, proxy: path } : i;
    }),
    formulas: a.formulas?.map((f) => {
      const kept: Record<string, string> = {};
      for (const url of inks.map((ink) => formulaUrl(f, ink))) {
        const path = local(url);
        if (path) kept[url] = path;
      }
      return { ...f, kept };
    }),
  };
}

/**
 * Downloads the article's pictures not kept yet, a few at a time, and
 * removes those it no longer shows (their URLs change when the server's
 * address or the size it serves them at does), but for those of `showing`,
 * the copy a reader has on screen. Resolves with whether it got all it
 * could: a picture its site no longer has (an error status, or not a
 * picture) is given up on; one that couldn't be reached is tried again later.
 * Where nsh shows no file (phones), it keeps none and removes any there.
 */
export async function keepPictures(
  id: string,
  a: Kept,
  showing?: Pick<Kept, "images" | "formulas">,
): Promise<boolean> {
  if (!onDisk) return false;
  const here = new Set(await listText(`${PICTURE}${id}-`));
  const urls = picturesOnDisk ? pictureUrls(a) : [];
  const shown = picturesOnDisk && showing ? pictureUrls(showing) : [];
  const wanted = new Set([...urls, ...shown].map((u) => pictureFile(id, u)));
  for (const name of here) {
    if (!wanted.has(name)) await removeText(name);
  }
  const todo = urls.filter((u) => !here.has(pictureFile(id, u)));
  let unreachable = false;
  await inTurn(todo, PICTURES_AT_ONCE, async (url) => {
    if (unreachable) return;
    try {
      const res = await fetch(url);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) return; // Gone, or not a picture.
      await writeBytes(pictureFile(id, url), await res.bytes());
    } catch {
      unreachable = true;
    }
  });
  const seen = await loadPictured();
  if (!unreachable && !seen.has(id)) {
    seen.add(id);
    await savePictured();
  }
  return !unreachable;
}

// ---- Fetching ahead ------------------------------------------------------

/** Fetching ahead: how far along it is, while it runs. */
export const downloading = signal<{ done: number; total: number } | null>(null);

let prefetching = false;
/**
 * Not asked again this session: bookmarks the server had no text for, and
 * those whose pictures couldn't be reached (tried again next launch, or
 * when opened).
 */
const later = new Set<string>();

async function inTurn<T>(items: T[], n: number, f: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await f(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** The library to go over again once the running pass is done (asked during it), and whether to retry. */
let again: Bookmark[] | null = null;
let againRetry = false;

/**
 * Fetches the articles `keepMode` asks for that aren't kept yet, and the
 * pictures of those kept, a few at a time, and forgets those deleted or put
 * in the Trash. Stops quietly when the server can't be reached. Asked while
 * it runs (a sync, another choice in Settings), it goes over the library
 * again afterwards. `retry` (Download now) tries what this session gave up on.
 */
export async function prefetchArticles(all: Bookmark[], retry = false) {
  if (!onDisk) return;
  if (prefetching) {
    again = all;
    againRetry ||= retry;
    return;
  }
  if (retry) later.clear();
  prefetching = true;
  try {
    const kept = new Set((await listText(PREFIX)).map(idOf));
    const live = new Map(all.map((b) => [b.id, b]));
    for (const id of kept) {
      const b = live.get(id);
      if (!b || b.deletedAt || b.archived) {
        await removeArticle(id);
        kept.delete(id);
      }
    }
    const withPictures = await loadPictured();
    const todo = toKeep(all, keepMode()).filter(
      (b) => !later.has(b.id) && !(kept.has(b.id) && withPictures.has(b.id)),
    );
    if (!todo.length) return;
    let done = 0;
    let unreachable = false;
    downloading.set({ done, total: todo.length });
    await inTurn(todo, AT_ONCE, async (b) => {
      if (unreachable) return;
      try {
        const a = (kept.has(b.id) && (await keptArticle(b.id))) || (await fetchArticle(b.id));
        // The server's own failures stop it (below); a picture's site being
        // down doesn't.
        if (!a.markdown || !(await keepPictures(b.id, a))) later.add(b.id);
      } catch (e) {
        if (e instanceof OfflineError) unreachable = true;
      }
      downloading.set({ done: ++done, total: todo.length });
    });
  } finally {
    prefetching = false;
    downloading.set(null);
    const [next, nextRetry] = [again, againRetry];
    again = null;
    againRetry = false;
    if (next) void prefetchArticles(next, nextRetry);
  }
}
