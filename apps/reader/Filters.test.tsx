import { expect, test } from "nsh/test";
import type { Bookmark } from "./lib/api";
import {
  applyFilter,
  filterCounts,
  filterParts,
  type ListFilter,
  NO_FILTER,
  searchTerms,
  toggled,
  togglesFor,
  without,
} from "./lib/filters";

const b = (id: string, over: Partial<Bookmark> = {}): Bookmark => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  excerpt: null,
  note: null,
  coverUrl: null,
  faviconUrl: null,
  domain: "example.com",
  type: "article",
  tags: [],
  collectionId: null,
  favorite: false,
  archived: false,
  readProgress: 0,
  wordCount: 1000,
  contentStatus: "ok",
  contentError: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  deletedAt: null,
  seq: 1,
  ...over,
});

const ids = (list: Bookmark[]) => list.map((x) => x.id);

const list = [
  b("unread"),
  b("half", { readProgress: 0.5 }),
  b("read", { readProgress: 1, favorite: true }),
  b("noted", { note: "  why  ", tags: ["x"] }),
  b("blank-note", { note: "   " }),
  b("video", { type: "video", favorite: true, tags: ["y"] }),
];

test("no filter leaves the list as it is", () => {
  expect(applyFilter(NO_FILTER, list)).toBe(list);
});

test("toggles narrow together; a half-read page is unread", () => {
  const unread = toggled(NO_FILTER, "unread");
  expect(ids(applyFilter(unread, list))).toEqual([
    "unread",
    "half",
    "noted",
    "blank-note",
    "video",
  ]);
  expect(ids(applyFilter(toggled(unread, "favorite"), list))).toEqual(["video"]);
  // Toggling again drops it.
  expect(toggled(unread, "unread")).toEqual(NO_FILTER);
});

test("a note of spaces is no note; a type narrows to one kind of page", () => {
  expect(ids(applyFilter(toggled(NO_FILTER, "note"), list))).toEqual(["noted"]);
  expect(ids(applyFilter({ toggles: [], type: "video" }, list))).toEqual(["video"]);
  expect(ids(applyFilter({ toggles: ["notag"], type: "article" }, list))).toEqual([
    "unread",
    "half",
    "read",
    "blank-note",
  ]);
});

test("the search gets the conditions it knows, not Unread", () => {
  expect(searchTerms({ toggles: ["unread", "favorite", "notag"], type: "video" })).toBe(
    "type:video favorite:true notag:true",
  );
  expect(searchTerms(NO_FILTER)).toBe("");
});

test("counts are of what the rest of the filter leaves", () => {
  const n = filterCounts({ toggles: ["favorite"], type: null }, list);
  expect(n.toggles.get("favorite")).toBe(2);
  expect(n.toggles.get("unread")).toBe(1);
  expect(n.types.get("video")).toBe(1);
  expect(n.types.get("article")).toBe(1);
  // The type's own counts ignore the type picked.
  const typed = filterCounts({ toggles: [], type: "video" }, list);
  expect(typed.types.get("article")).toBe(5);
});

test("chips name the parts in order, and each drops its own", () => {
  const filter: ListFilter = { toggles: ["notag", "unread"], type: "video" };
  expect(filterParts(filter).map((p) => p.label)).toEqual(["Videos", "Unread", "Without tags"]);
  expect(without(filter, "type")).toEqual({ toggles: ["notag", "unread"], type: null });
  expect(without(filter, "unread")).toEqual({ toggles: ["notag"], type: "video" });
});

test("a source doesn't offer what all its bookmarks are", () => {
  const values = (s: Parameters<typeof togglesFor>[0]) => togglesFor(s).map((c) => c.value);
  expect(values({ kind: "favorites" })).not.toContain("favorite");
  expect(values({ kind: "highlights" })).not.toContain("highlights");
  expect(values({ kind: "all" })).toContain("favorite");
});
