import { expect, test } from "nsh/test";
import type { Bookmark } from "./lib/api";
import { AHEAD, pictureFile, pictureUrls, toKeep } from "./lib/articles";

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
  trashed: false,
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

const library = [
  b("unread"),
  b("half", { readProgress: 0.5 }),
  b("read", { readProgress: 1 }),
  b("trash", { trashed: true }),
  b("gone", { deletedAt: "2026-11-06T10:00:00.000Z" }),
  b("unreadable", { contentStatus: "failed" }),
  b("fetching", { contentStatus: "pending" }),
  b("video", { contentStatus: "skipped", type: "video" }),
];

test("what is downloaded ahead: readable articles outside the Trash, unread ones unless all", () => {
  expect(ids(toKeep(library, "opened"))).toEqual([]);
  expect(ids(toKeep(library, "recent"))).toEqual(["unread", "half"]);
  expect(ids(toKeep(library, "unread"))).toEqual(["unread", "half"]);
  expect(ids(toKeep(library, "all"))).toEqual(["unread", "half", "read"]);
});

test("the newest unread stop at the limit, in the library's order", () => {
  const many = Array.from({ length: AHEAD + 5 }, (_, i) => b(`n${i}`));
  expect(toKeep(many, "recent").length).toBe(AHEAD);
  expect(toKeep(many, "recent")[0]?.id).toBe("n0");
  expect(toKeep(many, "unread").length).toBe(AHEAD + 5);
});

test("pictures are the URLs the reader loads: through the proxy, once each", () => {
  const images = [
    { src: "https://x.test/a.jpg", width: 10, height: 10, proxy: "https://lofu.test/img/s?u=a" },
    { src: "https://x.test/b.jpg", width: null, height: null, proxy: null },
    { src: "https://x.test/b.jpg", width: null, height: null, proxy: null },
    { src: "data:image/png;base64,AA==", width: 1, height: 1, proxy: null },
  ];
  expect(pictureUrls({ images })).toEqual(["https://lofu.test/img/s?u=a", "https://x.test/b.jpg"]);
  expect(pictureUrls({ images: [] })).toEqual([]);
});

test("a picture's file is named by its article and URL, in the characters files may have", () => {
  const a = pictureFile("01JD2Q_x-y", "https://lofu.test/img/s?u=https%3A%2F%2Fx.test%2Fa.jpg");
  expect(/^picture-01JD2Q_x-y-[0-9a-z]+$/.test(a)).toBe(true);
  expect(pictureFile("01JD2Q_x-y", "https://lofu.test/img/s?u=https%3A%2F%2Fx.test%2Fa.jpg")).toBe(
    a,
  );
  expect(
    pictureFile("01JD2Q_x-y", "https://lofu.test/img/s?u=https%3A%2F%2Fx.test%2Fb.jpg"),
  ).not.toBe(a);
});
