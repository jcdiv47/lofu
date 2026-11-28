import { expect, test } from "nsh/test";
import type { Bookmark } from "./lib/api";
import { placesFor } from "./lib/manual";
import { manualKey, sortBookmarks } from "./lib/prefs";

const b = (id: string, sort: number): Bookmark => ({
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
  collectionId: "c1",
  favorite: false,
  trashed: false,
  readProgress: 0,
  wordCount: 1000,
  contentStatus: "ok",
  contentError: null,
  sort,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  deletedAt: null,
  seq: 1,
});

/** The order after a drop: `list` with `moved` at `index` of the rest, the places applied. */
function drop(list: Bookmark[], moved: string, index: number) {
  const it = list.find((x) => x.id === moved) as Bookmark;
  const rest = list.filter((x) => x.id !== moved);
  const changes = placesFor(it, rest, index);
  const after = list.map((x) => {
    const c = changes.find((p) => p.id === x.id);
    return c ? { ...x, sort: c.sort } : x;
  });
  return { changes, order: sortBookmarks(after, "manual").map((x) => x.id) };
}

test("a drop between two with room changes only the one dropped: their midpoint", () => {
  const list = [b("a", 0), b("b", 10), b("c", 20)];
  const { changes, order } = drop(list, "a", 1);
  expect(changes).toEqual([{ id: "a", sort: 15 }]);
  expect(order).toEqual(["b", "a", "c"]);
});

test("a drop at either end goes a step past it", () => {
  const list = [b("a", 0), b("b", 10), b("c", 20)];
  expect(drop(list, "c", 0)).toEqual({
    changes: [{ id: "c", sort: -1024 }],
    order: ["c", "a", "b"],
  });
  expect(drop(list, "a", 2)).toEqual({
    changes: [{ id: "a", sort: 1044 }],
    order: ["b", "c", "a"],
  });
});

test("a drop among ties spaces out only the tied stretch, and lands where it was dropped", () => {
  // Five imported in the same millisecond, between two placed apart.
  const list = [
    b("top", 0),
    ...["t1", "t2", "t3", "t4", "t5"].map((id) => b(id, 100)),
    b("end", 200),
  ];
  const { changes, order } = drop(list, "end", 3);
  expect(order).toEqual(["top", "t1", "t2", "end", "t3", "t4", "t5"]);
  // Not "top": the stretch stops at the first place with room.
  expect(changes.some((c) => c.id === "top")).toBe(false);
  const sorts = order.map((id) => {
    const c = changes.find((x) => x.id === id);
    return c ? c.sort : manualKey(list.find((x) => x.id === id) as Bookmark);
  });
  // Never backwards; the dropped one strictly between its neighbours (untouched ties may stay tied).
  for (let k = 1; k < sorts.length; k++) expect(sorts[k]).toBeGreaterThanOrEqual(sorts[k - 1]);
  const i = order.indexOf("end");
  expect(sorts[i]).toBeGreaterThan(sorts[i - 1]);
  expect(sorts[i + 1]).toBeGreaterThan(sorts[i]);
});

test("ties at the start are spaced out down from the first with room", () => {
  const list = [b("t1", 5), b("t2", 5), b("t3", 5), b("z", 50)];
  const { order } = drop(list, "z", 1);
  expect(order).toEqual(["t1", "z", "t2", "t3"]);
});
