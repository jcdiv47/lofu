import type { Bookmark } from "./api";
import { type BookmarkType, highlightCount, type Source, typeTitles } from "./store";

/*
 * The phone library's *Filter*: what narrows a list of bookmarks, as the
 * Library page's filters do but within the list open (Unread in All
 * bookmarks, Articles in a collection). Kept by the page while it's open,
 * not on the device: a list that came back narrowed after a relaunch would
 * look as if bookmarks were missing. A search keeps the filter, and the
 * conditions the server's search knows (`packages/shared/src/query.ts`) go
 * to it, so its pages of hits are already narrowed.
 */

export type Toggle = "unread" | "favorite" | "highlights" | "note" | "notag";

export interface ListFilter {
  /** Each one narrows further (and). */
  toggles: Toggle[];
  /** One kind of page, or any. */
  type: BookmarkType | null;
}

export const NO_FILTER: ListFilter = { toggles: [], type: null };

export const toggleChoices: { value: Toggle; label: string; symbol: string }[] = [
  { value: "unread", label: "Unread", symbol: "circle" },
  { value: "favorite", label: "Favorites", symbol: "star" },
  { value: "highlights", label: "With highlights", symbol: "highlighter" },
  { value: "note", label: "With a note", symbol: "note.text" },
  { value: "notag", label: "Without tags", symbol: "number" },
];

/** The kinds of page, in the Library page's order. */
export const typeChoices: { value: BookmarkType; symbol: string }[] = [
  { value: "article", symbol: "doc.plaintext" },
  { value: "video", symbol: "play.rectangle" },
  { value: "image", symbol: "photo" },
  { value: "audio", symbol: "waveform" },
  { value: "document", symbol: "doc.richtext" },
  { value: "link", symbol: "link" },
];

/** Read: what the cards mark *Read* (`components/BookmarkCard.tsx`). */
export const isUnread = (b: Bookmark) => b.readProgress < 0.98;

const passes: Record<Toggle, (b: Bookmark) => boolean> = {
  unread: isUnread,
  favorite: (b) => b.favorite,
  highlights: (b) => highlightCount(b.id) > 0,
  note: (b) => !!b.note?.trim(),
  notag: (b) => b.tags.length === 0,
};

/** The toggles a source offers: none that every bookmark of it meets already. */
export const togglesFor = (s: Source) =>
  toggleChoices.filter(
    (c) =>
      !(c.value === "favorite" && s.kind === "favorites") &&
      !(c.value === "highlights" && s.kind === "highlights"),
  );
/** A source of one kind of page has no *Type* to pick. */
export const offersType = (s: Source) => s.kind !== "type";

export const isFiltered = (f: ListFilter) => f.toggles.length > 0 || f.type !== null;

export const meets = (f: ListFilter, b: Bookmark) =>
  (f.type === null || b.type === f.type) && f.toggles.every((t) => passes[t](b));

export const applyFilter = (f: ListFilter, list: Bookmark[]) =>
  isFiltered(f) ? list.filter((b) => meets(f, b)) : list;

/** The conditions the server's search understands (all but *Unread*), to add to a query. */
export const searchTerms = (f: ListFilter) =>
  [
    ...(f.type ? [`type:${f.type}`] : []),
    ...f.toggles.flatMap((t) => (t === "unread" ? [] : [`${t}:true`])),
  ].join(" ");

export const toggled = (f: ListFilter, t: Toggle): ListFilter => ({
  ...f,
  toggles: f.toggles.includes(t) ? f.toggles.filter((x) => x !== t) : [...f.toggles, t],
});

/** What each part of a filter is called, in order: its chips. */
export const filterParts = (f: ListFilter) => [
  ...(f.type ? [{ key: "type", label: typeTitles[f.type] }] : []),
  ...toggleChoices
    .filter((c) => f.toggles.includes(c.value))
    .map((c) => ({ key: c.value as string, label: c.label })),
];

/** A filter without one of its parts (a chip's ✕). */
export const without = (f: ListFilter, key: string): ListFilter =>
  key === "type" ? { ...f, type: null } : { ...f, toggles: f.toggles.filter((t) => t !== key) };

/** How many of `list` each choice would leave, within what the rest of the filter leaves. */
export function filterCounts(f: ListFilter, list: Bookmark[]) {
  const toggles = new Map<Toggle, number>();
  const types = new Map<BookmarkType, number>();
  for (const c of toggleChoices) {
    const withIt = { ...f, toggles: [...f.toggles.filter((t) => t !== c.value), c.value] };
    toggles.set(c.value, list.filter((b) => meets(withIt, b)).length);
  }
  const rest = { ...f, type: null };
  for (const b of list) if (meets(rest, b)) types.set(b.type, (types.get(b.type) ?? 0) + 1);
  return { toggles, types };
}
