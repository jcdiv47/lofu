import { computed, Storage, signal } from "nsh";
import { collections, counts, tags } from "./store";

/**
 * How the library's lists are arranged: the order of collections and tags,
 * and which sections of the phone's Library page are folded away. Kept on
 * the device.
 */
export type CollectionSort = "manual" | "name" | "count";
export type TagSort = "count" | "name";
export type Section = "collections" | "filters" | "tags";

interface Prefs {
  collectionSort: CollectionSort;
  tagSort: TagSort;
  collapsed: Section[];
}

const KEY = "prefs.v1";
export const prefs = signal<Prefs>({ collectionSort: "manual", tagSort: "count", collapsed: [] });

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
