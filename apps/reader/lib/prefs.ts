import { computed, Storage, signal } from "nsh";
import type { Bookmark } from "./api";
import { collections, counts, type Source, tags } from "./store";

/**
 * How the library's lists are arranged: the order of collections and tags,
 * and which sections of the phone's Library page are folded away. Kept on
 * the device.
 */
export type CollectionSort = "manual" | "name" | "count";
export type TagSort = "count" | "name";
export type Section = "collections" | "filters" | "tags";
/**
 * The order of a source's bookmarks, as Raindrop's *Sort by*: date (when it
 * was saved), name (its title) or site (its domain), each either way.
 */
export type BookmarkSort =
  | "date-desc"
  | "date-asc"
  | "name-asc"
  | "name-desc"
  | "site-asc"
  | "site-desc";
/** How a wide window lays out a source's bookmarks, as Raindrop's *View*. */
export type BookmarkView = "list" | "cards" | "headlines" | "moodboard";
/** Where a tap on a bookmark opens it: the saved text, the page in the app, or the system's browser. */
export type OpenIn = "reader" | "app" | "browser";

interface Prefs {
  collectionSort: CollectionSort;
  tagSort: TagSort;
  collapsed: Section[];
  openIn: OpenIn;
  /** Each source's sort and view, by `sourceKey`; one left out is the default. */
  sorts: Record<string, BookmarkSort>;
  views: Record<string, BookmarkView>;
  /** The view of sources without their own: what *Apply to all* sets. */
  view: BookmarkView;
}

const KEY = "prefs.v1";
export const prefs = signal<Prefs>({
  collectionSort: "manual",
  tagSort: "count",
  collapsed: [],
  openIn: "reader",
  sorts: {},
  views: {},
  view: "cards",
});

void Storage.getItem(KEY)
  .then((v) => {
    if (v) prefs.set({ ...prefs(), ...(JSON.parse(v) as Partial<Prefs>) });
  })
  .catch(() => {});

export function setPrefs(patch: Partial<Prefs>) {
  const next = { ...prefs(), ...patch };
  prefs.set(next);
  void Storage.setItem(KEY, JSON.stringify(next)).catch(() => {});
}

export const isCollapsed = (s: Section) => prefs().collapsed.includes(s);
export const toggleSection = (s: Section) =>
  setPrefs({
    collapsed: isCollapsed(s)
      ? prefs().collapsed.filter((x) => x !== s)
      : [...prefs().collapsed, s],
  });

/** Collections in the order the user picked (the server's own order is "manual"). */
export const sortedCollections = computed(() => {
  const list = collections();
  const by = prefs().collectionSort;
  if (by === "manual") return list;
  const n = counts().collections;
  return [...list].sort((a, b) =>
    by === "name"
      ? a.name.localeCompare(b.name)
      : (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0) || a.name.localeCompare(b.name),
  );
});

/** Tags most used first (the store's order), or by name. */
export const sortedTags = computed(() =>
  prefs().tagSort === "count" ? tags() : [...tags()].sort((a, b) => a.name.localeCompare(b.name)),
);

/** What a source's sort and view are kept under. */
export const sourceKey = (s: Source) =>
  s.kind === "collection"
    ? `collection:${s.id}`
    : s.kind === "tag"
      ? `tag:${s.name}`
      : s.kind === "type"
        ? `type:${s.type}`
        : s.kind;

export const DEFAULT_SORT: BookmarkSort = "date-desc";
export const sortFor = (s: Source) => prefs().sorts[sourceKey(s)] ?? DEFAULT_SORT;
export const viewFor = (s: Source) => prefs().views[sourceKey(s)] ?? prefs().view;

/** Each source keeps its own sort, as Raindrop's collections do. */
export const setSortFor = (s: Source, sort: BookmarkSort) =>
  setPrefs({ sorts: { ...prefs().sorts, [sourceKey(s)]: sort } });
export const setViewFor = (s: Source, view: BookmarkView) =>
  setPrefs({ views: { ...prefs().views, [sourceKey(s)]: view } });
/** *Apply to all*: this view everywhere, the sources' own ones forgotten. */
export const applyViewToAll = (view: BookmarkView) => setPrefs({ views: {}, view });

/** A bookmark's name: its title, or its address without the scheme. */
export const displayTitle = (b: Bookmark) => b.title || b.url.replace(/^https?:\/\/(www\.)?/, "");
const site = (b: Bookmark) => b.domain.replace(/^www\./, "");
const newestFirst = (a: Bookmark, b: Bookmark) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
/** Names in the reader's order, case aside (the runtime has no `Intl.Collator`). */
const compare = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/**
 * `list` in `sort`'s order. Names and sites that tie keep the newest first,
 * as the store has them.
 */
export function sortBookmarks(list: readonly Bookmark[], sort: BookmarkSort): Bookmark[] {
  switch (sort) {
    case "date-desc":
      return [...list].sort(newestFirst);
    case "date-asc":
      return [...list].sort((a, b) => newestFirst(b, a));
    case "name-asc":
    case "name-desc": {
      const k = sort === "name-asc" ? 1 : -1;
      return [...list].sort(
        (a, b) => k * compare(displayTitle(a), displayTitle(b)) || newestFirst(a, b),
      );
    }
    case "site-asc":
    case "site-desc": {
      const k = sort === "site-asc" ? 1 : -1;
      return [...list].sort((a, b) => k * compare(site(a), site(b)) || newestFirst(a, b));
    }
  }
}
