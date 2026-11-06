import { computed, Storage, signal } from "nsh";
import { api, type Bookmark, type BookmarkPatch, type Collection } from "./api";
import { plainExcerpt } from "./format";

/**
 * A local mirror of the library, kept current with `/v1/sync` (every write on
 * the server bumps `seq`, deletions arrive as tombstones). Lists, counts and
 * filters are computed here, so switching sources is instant and works offline.
 */

/** What the library is showing. */
export type Source =
  | { kind: "all" }
  | { kind: "unsorted" }
  | { kind: "favorites" }
  | { kind: "highlights" }
  | { kind: "archive" }
  | { kind: "collection"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "type"; type: BookmarkType };

export type BookmarkType = Bookmark["type"];

export const sameSource = (a: Source, b: Source) =>
  a.kind === b.kind &&
  (a.kind !== "collection" || a.id === (b as { id: string }).id) &&
  (a.kind !== "tag" || a.name === (b as { name: string }).name) &&
  (a.kind !== "type" || a.type === (b as { type: BookmarkType }).type);

const SNAPSHOT_KEY = "library.v1";

const byId = signal(new Map<string, Bookmark>(), { equals: false });
const collectionsById = signal(new Map<string, Collection>(), { equals: false });
/** Bookmark id → number of live highlights. */
const highlightCounts = signal(new Map<string, number>(), { equals: false });
const highlightOwner = new Map<string, string>();
let cursor = 0;

export const syncing = signal(false);
export const syncError = signal("");
/** False until the first snapshot or sync has landed. */
export const loaded = signal(false);

/** Live bookmarks, newest first. */
export const bookmarks = computed(() =>
  [...byId().values()]
    .filter((b) => !b.deletedAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
);

export const collections = computed(() =>
  [...collectionsById().values()]
    .filter((c) => !c.deletedAt)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
);

export const collectionName = (id: string | null) =>
  id ? (collectionsById().get(id)?.name ?? "") : "";

export const bookmark = (id: string) => byId().get(id);

export const highlightCount = (id: string) => highlightCounts().get(id) ?? 0;

const matches = (s: Source, b: Bookmark): boolean => {
  switch (s.kind) {
    case "all":
      return !b.archived;
    case "unsorted":
      return !b.archived && !b.collectionId;
    case "favorites":
      return b.favorite;
    case "highlights":
      return (highlightCounts().get(b.id) ?? 0) > 0;
    case "archive":
      return b.archived;
    case "collection":
      return !b.archived && b.collectionId === s.id;
    case "tag":
      return !b.archived && b.tags.includes(s.name);
    case "type":
      return !b.archived && b.type === s.type;
  }
};

export const bookmarksIn = (s: Source) => bookmarks().filter((b) => matches(s, b));

/** Counts for the sidebar, computed in one pass. */
export const counts = computed(() => {
  const c = {
    all: 0,
    unsorted: 0,
    favorites: 0,
    highlights: 0,
    archive: 0,
    collections: new Map<string, number>(),
    tags: new Map<string, number>(),
    types: new Map<BookmarkType, number>(),
  };
  const hl = highlightCounts();
  for (const b of bookmarks()) {
    if (b.favorite) c.favorites++;
    if ((hl.get(b.id) ?? 0) > 0) c.highlights++;
    if (b.archived) {
      c.archive++;
      continue;
    }
    c.all++;
    if (!b.collectionId) c.unsorted++;
    else c.collections.set(b.collectionId, (c.collections.get(b.collectionId) ?? 0) + 1);
    for (const t of b.tags) c.tags.set(t, (c.tags.get(t) ?? 0) + 1);
    c.types.set(b.type, (c.types.get(b.type) ?? 0) + 1);
  }
  return c;
});

/** Tags by use, most used first. */
export const tags = computed(() =>
  [...counts().tags.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count })),
);

export const countFor = (s: Source): number => {
  const c = counts();
  switch (s.kind) {
    case "collection":
      return c.collections.get(s.id) ?? 0;
    case "tag":
      return c.tags.get(s.name) ?? 0;
    case "type":
      return c.types.get(s.type) ?? 0;
    default:
      return c[s.kind];
  }
};

export const sourceTitle = (s: Source): string => {
  switch (s.kind) {
    case "all":
      return "All bookmarks";
    case "unsorted":
      return "Unsorted";
    case "favorites":
      return "Favorites";
    case "highlights":
      return "Highlights";
    case "archive":
      return "Archive";
    case "collection":
      return collectionName(s.id) || "Collection";
    case "tag":
      return `#${s.name}`;
    case "type":
      return typeTitles[s.type];
  }
};

/** The kinds of page the server tells apart, as the library names them. */
export const typeTitles: Record<BookmarkType, string> = {
  article: "Articles",
  video: "Videos",
  image: "Images",
  audio: "Audio",
  document: "Documents",
  link: "Links",
};

/**
 * Older servers stored a page's cover and favicon as the page wrote them
 * (`/favicon.ico`); resolve them against the page so they load.
 */
const absolute = (raw: string | null, page: string): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw, page);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};
const normalize = (b: Bookmark): Bookmark => ({
  ...b,
  excerpt: plainExcerpt(b.excerpt),
  coverUrl: absolute(b.coverUrl, b.url),
  faviconUrl: absolute(b.faviconUrl, b.url),
});

function apply(page: {
  bookmarks: Bookmark[];
  collections: Collection[];
  highlights: { id: string; bookmarkId: string; deletedAt?: string | null }[];
}) {
  if (page.bookmarks.length) {
    byId.update((m) => {
      for (const b of page.bookmarks) m.set(b.id, normalize(b));
      return m;
    });
  }
  if (page.collections.length) {
    collectionsById.update((m) => {
      for (const c of page.collections) m.set(c.id, c);
      return m;
    });
  }
  if (page.highlights.length) {
    highlightCounts.update((m) => {
      for (const h of page.highlights) {
        const had = highlightOwner.has(h.id);
        if (h.deletedAt) {
          if (had) {
            highlightOwner.delete(h.id);
            m.set(h.bookmarkId, Math.max(0, (m.get(h.bookmarkId) ?? 1) - 1));
          }
        } else if (!had) {
          highlightOwner.set(h.id, h.bookmarkId);
          m.set(h.bookmarkId, (m.get(h.bookmarkId) ?? 0) + 1);
        }
      }
      return m;
    });
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = JSON.stringify({
      cursor,
      bookmarks: [...byId().values()].filter((b) => !b.deletedAt),
      collections: [...collectionsById().values()].filter((c) => !c.deletedAt),
      highlights: [...highlightOwner.entries()].map(([id, bookmarkId]) => ({ id, bookmarkId })),
    });
    // Storage holds 5 MB; a library too large for it just syncs from scratch.
    Storage.setItem(SNAPSHOT_KEY, snapshot).catch(() => Storage.removeItem(SNAPSHOT_KEY));
  }, 1000);
}

/** Shows the last snapshot at once, then catches up with the server. */
export async function start() {
  try {
    const raw = await Storage.getItem(SNAPSHOT_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      apply(snap);
      cursor = snap.cursor ?? 0;
      if (byId().size) loaded.set(true);
    }
  } catch {
    await Storage.removeItem(SNAPSHOT_KEY);
  }
  await sync();
}

let inflight: Promise<void> | null = null;

/** Pulls everything that changed since the last sync. */
export function sync(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    syncing.set(true);
    try {
      for (;;) {
        const page = await api.sync(cursor);
        apply(page);
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
      syncError.set("");
      persist();
    } catch (e) {
      syncError.set((e as Error).message);
    } finally {
      loaded.set(true);
      syncing.set(false);
      inflight = null;
    }
  })();
  return inflight;
}

/** Forgets the mirror (a different server or token). */
export async function reset() {
  byId.set(new Map());
  collectionsById.set(new Map());
  highlightCounts.set(new Map());
  highlightOwner.clear();
  cursor = 0;
  loaded.set(false);
  await Storage.removeItem(SNAPSHOT_KEY);
}

/** Applies a change locally at once, then on the server; reverts if the server refuses. */
export async function updateBookmark(id: string, patch: BookmarkPatch) {
  const before = byId().get(id);
  if (!before) return;
  byId.update((m) => m.set(id, { ...before, ...patch }));
  try {
    const after = await api.update(id, patch);
    byId.update((m) => m.set(id, normalize(after)));
    persist();
  } catch (e) {
    byId.update((m) => m.set(id, before));
    throw e;
  }
}

/**
 * Saves a URL into a source (its collection, tag or favorites). The bookmark
 * shows at once; the server reads the page in the background, so a sync a
 * little later brings its title, excerpt and cover.
 */
export async function addBookmark(url: string, into: Source): Promise<Bookmark> {
  const fields =
    into.kind === "collection"
      ? { collectionId: into.id }
      : into.kind === "tag"
        ? { tags: [into.name] }
        : into.kind === "favorites"
          ? { favorite: true }
          : {};
  const b = normalize(await api.create(url, fields));
  byId.update((m) => m.set(b.id, b));
  persist();
  if (b.contentStatus === "pending") {
    setTimeout(() => void sync(), 3000);
    setTimeout(() => void sync(), 12000);
  }
  return b;
}

/** Makes a collection on the server, then brings it (and its `seq`) in with a sync. */
export async function createCollection(name: string): Promise<Collection> {
  const c = await api.createCollection(name.trim());
  collectionsById.update((m) => m.set(c.id, c));
  void sync();
  return c;
}

/** Highlights changed in the reader: keep the sidebar's count current without a sync. */
export function setHighlightCount(bookmarkId: string, ids: string[]) {
  for (const [hid, owner] of highlightOwner) {
    if (owner === bookmarkId) highlightOwner.delete(hid);
  }
  for (const hid of ids) highlightOwner.set(hid, bookmarkId);
  highlightCounts.update((m) => m.set(bookmarkId, ids.length));
}
