import { batch, computed, Storage, signal } from "nsh";
import {
  api,
  type Bookmark,
  type BookmarkPatch,
  type Collection,
  type Highlight,
  loadedSettings,
  normalizeServer,
  OfflineError,
} from "./api";
import { clearArticles, prefetchArticles, removeArticle } from "./articles";
import { readText, removeText, writeText } from "./files";
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
  | { kind: "trash" }
  | { kind: "collection"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "type"; type: BookmarkType };

export type BookmarkType = Bookmark["type"];

export const sameSource = (a: Source, b: Source) =>
  a.kind === b.kind &&
  (a.kind !== "collection" || a.id === (b as { id: string }).id) &&
  (a.kind !== "tag" || a.name === (b as { name: string }).name) &&
  (a.kind !== "type" || a.type === (b as { type: BookmarkType }).type);

/**
 * The mirror kept on the device. The version goes up when bookmarks need
 * fields only a full sync brings (v2: `coverProxy`); older ones are dropped.
 */
const SNAPSHOT_KEY = "library.v2";
const OLD_SNAPSHOTS = ["library.v1"];

/**
 * The server a snapshot came from. The file outlives `Storage`'s settings
 * (another build of the app, or `nsh test --target macos`, shares the data
 * directory but not the settings), so one from elsewhere is dropped rather
 * than merged with this server's library.
 */
const snapshotServer = () => normalizeServer(loadedSettings()?.server ?? "");

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

/**
 * A bookmark in the Trash is one the server calls `archived`: deleting it from
 * the Trash deletes it for good (a tombstone on the server). Everywhere else
 * leaves it out.
 */
export const inTrash = (b: Bookmark) => b.archived;

/** Whether a bookmark belongs to a source (it's still in the Trash, say). */
export const matches = (s: Source, b: Bookmark): boolean => {
  switch (s.kind) {
    case "all":
      return !b.archived;
    case "unsorted":
      return !b.archived && !b.collectionId;
    case "favorites":
      return !b.archived && b.favorite;
    case "highlights":
      return !b.archived && (highlightCounts().get(b.id) ?? 0) > 0;
    case "trash":
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
    trash: 0,
    collections: new Map<string, number>(),
    tags: new Map<string, number>(),
    types: new Map<BookmarkType, number>(),
  };
  const hl = highlightCounts();
  for (const b of bookmarks()) {
    if (b.archived) {
      c.trash++;
      continue;
    }
    if (b.favorite) c.favorites++;
    if ((hl.get(b.id) ?? 0) > 0) c.highlights++;
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
    case "trash":
      return "Trash";
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
/**
 * Covers load through the server's image proxy where it offers one: WeChat
 * and CSDN answer a hotlinked cover with a placeholder or a 403.
 */
const cover = (b: Bookmark): string | null => {
  const server = loadedSettings()?.server;
  if (b.coverProxy && server) return `${normalizeServer(server)}${b.coverProxy}`;
  return absolute(b.coverUrl, b.url);
};
const normalize = (b: Bookmark): Bookmark => ({
  ...b,
  excerpt: plainExcerpt(b.excerpt),
  coverUrl: cover(b),
  faviconUrl: absolute(b.faviconUrl, b.url),
});

// ---------------------------------------------------------------------------
// Changes waiting for the server. Every change applies here at once; one the
// server can't be reached for waits in this outbox (kept on the device) and
// is sent, in order, before the next sync. A change the server refuses is
// dropped and the bookmark is read back from the server.

export type Op =
  | { kind: "create"; id: string; url: string; fields: CreateFields }
  | { kind: "patch"; id: string; patch: BookmarkPatch }
  | { kind: "delete"; id: string }
  | {
      kind: "addHighlight";
      bookmarkId: string;
      localId: string;
      quote: string;
      prefix: string;
      suffix: string;
    }
  | { kind: "removeHighlight"; bookmarkId: string; id: string };

type CreateFields = Partial<Pick<Bookmark, "tags" | "collectionId" | "favorite">>;

const OUTBOX_KEY = "outbox.v1";
export const outbox = signal<Op[]>([]);
/** A highlight made offline: its local id, then the server's once it's sent. */
const sentHighlights = new Map<string, string>();

function saveOutbox() {
  void Storage.setItem(OUTBOX_KEY, JSON.stringify(outbox())).catch(() => {});
}

function enqueue(op: Op) {
  const ops = [...outbox()];
  const last = ops[ops.length - 1];
  // The first op is on its way while flushing: it's dropped once sent, so
  // nothing may be merged into it.
  const sending = flushing !== null && ops.length === 1;
  if (op.kind === "patch" && last?.kind === "patch" && last.id === op.id && !sending) {
    // Consecutive edits of one bookmark (reading progress, say) are one.
    ops[ops.length - 1] = { ...last, patch: { ...last.patch, ...op.patch } };
  } else if (op.kind === "removeHighlight" && op.id.startsWith("local-")) {
    // Never sent: forget it instead.
    const i = ops.findIndex((o) => o.kind === "addHighlight" && o.localId === op.id);
    if (i >= 0) ops.splice(i, 1);
    else ops.push(op);
  } else {
    ops.push(op);
  }
  outbox.set(ops);
  saveOutbox();
}

/** The bookmark as the waiting changes leave it (or undefined: deleted). */
function overlay(b: Bookmark): Bookmark | undefined {
  let out: Bookmark | undefined = b;
  for (const op of outbox()) {
    if (!out) break;
    if (op.kind === "patch" && op.id === b.id) out = { ...out, ...op.patch };
    else if (op.kind === "delete" && op.id === b.id) out = undefined;
  }
  return out;
}

async function send(op: Op): Promise<void> {
  switch (op.kind) {
    case "create": {
      const b = normalize(await api.create(op.url, { ...op.fields, id: op.id }));
      if (b.id !== op.id) {
        // Already saved: the server's bookmark takes the place of the one
        // made here, and the changes waiting for it go to the server's.
        byId.update((m) => {
          m.delete(op.id);
          return m;
        });
        outbox.set(
          outbox().map((o) =>
            "bookmarkId" in o && o.bookmarkId === op.id
              ? { ...o, bookmarkId: b.id }
              : o.kind !== "create" && "id" in o && o.id === op.id
                ? { ...o, id: b.id }
                : o,
          ),
        );
      }
      byId.update((m) => m.set(b.id, overlay(b) ?? b));
      return;
    }
    case "patch":
      await api.update(op.id, op.patch);
      return;
    case "delete":
      await api.remove(op.id);
      return;
    case "addHighlight": {
      const h = await api.addHighlight(op.bookmarkId, op);
      sentHighlights.set(op.localId, h.id);
      return;
    }
    case "removeHighlight":
      await api.removeHighlight(sentHighlights.get(op.id) ?? op.id);
      return;
  }
}

let flushing: Promise<void> | null = null;

/** Sends the waiting changes, in order, until one can't reach the server. */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  if (!outbox().length) return Promise.resolve();
  const run = async () => {
    while (outbox().length) {
      const op = outbox()[0]!;
      try {
        await send(op);
      } catch (e) {
        if (e instanceof OfflineError) return;
        // Refused (the bookmark is gone, say): drop it, and read back
        // what the server has.
        console.warn(`lofu: the server refused a change (${op.kind}): ${(e as Error).message}`);
        if ("id" in op && op.kind !== "removeHighlight") refusedIds.add(op.id);
      }
      outbox.set(outbox().slice(1));
      saveOutbox();
    }
  };
  // Cleared once it settles (not inside: a run that finishes at once would
  // clear it before it's set).
  const p = run().finally(() => {
    if (flushing === p) flushing = null;
  });
  flushing = p;
  return p;
}
const refusedIds = new Set<string>();

// ---------------------------------------------------------------------------

function apply(page: {
  bookmarks: Bookmark[];
  collections: Collection[];
  highlights: { id: string; bookmarkId: string; deletedAt?: string | null }[];
}) {
  // One pass of the views for the page, not one per map.
  batch(() => {
    if (page.bookmarks.length) {
      byId.update((m) => {
        for (const b of page.bookmarks) {
          // The server's state, under the changes still waiting to be sent.
          const local = overlay(normalize(b));
          if (local) m.set(b.id, local);
          else m.delete(b.id);
        }
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
  });
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = JSON.stringify({
      server: snapshotServer(),
      cursor,
      bookmarks: [...byId().values()].filter((b) => !b.deletedAt),
      collections: [...collectionsById().values()].filter((c) => !c.deletedAt),
      highlights: [...highlightOwner.entries()].map(([id, bookmarkId]) => ({ id, bookmarkId })),
    });
    // A file on the device; on the web, Storage (5 MB): a library too
    // large for it just syncs from scratch.
    void writeText(SNAPSHOT_KEY, snapshot).then((ok) => {
      if (!ok) void removeText(SNAPSHOT_KEY);
    });
  }, 1000);
}

/** Shows the last snapshot at once, then catches up with the server. */
export async function start() {
  try {
    const ops = await Storage.getItem(OUTBOX_KEY);
    if (ops) outbox.set(JSON.parse(ops) as Op[]);
  } catch {
    outbox.set([]);
  }
  for (const key of OLD_SNAPSHOTS) {
    await Storage.removeItem(key).catch(() => {});
    await removeText(key);
  }
  try {
    const raw = await readText(SNAPSHOT_KEY);
    const snap = raw ? JSON.parse(raw) : null;
    if (snap && snap.server !== snapshotServer()) {
      await removeText(SNAPSHOT_KEY);
      await clearArticles();
    } else if (snap) {
      apply(snap);
      cursor = snap.cursor ?? 0;
      if (byId().size) loaded.set(true);
    }
  } catch {
    await removeText(SNAPSHOT_KEY);
  }
  await sync();
}

let inflight: Promise<void> | null = null;

/** Sends what's waiting, then pulls everything that changed since the last sync. */
export function sync(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    syncing.set(true);
    try {
      await flush();
      for (;;) {
        const page = await api.sync(cursor);
        apply(page);
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
      // Changes the server refused: read back what it has.
      for (const id of [...refusedIds]) {
        refusedIds.delete(id);
        try {
          const b = await api.bookmark(id);
          byId.update((m) => {
            if (b.deletedAt) m.delete(id);
            else m.set(id, normalize(b));
            return m;
          });
        } catch {
          byId.update((m) => {
            m.delete(id);
            return m;
          });
        }
      }
      syncError.set("");
      persist();
      // Newest first, as the library lists them.
      void prefetchArticles(bookmarks());
    } catch (e) {
      syncError.set((e as Error).message);
      if (e instanceof OfflineError) offline.set(true);
    } finally {
      batch(() => {
        if (!syncError()) offline.set(false);
        loaded.set(true);
        syncing.set(false);
      });
      inflight = null;
    }
  })();
  return inflight;
}

/** The last sync couldn't reach the server. */
export const offline = signal(false);

/** Forgets the mirror (a different server or token). */
export async function reset() {
  highlightOwner.clear();
  cursor = 0;
  batch(() => {
    byId.set(new Map());
    collectionsById.set(new Map());
    highlightCounts.set(new Map());
    loaded.set(false);
    outbox.set([]);
  });
  await Storage.removeItem(OUTBOX_KEY);
  await removeText(SNAPSHOT_KEY);
  await clearArticles();
}

/**
 * Applies a change locally at once, then on the server. Offline it waits in
 * the outbox; a change the server refuses is undone (and rethrown).
 */
export async function updateBookmark(id: string, patch: BookmarkPatch) {
  const before = byId().get(id);
  if (!before) return;
  byId.update((m) => m.set(id, { ...before, ...patch }));
  persist();
  if (outbox().length) {
    // Behind changes still waiting: in order after them.
    enqueue({ kind: "patch", id, patch });
    void flush();
    return;
  }
  try {
    const after = await api.update(id, patch);
    // Unless it changed again meanwhile.
    if (!outbox().some((o) => "id" in o && o.id === id)) {
      byId.update((m) => m.set(id, { ...normalize(after), ...patch }));
    }
    persist();
  } catch (e) {
    if (e instanceof OfflineError) {
      enqueue({ kind: "patch", id, patch });
      offline.set(true);
      return;
    }
    byId.update((m) => m.set(id, before));
    persist();
    throw e;
  }
}

/** How far into the article the reader got (0–1): kept quietly, never undone. */
export function setReadProgress(id: string, readProgress: number) {
  const b = byId().get(id);
  if (!b || Math.abs(b.readProgress - readProgress) < 0.005) return;
  void updateBookmark(id, { readProgress }).catch(() => {});
}

/** Moves a bookmark to a collection (`null`: Unsorted); out of the Trash too. */
export const moveBookmark = (id: string, collectionId: string | null) =>
  updateBookmark(id, { collectionId, archived: false });

/** Puts a bookmark in the Trash. */
export const trashBookmark = (id: string) => updateBookmark(id, { archived: true });

/** Takes a bookmark out of the Trash, back where it was. */
export const restoreBookmark = (id: string) => updateBookmark(id, { archived: false });

/**
 * Deletes a bookmark for good: it goes at once, and comes back if the server
 * refuses. The server keeps a tombstone, so other devices drop it on sync.
 */
export async function deleteForever(id: string) {
  const before = byId().get(id);
  if (!before) return;
  byId.update((m) => {
    m.delete(id);
    return m;
  });
  persist();
  void removeArticle(id);
  if (outbox().length) {
    enqueue({ kind: "delete", id });
    void flush();
    return;
  }
  try {
    await api.remove(id);
  } catch (e) {
    if (e instanceof OfflineError) {
      enqueue({ kind: "delete", id });
      offline.set(true);
      return;
    }
    byId.update((m) => m.set(id, before));
    persist();
    throw e;
  }
}

/**
 * An id made on the device for a bookmark saved offline, which the server
 * keeps: UUIDv7's layout (time first, so ids sort by when they were made).
 * Math.random is enough here; the ids only need to be unique per library.
 */
const newId = () => {
  const hex = (n: number, digits: number) => Math.floor(n).toString(16).padStart(digits, "0");
  const rand = (digits: number) =>
    Array.from({ length: digits }, () => hex(Math.random() * 16, 1)).join("");
  const t = hex(Date.now(), 12);
  const variant = hex(8 + Math.random() * 4, 1);
  return `${t.slice(0, 8)}-${t.slice(8)}-7${rand(3)}-${variant}${rand(3)}-${rand(12)}`;
};

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/**
 * Saves a URL into a source (its collection, tag or favorites). The bookmark
 * shows at once; the server reads the page in the background, so a sync a
 * little later brings its title, excerpt and cover. Offline it waits in the
 * outbox under an id made here, which the server keeps.
 */
export async function addBookmark(url: string, into: Source): Promise<Bookmark> {
  const fields: CreateFields =
    into.kind === "collection"
      ? { collectionId: into.id }
      : into.kind === "tag"
        ? { tags: [into.name] }
        : into.kind === "favorites"
          ? { favorite: true }
          : {};
  let b: Bookmark;
  try {
    b = normalize(await api.create(url, fields));
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    const now = new Date().toISOString();
    b = {
      id: newId(),
      url,
      title: "",
      excerpt: null,
      note: null,
      coverUrl: null,
      faviconUrl: null,
      domain: domainOf(url),
      type: "link",
      tags: fields.tags ?? [],
      collectionId: fields.collectionId ?? null,
      favorite: fields.favorite ?? false,
      archived: false,
      readProgress: 0,
      wordCount: null,
      contentStatus: "pending",
      contentError: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      seq: 0,
    };
    enqueue({ kind: "create", id: b.id, url, fields });
    offline.set(true);
  }
  byId.update((m) => m.set(b.id, b));
  persist();
  if (b.contentStatus === "pending" && !offline()) {
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

export async function renameCollection(id: string, name: string) {
  const c = await api.updateCollection(id, { name: name.trim() });
  collectionsById.update((m) => m.set(c.id, c));
  void sync();
}

/** Deletes a collection; its bookmarks go to Unsorted (as the server does). */
export async function deleteCollection(id: string) {
  await api.removeCollection(id);
  batch(() => {
    collectionsById.update((m) => {
      m.delete(id);
      return m;
    });
    byId.update((m) => {
      for (const b of m.values())
        if (b.collectionId === id) m.set(b.id, { ...b, collectionId: null });
      return m;
    });
  });
  persist();
  void sync();
}

/** Moves a collection up or down the list by one place. */
export async function moveCollection(id: string, by: -1 | 1) {
  const i = collections().findIndex((c) => c.id === id);
  if (i >= 0) await moveCollectionTo(id, i + by);
}

/**
 * Moves a collection to `index` in the list (the server's own order, `sort`),
 * as dragging it in the sidebar does: every collection whose place changes is
 * numbered again.
 */
export async function moveCollectionTo(id: string, index: number) {
  const list = collections();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0 || index < 0 || index >= list.length || index === i) return;
  const order = [...list];
  order.splice(index, 0, ...order.splice(i, 1));
  const changed = order.map((c, k) => ({ c, sort: k })).filter(({ c, sort }) => c.sort !== sort);
  collectionsById.update((m) => {
    for (const { c, sort } of changed) m.set(c.id, { ...c, sort });
    return m;
  });
  try {
    for (const { c, sort } of changed) await api.updateCollection(c.id, { sort });
  } finally {
    void sync();
  }
}

/** Renames a tag everywhere (merging into one that exists). */
export async function renameTag(from: string, to: string) {
  const name = to.trim().toLowerCase();
  if (!name || name === from) return;
  await api.renameTag(from, name);
  byId.update((m) => {
    for (const b of m.values()) {
      if (!b.tags.includes(from)) continue;
      const tags = b.tags.map((t) => (t === from ? name : t));
      m.set(b.id, { ...b, tags: [...new Set(tags)] });
    }
    return m;
  });
  persist();
  void sync();
}

/** Takes a tag off every bookmark. */
export async function deleteTag(name: string) {
  await api.removeTag(name);
  byId.update((m) => {
    for (const b of m.values()) {
      if (b.tags.includes(name)) m.set(b.id, { ...b, tags: b.tags.filter((t) => t !== name) });
    }
    return m;
  });
  persist();
  void sync();
}

/**
 * Highlights changed in the reader: keep the sidebar's count current without
 * a sync. `ids` are all of the bookmark's highlights, those the reader
 * couldn't place in the text too.
 */
export function setHighlightCount(bookmarkId: string, ids: string[]) {
  for (const [hid, owner] of highlightOwner) {
    if (owner === bookmarkId) highlightOwner.delete(hid);
  }
  for (const hid of ids) highlightOwner.set(hid, bookmarkId);
  highlightCounts.update((m) => m.set(bookmarkId, ids.length));
  persist();
}

/** Saves a highlight; offline it waits with a local id. */
export async function addHighlight(
  bookmarkId: string,
  q: { quote: string; prefix: string; suffix: string },
): Promise<Highlight> {
  if (!outbox().length) {
    try {
      return await api.addHighlight(bookmarkId, q);
    } catch (e) {
      if (!(e instanceof OfflineError)) throw e;
    }
  }
  const localId = `local-${newId()}`;
  enqueue({ kind: "addHighlight", bookmarkId, localId, ...q });
  void flush();
  return { id: localId, bookmarkId, ...q, note: null, color: null };
}

export async function removeHighlight(h: Highlight) {
  if (!outbox().length && !h.id.startsWith("local-")) {
    try {
      await api.removeHighlight(h.id);
      return;
    } catch (e) {
      if (!(e instanceof OfflineError)) throw e;
    }
  }
  enqueue({ kind: "removeHighlight", bookmarkId: h.bookmarkId, id: h.id });
  void flush();
}

/** Highlights still waiting to be sent or removed, as the reader should show them. */
export function pendingHighlights(bookmarkId: string, server: Highlight[]): Highlight[] {
  const removed = new Set<string>();
  const added: Highlight[] = [];
  for (const op of outbox()) {
    if (op.kind === "removeHighlight" && op.bookmarkId === bookmarkId) removed.add(op.id);
    if (op.kind === "addHighlight" && op.bookmarkId === bookmarkId) {
      const { localId, quote, prefix, suffix } = op;
      added.push({ id: localId, bookmarkId, quote, prefix, suffix, note: null, color: null });
    }
  }
  // The device's copy of the article may hold the waiting ones already.
  const have = new Set(server.map((h) => h.id));
  return [...server, ...added.filter((h) => !have.has(h.id))].filter(
    (h) => !removed.has(h.id) && !removed.has(sentHighlights.get(h.id) ?? ""),
  );
}
