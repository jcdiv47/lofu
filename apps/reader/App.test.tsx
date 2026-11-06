import { expect, open, test } from "nsh/test";

const S = "https://lofu.test";
const saved = { storage: { server: S, token: "lofu_test" } };

const bookmark = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  url: `https://example.com/${id}`,
  title: `Article ${id}`,
  excerpt: `About ${id}.`,
  note: null,
  coverUrl: null,
  faviconUrl: "/favicon.ico",
  domain: "example.com",
  type: "article",
  tags: [],
  collectionId: null,
  favorite: false,
  archived: false,
  readProgress: 0,
  wordCount: 1200,
  contentStatus: "ok",
  contentError: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  deletedAt: null,
  seq: 1,
  ...over,
});

const library = {
  cursor: 9,
  hasMore: false,
  collections: [
    { id: "c1", name: "Homelab", parentId: null, sort: 1, color: null, deletedAt: null, seq: 1 },
  ],
  bookmarks: [
    bookmark("a", { collectionId: "c1", tags: ["rust"], createdAt: "2026-11-04T10:00:00.000Z" }),
    bookmark("bb", { favorite: true, createdAt: "2026-11-03T10:00:00.000Z" }),
    bookmark("ccc", {
      archived: true,
      excerpt: "Mail ( [\\[email protected\\]](https://x.test) ) us",
      createdAt: "2026-11-02T10:00:00.000Z",
    }),
    bookmark("dddd", { contentStatus: "failed", title: "", createdAt: "2026-11-01T10:00:00.000Z" }),
  ],
  highlights: [
    { id: "h1", bookmarkId: "a", quote: "x", prefix: "", suffix: "", note: null, color: null },
  ],
};

test("first launch asks for the server", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("text:Server address");
  expect(app.texts()).toContain("API token");
  expect(app.shows("id:connect")).toBe(true);
});

test("connecting checks the server before saving", async () => {
  const app = await open("./App.tsx", {
    network: { [`GET ${S}/v1/sync*`]: { status: 401, body: { error: "unauthorized" } } },
  });
  await app.waitFor("id:server");
  await app.type("id:server", "lofu.test");
  await app.press("id:connect");
  await app.waitFor("id:settings-error");
  expect(app.texts().join(" ")).toContain("starts with https://");

  await app.clear("id:server");
  await app.type("id:server", `${S}/`);
  await app.type("id:token", "lofu_wrong");
  await app.press("id:connect");
  await app.waitFor("text:The server didn't accept this token.");
  expect(app.storage().token).toBeUndefined();
});

test("phone: opens on all bookmarks, newest first, from a sync", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Article a");
  const texts = app.texts();
  // Archived bookmarks stay out of "All bookmarks"; a page with no title shows its URL.
  expect(texts).not.toContain("Article ccc");
  expect(texts.indexOf("Article a")).toBeLessThan(texts.indexOf("Article bb"));
  expect(texts).toContain("example.com/dddd");
  expect(texts).toContain("Unreadable");
  expect(texts.join(" ")).toContain("example.com  ·  Homelab");
});

test("desktop: the sidebar counts and filters", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Article a");
  await app.press("label:Archive");
  await app.waitFor("text:Article ccc");
  expect(app.shows("text:Article a")).toBe(false);
  // Old excerpts lose their Markdown.
  expect(app.texts().join(" ")).toContain("Mail ( [email protected] ) us");

  await app.press("label:Highlights");
  await app.waitFor("text:Article a");
  expect(app.shows("text:Article bb")).toBe(false);

  await app.press("label:rust");
  await app.waitFor("text:#rust");
  expect(app.shows("text:Article a")).toBe(true);
});

test("favoriting from the reader updates at once and on the server", async () => {
  const patches: unknown[] = [];
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: {
      [`GET ${S}/v1/sync*`]: { body: library },
      [`GET ${S}/v1/bookmarks/a?content=markdown`]: {
        body: { ...library.bookmarks[0], content: "Some text to read here." },
      },
      [`GET ${S}/v1/bookmarks/a/highlights`]: { body: [] },
      [`PATCH ${S}/v1/bookmarks/a`]: (r) => {
        const patch = JSON.parse(r.body ?? "{}");
        patches.push(patch);
        return { body: { ...library.bookmarks[0], ...patch } };
      },
    },
  });
  await app.press("text:Article a");
  await app.waitFor("label:Add to favorites");
  await app.press("label:Add to favorites");
  await app.waitFor("label:Remove from favorites");
  expect(patches).toEqual([{ favorite: true }]);
  await app.back();
  await app.press("label:Favorites");
  await app.waitFor("text:Article a");
});

const readable = {
  [`GET ${S}/v1/sync*`]: { body: library },
  [`GET ${S}/v1/bookmarks/a?content=markdown`]: {
    body: { ...library.bookmarks[0], content: "Some text to read here." },
  },
  [`GET ${S}/v1/bookmarks/a/highlights`]: { body: [] },
};

test("desktop: the original opens in the app, and leaves for the browser on request", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: readable,
  });
  await app.press("text:Article a");
  await app.waitFor("label:Open original");
  await app.press("label:Open original");
  await app.waitFor("id:web");
  expect(app.openedUrls()).toEqual([]);
  expect(app.texts()).toContain("example.com");

  await app.press("label:Open in browser");
  expect(app.openedUrls()).toEqual(["https://example.com/a"]);

  await app.press("label:Close page");
  await app.waitFor("id:article");
});

test("web: the original opens in the browser", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "web",
    width: 1200,
    height: 800,
    network: readable,
  });
  await app.press("text:Article a");
  await app.waitFor("label:Open original");
  await app.press("label:Open original");
  expect(app.openedUrls()).toEqual(["https://example.com/a"]);
  expect(app.shows("id:web")).toBe(false);
});

const saveStub = (posts: unknown[]) => ({
  [`GET ${S}/v1/sync*`]: { body: library },
  [`POST ${S}/v1/bookmarks`]: (r: { body?: string | null }) => {
    const input = JSON.parse(r.body ?? "{}");
    posts.push(input);
    return {
      status: 201,
      body: bookmark("new", {
        url: input.url,
        title: "",
        domain: "new.example",
        contentStatus: "pending",
        collectionId: input.collectionId ?? null,
        createdAt: "2026-11-06T10:00:00.000Z",
      }),
    };
  },
});

test("desktop: + saves a page into the collection being shown", async () => {
  const posts: unknown[] = [];
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: saveStub(posts),
  });
  await app.waitFor("text:Article a");
  await app.press("label:Homelab");
  await app.press("label:Add bookmark");
  await app.waitFor("id:add-url");
  expect(app.texts().join(" ")).toContain("Into Homelab.");

  await app.type("id:add-url", "not a url");
  await app.press("id:add-save");
  await app.waitFor("id:add-error");
  expect(posts).toEqual([]);

  await app.clear("id:add-url");
  await app.type("id:add-url", "new.example/post");
  await app.press("id:add-save");
  await app.waitFor("text:new.example/post");
  expect(posts).toEqual([{ url: "https://new.example/post", collectionId: "c1" }]);
  expect(app.shows("id:add-url")).toBe(false);
});

test("phone: + in the header opens a page that saves", async () => {
  const posts: unknown[] = [];
  const app = await open("./App.tsx", { ...saved, network: saveStub(posts) });
  await app.waitFor("text:Article a");
  await app.press("label:Add bookmark");
  await app.waitFor("id:add-url");
  await app.type("id:add-url", "https://new.example/x");
  await app.press("id:add-save");
  await app.waitFor("text:new.example/x");
  expect(posts).toEqual([{ url: "https://new.example/x" }]);
});

test("share text pastes as its link, and short links say they'll be followed", async () => {
  const posts: { url: string }[] = [];
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: saveStub(posts),
  });
  await app.waitFor("text:Article a");
  await app.press("label:Add bookmark");
  await app.waitFor("id:add-url");
  await app.paste("id:add-url", {
    text: "【好物分享】 http://xhslink.com/a/AbC123 复制本条信息，打开【小红书】App查看精彩内容！",
  });
  await app.waitFor("text:A short link: the page it leads to is saved.");
  await app.press("id:add-save");
  await app.waitFor("text:xhslink.com/a/AbC123");
  expect(posts.map((p) => p.url)).toEqual(["http://xhslink.com/a/AbC123"]);
});

test("the form starts from a link on the clipboard", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    clipboard: "look at this https://example.org/post!",
    network: saveStub([]),
  });
  await app.waitFor("text:Article a");
  await app.press("label:Add bookmark");
  await app.waitFor("text:From the clipboard.");
  expect(app.texts().join(" ")).toContain("From the clipboard.");
});
