import { expect, open, test } from "nsh/test";
import { shortDate, timeOfDay } from "./lib/format";

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
  tags: [] as string[],
  collectionId: null,
  favorite: false,
  trashed: false,
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
    {
      id: "c1",
      name: "Homelab",
      parentId: null,
      sort: 1,
      color: null,
      deletedAt: null as string | null,
      seq: 1,
    },
  ],
  bookmarks: [
    bookmark("a", { collectionId: "c1", tags: ["rust"], createdAt: "2026-11-04T10:00:00.000Z" }),
    bookmark("bb", { favorite: true, createdAt: "2026-11-03T10:00:00.000Z" }),
    bookmark("ccc", {
      trashed: true,
      excerpt: "Mail ( [\\[email protected\\]](https://x.test) ) us",
      createdAt: "2026-11-02T10:00:00.000Z",
    }),
    bookmark("dddd", { contentStatus: "failed", title: "", createdAt: "2026-11-01T10:00:00.000Z" }),
  ],
  highlights: [
    { id: "h1", bookmarkId: "a", quote: "x", prefix: "", suffix: "", note: null, color: null },
  ],
};

/**
 * A platform with a share sheet: headless runs have none unless told
 * (`Share.available()` resolves false), and the menus leave *Share…* out.
 */
const shareable = {
  nsh: {
    "Share.available": () => true,
    "Share.show": () => ({ action: "shared", target: null }),
  },
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

test("phone: opens on the Library page; all bookmarks are newest first, from a sync", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("id:source-all");
  await app.waitFor("text:Homelab");
  await app.press("id:source-all");
  await app.waitFor("text:Article a");
  const texts = app.texts();
  // Bookmarks in the Trash stay out of "All bookmarks"; a page with no title shows its URL.
  expect(texts).not.toContain("Article ccc");
  expect(texts.indexOf("Article a")).toBeLessThan(texts.indexOf("Article bb"));
  expect(texts).toContain("example.com/dddd");
  expect(texts).toContain("Unreadable");
  expect(texts.join(" ")).toContain("example.com  ·  Homelab");
});

test("desktop: a snapshot from another server is dropped, not merged", async () => {
  const snapshot = (server: string) =>
    JSON.stringify({
      server,
      cursor: 3,
      bookmarks: [bookmark("zzz", { collectionId: "c9" })],
      collections: [
        {
          id: "c9",
          name: "Elsewhere",
          parentId: null,
          sort: 2,
          color: null,
          deletedAt: null,
          seq: 1,
        },
      ],
      highlights: [],
    });
  const empty = { cursor: 9, hasMore: false, collections: [], bookmarks: [], highlights: [] };
  const desktop = { platform: "macos", width: 1200, height: 800 } as const;

  // Written by another build (or the e2e host) connected elsewhere.
  const other = await open("./App.tsx", {
    ...desktop,
    storage: { ...saved.storage, "library.v3": snapshot("http://127.0.0.1:8787") },
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await other.waitFor("text:Article a");
  expect(other.shows("text:Elsewhere")).toBe(false);
  expect(other.shows("text:Article zzz")).toBe(false);

  // This server's own snapshot shows, and the sync only catches up.
  const same = await open("./App.tsx", {
    ...desktop,
    storage: { ...saved.storage, "library.v3": snapshot(S) },
    network: { [`GET ${S}/v1/sync*`]: { body: empty } },
  });
  await same.waitFor("text:Article zzz");
  expect(same.shows("text:Elsewhere")).toBe(true);
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
  await app.press("label:Trash");
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

test("desktop: resizing the window keeps the place (the app isn't mounted again)", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Article a");
  await app.press("label:Trash");
  await app.waitFor("text:Article ccc");
  for (const w of [1180, 1100, 900, 700, 1300]) await app.setViewport(w, 800);
  expect(app.shows("text:Article ccc")).toBe(true);
  expect(app.shows("text:Article a")).toBe(false);
});

test("desktop: a narrow Mac window keeps the sidebar, not the phone's Library page", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1000,
    height: 700,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Article a");
  await app.setViewport(560, 700);
  // The sidebar's section header (the phone's Library page says "Collections").
  expect(app.texts()).toContain("COLLECTIONS");
  expect(app.shows("text:Library")).toBe(false);
});

test("desktop: ⌘B hides the sidebar and shows it again", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Article a");
  expect(app.texts()).toContain("COLLECTIONS");
  await app.keyboard.press("mod+b");
  await app.waitUntil(() => !app.texts().includes("COLLECTIONS"));
  expect(app.shows("text:Article a")).toBe(true);
  await app.keyboard.press("mod+b");
  await app.waitFor("text:COLLECTIONS");
});

test("desktop: sections fold away, and collections are put in order by dragging", async () => {
  const col = (id: string, name: string, sort: number) => ({
    id,
    name,
    parentId: null,
    sort,
    color: null,
    deletedAt: null,
    seq: 1,
  });
  const patches: { id: string; sort: number }[] = [];
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: {
      [`GET ${S}/v1/sync*`]: {
        body: {
          ...library,
          collections: [col("c1", "Homelab", 0), col("c2", "Learn", 1), col("c3", "Papers", 2)],
        },
      },
      [`PATCH ${S}/v1/collections/*`]: (r) => {
        const id = r.url.split("/").pop() ?? "";
        const { sort } = JSON.parse(r.body ?? "{}");
        patches.push({ id, sort });
        return { body: { ...col(id, id, sort), seq: 2 } };
      },
    },
  });
  await app.waitFor("label:Homelab");

  // Clicking a heading folds its section away and back.
  await app.press("id:section-collections");
  expect(app.shows("label:Homelab")).toBe(false);
  expect(app.shows("label:Highlights")).toBe(true);
  await app.press("id:section-collections");
  await app.waitFor("label:Homelab");

  // Mid-drag: a line marks where Homelab will land, below Learn.
  await app.dragAndHold("id:collection-c1", { y: 60 });
  expect(app.shows("id:drop-line")).toBe(true);
  await app.drop();
  expect(app.shows("id:drop-line")).toBe(false);
  await app.waitUntil(() => patches.length === 2);
  expect(patches).toEqual([
    { id: "c2", sort: 0 },
    { id: "c1", sort: 1 },
  ]);
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
      [`GET ${S}/v1/bookmarks/a/highlights`]: { body: { items: [] } },
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
  [`GET ${S}/v1/bookmarks/a/highlights`]: { body: { items: [] } },
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

  // The form stays through the dialog's fade out, then goes: opened again, it starts empty.
  await app.press("label:Add bookmark");
  await app.waitFor("id:add-url");
  expect(app.value("id:add-url")).toBe("");
});

test("desktop: + doesn't save a link that's already saved", async () => {
  const posts: unknown[] = [];
  const network = saveStub(posts);
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: {
      ...network,
      // The server follows a short link to a page that's saved: it answers with that bookmark.
      [`POST ${S}/v1/bookmarks`]: (r: { body?: string | null }) => {
        const input = JSON.parse(r.body ?? "{}");
        if (input.url !== "https://t.co/abc") return network[`POST ${S}/v1/bookmarks`](r);
        posts.push(input);
        return { status: 200, body: library.bookmarks[1] };
      },
    },
  });
  await app.waitFor("text:Article a");
  await app.press("label:Add bookmark");
  await app.waitFor("id:add-url");

  // The same page, as another address for it: not sent at all.
  await app.type("id:add-url", "http://www.example.com/a?utm_source=x#top");
  await app.press("id:add-save");
  await app.waitFor("text:Already saved as “Article a”. It's in Homelab.");
  expect(posts).toEqual([]);
  expect(app.shows("id:add-url")).toBe(true);

  // One in the Trash says so.
  await app.clear("id:add-url");
  await app.type("id:add-url", "https://example.com/ccc");
  await app.press("id:add-save");
  await app.waitFor("text:Already saved as “Article ccc”. It's in the Trash.");
  expect(posts).toEqual([]);

  // One only the server knows is saved: the dialog says so rather than closing.
  await app.clear("id:add-url");
  await app.type("id:add-url", "https://t.co/abc");
  await app.press("id:add-save");
  await app.waitFor("text:Already saved as “Article bb”.");
  expect(posts).toEqual([{ url: "https://t.co/abc" }]);
  expect(app.shows("id:add-url")).toBe(true);
});

test("phone: the Library page's search narrows it to the names that match", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Homelab");
  await app.type("id:home-search", "home");
  await app.waitFor("id:search-bookmarks");
  expect(app.shows("text:Homelab")).toBe(true);
  expect(app.shows("text:rust")).toBe(false);
  expect(app.shows("text:Favorites")).toBe(false);
  await app.clear("id:home-search");
  await app.waitFor("text:rust");
});

test("phone: + beside the search opens a page that saves", async () => {
  const posts: unknown[] = [];
  const app = await open("./App.tsx", { ...saved, network: saveStub(posts) });
  await app.waitFor("id:source-all");
  await app.press("id:source-all");
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

/** A server that takes patches and deletions, recording them. */
const editable = (log: { patches: [string, unknown][]; deletes: string[] }) => ({
  [`GET ${S}/v1/sync*`]: { body: library },
  [`PATCH ${S}/v1/bookmarks/*`]: (r: { url: string; body?: string | null }) => {
    const id = r.url.split("/").pop() ?? "";
    const patch = JSON.parse(r.body ?? "{}");
    log.patches.push([id, patch]);
    const b = library.bookmarks.find((x) => x.id === id);
    return { body: { ...b, ...patch } };
  },
  [`DELETE ${S}/v1/bookmarks/*`]: (r: { url: string }) => {
    log.deletes.push(r.url.split("/").pop() ?? "");
    return { status: 204 };
  },
});

test("phone: the Trash is last on the Library page, and holds what was deleted", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("id:source-trash");
  const texts = app.texts();
  expect(texts.lastIndexOf("Trash")).toBeGreaterThan(texts.indexOf("rust"));
  expect(texts).not.toContain("Archive");
  await app.press("id:source-trash");
  await app.waitFor("text:Article ccc");
  expect(app.shows("text:Article a")).toBe(false);
});

test("phone: swiping a row left deletes it into the Trash", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", { ...saved, network: editable(log), modules: shareable });
  await app.waitFor("id:source-all");
  await app.press("id:source-all");
  await app.waitFor("text:Article bb");
  await app.drag("id:row-bb", { x: -200, y: 0 });
  await app.waitFor("id:swipe-delete");
  expect(app.shows("id:swipe-share")).toBe(true);
  expect(app.shows("id:swipe-more")).toBe(true);
  await app.press("id:swipe-delete");
  // It leaves the list at once, before the server answers.
  await app.waitUntil(() => !app.shows("text:Article bb"));
  await app.waitUntil(() => log.patches.length > 0);
  expect(log.patches).toEqual([["bb", { trashed: true }]]);
  expect(log.deletes).toEqual([]);
});

test("phone: a search result that is deleted leaves the results", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const bb = library.bookmarks.find((x) => x.id === "bb");
  const app = await open("./App.tsx", {
    ...saved,
    network: {
      ...editable(log),
      [`GET ${S}/v1/search*`]: { body: { hits: [{ bookmark: bb, snippet: null }] } },
    },
  });
  await app.waitFor("id:home-search");
  await app.type("id:home-search", "bb");
  await app.press("id:search-bookmarks");
  await app.waitFor("id:row-bb");
  await app.drag("id:row-bb", { x: -200, y: 0 });
  await app.waitFor("id:swipe-delete");
  await app.press("id:swipe-delete");
  await app.waitUntil(() => log.patches.length > 0);
  await app.waitUntil(() => !app.shows("id:row-bb"));
  expect(log.patches).toEqual([["bb", { trashed: true }]]);
});

test("phone: the list's filter narrows it, the view changes, and a search keeps the filter", async () => {
  const searches: string[] = [];
  const app = await open("./App.tsx", {
    ...saved,
    network: {
      [`GET ${S}/v1/sync*`]: { body: library },
      [`GET ${S}/v1/search*`]: (r: { url: string }) => {
        const q = new URL(r.url).searchParams.get("q") ?? "";
        searches.push(q);
        const hits = library.bookmarks
          .filter((b) => !b.trashed && (!q.includes("favorite:true") || b.favorite))
          .map((bookmark) => ({ bookmark, snippet: null }));
        return { body: { hits, estimatedTotal: hits.length } };
      },
    },
  });
  await app.waitFor("id:source-all");
  await app.press("id:source-all");
  await app.waitFor("text:Article a");

  // Favorites only: a chip says so, with how many of the list are left.
  await app.press("id:filter-button");
  await app.press("id:filter-favorite");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("text:Article a"));
  expect(app.shows("text:Article bb")).toBe(true);
  expect(app.shows("id:filter-chip-favorite")).toBe(true);
  expect(app.texts()).toContain("1 of 3");

  // The view is the phone's own: cards, still filtered.
  await app.press("id:view-button");
  await app.press("id:view-cards");
  await app.keyboard.press("escape");
  await app.waitFor("id:card-bb");
  expect(app.shows("id:card-a")).toBe(false);

  // A search sends the filter's conditions to the server.
  await app.back();
  await app.waitFor("id:home-search");
  await app.type("id:home-search", "article");
  await app.press("id:search-bookmarks");
  await app.waitFor("id:card-a");
  await app.press("id:filter-button");
  await app.press("id:filter-favorite");
  await app.keyboard.press("escape");
  await app.waitUntil(() => searches.includes("article favorite:true"));
  await app.waitUntil(() => !app.shows("id:card-a"));
  expect(app.shows("id:card-bb")).toBe(true);

  // Its ✕ drops it.
  await app.press("id:filter-chip-favorite");
  await app.waitFor("id:card-a");
});

test("phone: swiping a row right moves it to a collection", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", { ...saved, network: editable(log) });
  const asked: string[][] = [];
  app.onDialog((d) => {
    asked.push(d.buttons);
    return "Homelab";
  });
  await app.waitFor("id:source-all");
  await app.press("id:source-all");
  await app.waitFor("text:Article bb");
  await app.drag("id:row-bb", { x: 160, y: 0 });
  await app.waitFor("id:swipe-move");
  await app.press("id:swipe-move");
  await app.waitUntil(() => log.patches.length > 0);
  expect(asked[0]).toEqual(["Homelab", "Cancel"]);
  expect(log.patches).toEqual([["bb", { collectionId: "c1", trashed: false }]]);
});

test("phone: deleting from the Trash asks, then deletes for good", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", { ...saved, network: editable(log) });
  const titles: string[] = [];
  app.onDialog((d) => {
    titles.push(d.title ?? "");
    return "Delete";
  });
  await app.waitFor("id:source-trash");
  await app.press("id:source-trash");
  await app.waitFor("text:Article ccc");
  await app.drag("id:row-ccc", { x: -200, y: 0 });
  await app.waitFor("id:swipe-delete");
  await app.press("id:swipe-delete");
  await app.waitUntil(() => !app.shows("text:Article ccc"));
  await app.waitUntil(() => log.deletes.length > 0);
  expect(titles).toEqual(["Delete permanently?"]);
  expect(log.deletes).toEqual(["ccc"]);
  expect(log.patches).toEqual([]);
});

test("desktop: the context menu moves, shares and deletes", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", {
    ...saved,
    platform: "macos",
    width: 1200,
    height: 800,
    network: editable(log),
    modules: shareable,
  });
  await app.waitFor("text:Article bb");
  await app.rightClick("id:card-bb");
  const labels = (app.menu() ?? []).map((m) => m.label);
  expect(labels).toContain("Share…");
  expect(labels).toContain("Move to > Homelab");
  expect(labels).toContain("Delete");
  expect(labels.some((l) => /archive/i.test(l))).toBe(false);
  await app.chooseMenuItem("Move to > Homelab");
  await app.waitUntil(() => log.patches.length === 1);
  expect(log.patches[0]).toEqual(["bb", { collectionId: "c1", trashed: false }]);

  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Delete");
  await app.waitUntil(() => log.patches.length === 2);
  expect(log.patches[1]).toEqual(["a", { trashed: true }]);
  await app.press("label:Trash");
  await app.waitFor("text:Article a");
});

const desktop = { ...saved, platform: "macos" as const, width: 1200, height: 800 };

test("desktop: a bookmark's menu opens it in the reader, the app or the browser", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", { ...desktop, network: { ...editable(log), ...readable } });
  await app.waitFor("text:Article a");
  await app.rightClick("id:card-a");
  const menu = app.menu() ?? [];
  expect(menu.slice(0, 4).map((m) => m.label)).toEqual([
    "Open in Reader",
    "Open Original",
    "Open in Browser",
    "Copy Link",
  ]);
  // Where it is now is checked, and isn't a place to move it to.
  expect(menu.find((m) => m.label === "Move to > Homelab")).toMatchObject({
    checked: true,
    disabled: true,
  });
  expect(menu.find((m) => m.label === "Move to > Unsorted")?.disabled).toBe(false);
  await app.chooseMenuItem("Open in Browser");
  expect(app.openedUrls()).toEqual(["https://example.com/a"]);
  expect(app.shows("id:article")).toBe(false);

  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Open Original");
  await app.waitFor("id:web");
  await app.press("label:Close page");

  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Open in Reader");
  await app.waitFor("text:Some text to read here.");
  expect(app.openedUrls()).toEqual(["https://example.com/a"]);
});

test("desktop: the reader's ••• has the ways to open the page and what its toolbar hasn't", async () => {
  const app = await open("./App.tsx", { ...desktop, network: readable });
  await app.press("text:Article a");
  await app.waitFor("text:Some text to read here.");
  await app.press("label:More");
  const labels = (app.menu() ?? []).map((m) => m.label);
  expect(labels).toContain("Open Original");
  expect(labels).toContain("Open in Browser");
  expect(labels).toContain("Copy Link");
  expect(labels).toContain("Move to > Unsorted");
  for (const gone of ["Open in Reader", "Add to Favorites", "Share…", "Delete", "Mark as Read"]) {
    expect(labels).not.toContain(gone);
  }
  expect(labels.some((l) => l.startsWith("Edit"))).toBe(false);
});

test("desktop: a tap opens bookmarks where Settings says", async () => {
  const app = await open("./App.tsx", { ...desktop, network: readable });
  await app.waitFor("text:Article a");
  await app.press("id:settings");
  // A pop-up button in its row, with the system's menu.
  await app.waitFor("id:open-in");
  await app.press("id:open-in");
  await app.chooseMenuItem("Original page, in your browser");
  expect(app.storage()["prefs.v1"]).toContain('"openIn":"browser"');
  await app.press("id:settings-done");
  await app.press("text:Article a");
  expect(app.openedUrls()).toEqual(["https://example.com/a"]);
  expect(app.shows("id:article")).toBe(false);
});

test("desktop: a site set to open as a web page has no reader", async () => {
  const app = await open("./App.tsx", {
    ...desktop,
    network: { ...readable, [`GET ${S}/v1/settings`]: { body: { skipDomains: ["example.com"] } } },
  });
  await app.waitFor("text:Article a");
  await app.waitUntil(() => app.storage()["sites.v1"] === '["example.com"]');
  // Never fetched: it isn't unreadable.
  expect(app.texts()).not.toContain("Unreadable");
  await app.rightClick("id:card-a");
  const labels = (app.menu() ?? []).map((m) => m.label);
  expect(labels).toContain("Open Original");
  expect(labels).not.toContain("Open in Reader");
  await app.chooseMenuItem("Copy Link");
  // A tap opens the page, though Settings says the reader.
  await app.press("text:Article a");
  await app.waitFor("id:web");
  expect(app.shows("id:article")).toBe(false);
});

test("desktop: Settings adds and removes the sites opened as web pages", async () => {
  const sent: unknown[] = [];
  let sites: string[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      ...readable,
      [`GET ${S}/v1/settings`]: () => ({ body: { skipDomains: sites } }),
      [`PATCH ${S}/v1/settings`]: (r) => {
        const body = JSON.parse(r.body ?? "{}");
        sent.push(body);
        sites = [...body.skipDomains].sort();
        return { body: { skipDomains: sites } };
      },
    },
  });
  await app.waitFor("text:Article a");
  await app.press("id:settings");
  await app.waitFor("id:sites-new");
  await app.type("id:sites-new", "not a site");
  await app.press("id:sites-add");
  await app.waitFor("id:sites-error");
  expect(sent).toEqual([]);

  await app.clear("id:sites-new");
  await app.type("id:sites-new", "https://www.Example.com/a");
  await app.press("id:sites-add");
  await app.waitFor("id:sites-remove-example.com");
  expect(sent).toEqual([{ skipDomains: ["example.com"] }]);
  await app.type("id:sites-new", "x.com");
  await app.press("id:sites-add");
  await app.waitFor("id:sites-remove-x.com");
  await app.press("id:sites-remove-example.com");
  await app.waitUntil(() => sent.length === 3);
  expect(sent[2]).toEqual({ skipDomains: ["x.com"] });
  await app.waitUntil(() => !app.shows("id:sites-remove-example.com"));
  expect(app.storage()["sites.v1"]).toBe('["x.com"]');
});

test("times are shown on the clock Settings chooses", async () => {
  const at = new Date(2026, 10, 27, 15, 43);
  expect(timeOfDay(at, "12h")).toBe("3:43 PM");
  expect(timeOfDay(at, "24h")).toBe("15:43");
  expect(timeOfDay(new Date(2026, 10, 27, 0, 5), "12h")).toBe("12:05 AM");
  expect(timeOfDay(new Date(2026, 10, 27, 9, 5), "24h")).toBe("09:05");
  expect(shortDate(at.toISOString(), at, "24h")).toBe("15:43");

  const app = await open("./App.tsx", { ...desktop, network: readable });
  await app.waitFor("text:Article a");
  await app.press("id:settings");
  await app.waitFor("id:time-format");
  await app.press("id:time-format");
  expect((app.menu() ?? []).map((m) => m.label)).toContain("24-hour (15:43)");
  await app.chooseMenuItem("24-hour (15:43)");
  expect(app.storage()["prefs.v1"]).toContain('"timeFormat":"24h"');
  await app.waitFor("text:24-hour");
});

test("desktop: a bookmark is marked read or unread from its menu", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", { ...desktop, network: editable(log) });
  await app.waitFor("text:Article bb");
  await app.rightClick("id:card-bb");
  await app.chooseMenuItem("Mark as Read");
  await app.waitUntil(() => log.patches.length === 1);
  expect(log.patches[0]).toEqual(["bb", { readProgress: 1 }]);
  await app.rightClick("id:card-bb");
  await app.chooseMenuItem("Mark as Unread");
  await app.waitUntil(() => log.patches.length === 2);
  expect(log.patches[1]).toEqual(["bb", { readProgress: 0 }]);
});

test("phone: deleting from the reader's ••• goes back to the list", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  // The web's bar of its own: headless, the system's header has no buttons to press.
  const app = await open("./App.tsx", {
    ...saved,
    platform: "web",
    width: 390,
    height: 800,
    network: { ...editable(log), ...readable },
  });
  await app.waitFor("id:source-all");
  await app.press("id:source-all");
  await app.press("text:Article a");
  await app.waitFor("text:Some text to read here.");
  const offered: string[] = [];
  app.onDialog((d) => {
    offered.push(...d.buttons);
    return "Delete";
  });
  await app.press("label:More");
  await app.waitUntil(() => log.patches.length > 0);
  expect(log.patches).toEqual([["a", { trashed: true }]]);
  expect(offered).not.toContain("Open in Reader");
  expect(offered).toContain("Open Original");
  await app.waitUntil(() => !app.shows("id:article"));
  await app.waitFor("text:Article bb");
});

test("desktop: a highlight the text has lost still counts, and can be removed", async () => {
  const deleted: string[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      ...readable,
      [`GET ${S}/v1/bookmarks/a/highlights`]: {
        body: {
          items: [
            { id: "h1", bookmarkId: "a", quote: "words that are gone", prefix: "", suffix: "" },
          ],
        },
      },
      [`DELETE ${S}/v1/highlights/h1`]: () => {
        deleted.push("h1");
        return { status: 204 };
      },
    },
  });
  await app.press("text:Article a");
  await app.waitUntil(() => app.texts().some((t) => t.includes("1 not found")));
  // Opening it doesn't drop it from Highlights.
  expect(app.texts().join(" ")).toContain("Highlights 1");
  const asked: string[] = [];
  app.onDialog((d) => {
    asked.push(d.message ?? "");
    return "Remove it";
  });
  await app.press("label:Highlights not found");
  await app.waitUntil(() => deleted.length > 0);
  expect(asked[0]).toContain("“words that are gone”");
  await app.waitUntil(() => !app.texts().some((t) => t.includes("not found")));
});

test("desktop: a bookmark's title, tags and note are edited, and the note shows above the text", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      ...editable(log),
      ...readable,
      [`PATCH ${S}/v1/bookmarks/a`]: (r) => {
        const patch = JSON.parse(r.body ?? "{}");
        log.patches.push(["a", patch]);
        return { body: { ...library.bookmarks[0], ...patch } };
      },
    },
  });
  await app.waitFor("text:Article a");
  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Edit Title, Tags and Note…");
  await app.waitFor("id:edit-title");
  await app.clear("id:edit-title");
  await app.type("id:edit-title", "A better title");
  await app.clear("id:edit-tags");
  await app.type("id:edit-tags", "rust, Reading List");
  await app.type("id:edit-note", "Read the second half.");
  await app.press("id:edit-save");
  await app.waitUntil(() => log.patches.length > 0);
  expect(log.patches[0]).toEqual([
    "a",
    { title: "A better title", tags: ["rust", "reading list"], note: "Read the second half." },
  ]);
  await app.waitFor("text:A better title");
  await app.press("text:A better title");
  await app.waitFor("text:Read the second half.");
  await app.waitFor("text:Some text to read here.");
});

test("desktop: tags are chips, suggested from the tags in use as they're typed", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      ...editable(log),
      ...readable,
      [`PATCH ${S}/v1/bookmarks/a`]: (r) => {
        const patch = JSON.parse(r.body ?? "{}");
        log.patches.push(["a", patch]);
        return { body: { ...library.bookmarks[0], ...patch } };
      },
    },
  });
  await app.waitFor("text:Article a");
  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Edit Title, Tags and Note…");
  await app.waitFor("id:tag-chip-rust");
  // Backspace in the empty input takes the last chip off.
  await app.press("id:edit-tags");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => !app.shows("id:tag-chip-rust"));
  // Typing suggests the tag in use, and Return takes it.
  await app.type("id:edit-tags", "ru");
  await app.waitFor("id:tag-suggest-rust");
  await app.submit("id:edit-tags");
  await app.waitFor("id:tag-chip-rust");
  expect(app.value("id:edit-tags")).toBe("");
  // A tag nobody uses yet is offered to be created; a comma adds it too.
  await app.type("id:edit-tags", "Deep Dives");
  await app.waitFor("id:tag-suggest-+new");
  await app.submit("id:edit-tags");
  await app.waitFor("id:tag-chip-deep dives");
  await app.type("id:edit-tags", "later, ");
  await app.waitFor("id:tag-chip-later");
  await app.press("label:Remove tag rust");
  await app.waitUntil(() => !app.shows("id:tag-chip-rust"));
  await app.press("id:edit-save");
  await app.waitUntil(() => log.patches.length > 0);
  expect(log.patches[0]).toEqual(["a", { tags: ["deep dives", "later"] }]);
});

test('desktop: a long list of tags folds behind "+N more" and narrows as it\'s typed', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `topic ${String(i + 1).padStart(2, "0")}`);
  const long = "an extremely long tag name that would never fit on one line of the dialog";
  const lib = {
    ...library,
    bookmarks: library.bookmarks.map((b) => (b.id === "bb" ? { ...b, tags: [...many, long] } : b)),
  };
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", {
    ...desktop,
    network: { ...editable(log), ...readable, [`GET ${S}/v1/sync*`]: { body: lib } },
  });
  await app.waitFor("text:Article a");
  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Edit Title, Tags and Note…");
  await app.waitFor("id:tag-suggest-more");
  expect(app.count("id:tag-suggest-topic 01")).toBe(1);
  expect(app.shows("id:tag-suggest-topic 30")).toBe(false);
  expect(app.texts()).toContain("+19 more");
  await app.press("id:tag-suggest-more");
  await app.waitFor("id:tag-suggest-topic 30");
  expect(app.texts()).toContain("Show fewer");
  // Typing narrows them; the fold has nothing to hide then.
  await app.type("id:edit-tags", "topic 2");
  await app.waitUntil(() => !app.shows("id:tag-suggest-topic 01"));
  expect(app.shows("id:tag-suggest-topic 29")).toBe(true);
  await app.press("id:tag-suggest-topic 25");
  await app.waitFor("id:tag-chip-topic 25");
  expect(app.value("id:edit-tags")).toBe("");
  // The pills lay out again for the cleared input before the next press.
  await app.waitFor(`id:tag-suggest-${long}`);
  await app.wait(100);
  await app.press(`id:tag-suggest-${long}`);
  await app.waitFor(`id:tag-chip-${long}`);
  await app.press("id:edit-save");
  await app.waitUntil(() => log.patches.length > 0);
  expect(log.patches[0]).toEqual(["a", { tags: ["rust", "topic 25", long] }]);
});

test("offline: a change waits on the device and is sent once the server is back", async () => {
  let online = false;
  const patches: unknown[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: () => {
        if (!online) return { error: "offline" };
        const bookmarks = library.bookmarks.map((b) =>
          b.id === "bb" ? { ...b, ...(patches[0] as object) } : b,
        );
        return { body: { ...library, bookmarks } };
      },
      [`PATCH ${S}/v1/bookmarks/bb`]: (r) => {
        if (!online) return { error: "offline" };
        const patch = JSON.parse(r.body ?? "{}");
        patches.push(patch);
        return { body: { ...library.bookmarks[1], ...patch } };
      },
    },
  });
  online = true;
  await app.press("id:sync");
  await app.waitFor("text:Article bb");
  online = false;
  await app.rightClick("id:card-bb");
  await app.chooseMenuItem("Remove from Favorites");
  // It stays changed, and says it's waiting.
  await app.waitUntil(() => app.texts().some((t) => t.includes("1 change waiting")));
  await app.press("label:Favorites");
  await app.waitUntil(() => !app.shows("text:Article bb"));
  online = true;
  await app.press("id:sync");
  await app.waitUntil(() => patches.length > 0);
  expect(patches).toEqual([{ favorite: false }]);
  await app.waitFor("text:Up to date");
  expect(app.shows("text:Article bb")).toBe(false);
});

test("offline: a change made while a waiting one is being sent is sent too", async () => {
  let online = false;
  const patches: unknown[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: () => (online ? { body: library } : { error: "offline" }),
      [`PATCH ${S}/v1/bookmarks/bb`]: (r) => {
        if (!online) return { error: "offline" };
        const patch = JSON.parse(r.body ?? "{}");
        patches.push(patch);
        // Slow: the next change comes while this one is on its way.
        return { body: { ...library.bookmarks[1], ...patch }, delay: 1500 };
      },
    },
  });
  online = true;
  await app.press("id:sync");
  await app.waitFor("text:Article bb");
  online = false;
  await app.rightClick("id:card-bb");
  await app.chooseMenuItem("Remove from Favorites");
  await app.waitUntil(() => app.texts().some((t) => t.includes("1 change waiting")));
  online = true;
  await app.press("id:sync");
  await app.waitUntil(() => patches.length === 1);
  await app.rightClick("id:card-bb");
  await app.chooseMenuItem("Add to Favorites");
  await app.waitUntil(() => patches.length === 2, { timeout: 8000 });
  expect(patches).toEqual([{ favorite: false }, { favorite: true }]);
});

test("desktop: tags are renamed and collections deleted from their menus", async () => {
  const calls: string[] = [];
  // The server's library, as the changes leave it.
  let now = library;
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: () => ({ body: now }),
      [`POST ${S}/v1/tags/rename`]: (r) => {
        calls.push(`rename ${r.body}`);
        now = {
          ...now,
          bookmarks: now.bookmarks.map((b) =>
            b.tags.includes("rust") ? { ...b, tags: ["rustlang"] } : b,
          ),
        };
        return { body: { updated: 1 } };
      },
      [`DELETE ${S}/v1/collections/c1`]: () => {
        calls.push("delete c1");
        now = {
          ...now,
          collections: now.collections.map((c) => ({ ...c, deletedAt: "2026-11-06T00:00:00Z" })),
          bookmarks: now.bookmarks.map((b) => ({ ...b, collectionId: null })),
        };
        return { status: 204 };
      },
    },
  });
  await app.waitFor("label:rust");
  await app.rightClick("label:rust");
  await app.chooseMenuItem("Rename or merge…");
  await app.waitFor("id:prompt-text");
  await app.clear("id:prompt-text");
  await app.type("id:prompt-text", "Rustlang");
  await app.press("id:prompt-confirm");
  await app.waitUntil(() => calls.length > 0);
  expect(calls[0]).toBe(`rename ${JSON.stringify({ from: "rust", to: "rustlang" })}`);
  await app.waitFor("label:rustlang");

  app.onDialog(() => "Delete");
  await app.rightClick("label:Homelab");
  await app.chooseMenuItem("Delete collection…");
  await app.waitUntil(() => calls.length > 1);
  expect(calls[1]).toBe("delete c1");
  await app.press("label:Unsorted");
  await app.waitFor("text:Article a");
});

test("desktop: the sidebar's + makes a collection and opens it", async () => {
  let now = library;
  const posts: string[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: () => ({ body: now }),
      [`POST ${S}/v1/collections`]: (r) => {
        posts.push(r.body ?? "");
        const c = { ...now.collections[0], id: "c9", name: "Reading list", seq: 99 };
        now = { ...now, collections: [...now.collections, c] };
        return { status: 201, body: c };
      },
    },
  });
  await app.waitFor("id:new-collection");
  await app.press("id:new-collection");
  await app.waitFor("id:prompt-text");
  await app.type("id:prompt-text", "Reading list");
  await app.press("id:prompt-confirm");
  await app.waitUntil(() => posts.length > 0);
  expect(JSON.parse(posts[0])).toEqual({ name: "Reading list" });
  await app.waitFor("id:collection-c9");
  // It's opened: the library shows it, empty (All bookmarks isn't).
  await app.waitFor("text:Nothing here yet");
});

test("desktop: a renamed collection keeps its row in the sidebar, with the new name", async () => {
  let now = library;
  const patches: unknown[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: () => ({ body: now }),
      [`PATCH ${S}/v1/collections/c1`]: (r) => {
        const patch = JSON.parse(r.body ?? "{}");
        patches.push(patch);
        const c = { ...now.collections[0], ...patch, seq: 10 };
        now = { ...now, collections: [c] };
        return { body: c };
      },
    },
  });
  await app.waitFor("label:Homelab");
  await app.press("label:Homelab");
  await app.waitFor("id:library-title");
  await app.rightClick("id:collection-c1");
  await app.chooseMenuItem("Rename…");
  await app.waitFor("id:prompt-text");
  await app.clear("id:prompt-text");
  await app.type("id:prompt-text", "Lab notes");
  await app.press("id:prompt-confirm");
  await app.waitUntil(() => patches.length > 0);
  expect(patches[0]).toEqual({ name: "Lab notes" });
  // The row is kept (by id), and says the new name; it's still the one selected.
  await app.waitFor("label:Lab notes");
  expect(app.shows("label:Homelab")).toBe(false);
  expect(app.count("id:collection-c1")).toBe(1);
  // Still the source shown.
  expect(app.texts()).toContain("Lab notes");
  expect(app.shows("text:Nothing here yet")).toBe(false);
});

test("desktop: the sidebar's Tags heading counts the tags as they change", async () => {
  const log = { patches: [] as [string, unknown][], deletes: [] as string[] };
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      ...editable(log),
      [`PATCH ${S}/v1/bookmarks/bb`]: (r) => {
        const patch = JSON.parse(r.body ?? "{}");
        log.patches.push(["bb", patch]);
        return { body: { ...library.bookmarks[1], ...patch, seq: 5 } };
      },
    },
  });
  await app.waitFor("text:TAGS (1)");
  await app.rightClick("id:card-bb");
  await app.chooseMenuItem("Edit Title, Tags and Note…");
  await app.waitFor("id:edit-tags");
  await app.type("id:edit-tags", "golang, essays,");
  await app.press("id:edit-save");
  await app.waitUntil(() => log.patches.length > 0);
  await app.waitFor("text:TAGS (3)");
  expect(app.shows("text:TAGS (1)")).toBe(false);
  await app.waitFor("label:golang");
});

test("desktop: the moodboard keeps its tiles as a bookmark changes", async () => {
  const many = Array.from({ length: 24 }, (_, k) =>
    bookmark(`m${k}`, {
      createdAt: new Date(Date.parse("2026-11-04T10:00:00.000Z") - k * 60_000).toISOString(),
    }),
  );
  const patches: [string, unknown][] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: { body: { ...library, bookmarks: many, highlights: [] } },
      [`PATCH ${S}/v1/bookmarks/*`]: (r) => {
        const id = r.url.split("/").pop() ?? "";
        const patch = JSON.parse(r.body ?? "{}");
        patches.push([id, patch]);
        const b = many.find((m) => m.id === id);
        return { body: { ...b, ...patch, seq: 50 } };
      },
    },
  });
  await app.waitFor("id:card-m0");
  await app.press("id:view-button");
  await app.chooseMenuItem("Moodboard");
  await app.waitFor("id:tile-m5");
  // Under the pointer, the tile is lit (`hover:`): a tile made again isn't, until the pointer moves.
  await app.hover("id:tile-m5");
  const lit = app.viewStyle("id:tile-m5")?.backgroundColor;
  expect(lit).not.toBe(app.viewStyle("id:tile-m6")?.backgroundColor);

  // An edit reaches the tile's column in place: the scroll view, its
  // columns and their tiles stay.
  await app.rightClick("id:tile-m5");
  await app.chooseMenuItem("Add to Favorites");
  await app.waitUntil(() => patches.length > 0);
  expect(patches[0]).toEqual(["m5", { favorite: true }]);
  await app.rightClick("id:tile-m5");
  expect((app.menu() ?? []).map((m) => m.label)).toContain("Remove from Favorites");
  await app.closeMenu();
  expect(app.viewStyle("id:tile-m5")?.backgroundColor).toBe(lit);
});

test("phone web: the Library page's ••• menu opens and collapses sections", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "web",
    width: 390,
    height: 844,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("id:home-menu");
  await app.waitFor("text:Homelab");
  await app.press("id:home-menu");
  await app.waitFor("id:menu-collapse");
  await app.press("id:menu-collapse");
  await app.waitUntil(() => !app.shows("text:Homelab"));
});

/** The titles the library shows, in order (one column: a grid's row says its cards in no set order). */
const order = (texts: string[], titles: string[]) =>
  titles.map((t) => texts.indexOf(t)).every((k, i, a) => k >= 0 && (i === 0 || a[i - 1] < k));

test("desktop: the library sorts by date, name or site, each source its own", async () => {
  const app = await open("./App.tsx", {
    ...desktop,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("id:card-a");
  await app.press("id:view-button");
  await app.chooseMenuItem("List");
  await app.waitFor("id:row-a");
  expect(app.shows("label:Sort by: By date ↓")).toBe(true);
  expect(order(app.texts(), ["Article a", "Article bb"])).toBe(true);

  await app.press("id:sort-button");
  const labels = (app.menu() ?? []).map((m) => m.label);
  expect(labels).toEqual([
    "Sort by",
    "By date ↑",
    "By date ↓",
    "By name (A-Z)",
    "By name (Z-A)",
    "Sites (A-Z)",
    "Sites (Z-A)",
  ]);
  await app.chooseMenuItem("By date ↑");
  await app.waitFor("label:Sort by: By date ↑");
  expect(order(app.texts(), ["example.com/dddd", "Article bb", "Article a"])).toBe(true);
  await app.press("id:sort-button");
  await app.chooseMenuItem("By name (A-Z)");
  await app.waitFor("label:Sort by: By name (A-Z)");
  expect(order(app.texts(), ["Article a", "Article bb", "example.com/dddd"])).toBe(true);

  // A collection keeps its own sort, and starts in its manual order.
  await app.press("label:Homelab");
  await app.waitFor("text:Article a");
  expect(app.shows("label:Sort by: Manual")).toBe(true);
  await app.press("id:sort-button");
  expect((app.menu() ?? []).map((m) => m.label).slice(0, 2)).toEqual([
    "Sort by",
    "Manual (Drag'n'drop)",
  ]);
  await app.chooseMenuItem("By date ↓");
  await app.press("label:All bookmarks");
  await app.waitFor("label:Sort by: By name (A-Z)");
});

test("desktop: the library's view is a list, cards, headlines or a moodboard", async () => {
  const app = await open("./App.tsx", {
    ...desktop,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("id:card-a");
  await app.press("id:view-button");
  expect((app.menu() ?? []).map((m) => m.label)).toEqual([
    "View",
    "List",
    "Cards",
    "Headlines",
    "Moodboard",
    "Apply to All",
    "Show in Cards",
    "Cover",
    "Title",
    "Note",
    "Description",
    "Highlights",
    "Tags",
    "Bookmark info",
    "Cover > Smallest",
    "Cover > Small",
    "Cover > Medium",
    "Cover > Large",
    "Cover > Largest",
  ]);
  // Show in Cards: tags on, the meta line off.
  await app.chooseMenuItem("Tags");
  await app.waitFor("text:#rust");
  expect(app.shows("text:example.com  ·  Homelab  ·  Nov 4")).toBe(true);
  await app.press("id:view-button");
  await app.chooseMenuItem("Bookmark info");
  await app.waitUntil(() => !app.shows("text:example.com  ·  Homelab  ·  Nov 4"));

  await app.press("id:view-button");
  await app.chooseMenuItem("List");
  await app.waitFor("id:row-a");
  expect(app.shows("label:View: List")).toBe(true);
  await app.press("id:view-button");
  const listMenu = (app.menu() ?? []).map((m) => m.label);
  expect(listMenu).toContain("Show in List");
  expect(listMenu.slice(-3)).toEqual(["Cover position", "Left", "Right"]);
  await app.chooseMenuItem("Left");

  // Another source keeps its own, until one view is applied to all.
  await app.press("label:Homelab");
  await app.waitFor("id:card-a");
  await app.press("id:view-button");
  await app.chooseMenuItem("Moodboard");
  await app.waitFor("id:tile-a");
  await app.press("id:view-button");
  await app.chooseMenuItem("Headlines");
  await app.waitFor("id:headline-a");
  await app.press("id:view-button");
  await app.chooseMenuItem("Apply to All");
  await app.press("label:All bookmarks");
  await app.waitFor("id:headline-bb");
});

test("web: the sort and view menus are the app's own", async () => {
  const app = await open("./App.tsx", {
    ...saved,
    platform: "web",
    width: 1200,
    height: 800,
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await app.waitFor("text:Article a");
  await app.press("id:view-button");
  await app.waitFor("text:View");
  await app.press("id:view-headlines");
  await app.waitFor("id:headline-a");
  expect(order(app.texts(), ["Article a", "Article bb"])).toBe(true);

  await app.press("id:sort-button");
  await app.waitFor("text:Sort by");
  await app.press("id:sort-name-desc");
  await app.waitFor("label:Sort by: By name (Z-A)");
  expect(order(app.texts(), ["example.com/dddd", "Article bb", "Article a"])).toBe(true);

  // Show in Headlines: a setting leaves the menu open.
  await app.press("id:view-button");
  await app.waitFor("text:Show in Headlines");
  await app.press("id:show-tags");
  await app.waitFor("text:#rust");
  expect(app.shows("text:Show in Headlines")).toBe(true);
});

test("desktop: a collection's manual order is set by dragging a bookmark into place", async () => {
  const at = (d: string) => `2026-11-0${d}T10:00:00.000Z`;
  const marks = [
    bookmark("m1", { collectionId: "c1", createdAt: at("3") }),
    bookmark("m2", { collectionId: "c1", createdAt: at("2") }),
    bookmark("m3", { collectionId: "c1", createdAt: at("1") }),
  ];
  const patches: [string, { sort?: number }][] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: { body: { ...library, bookmarks: marks } },
      [`PATCH ${S}/v1/bookmarks/*`]: (r) => {
        const id = r.url.split("/").pop() ?? "";
        const patch = JSON.parse(r.body ?? "{}");
        patches.push([id, patch]);
        const b = marks.find((m) => m.id === id);
        return { body: { ...b, ...patch, seq: 2 } };
      },
    },
  });
  await app.press("label:Homelab");
  await app.waitFor("id:card-m1");
  expect(app.shows("label:Sort by: Manual")).toBe(true);
  await app.press("id:view-button");
  await app.chooseMenuItem("Headlines");
  await app.waitFor("id:headline-m1");
  // Newest first until moved.
  expect(order(app.texts(), ["Article m1", "Article m2", "Article m3"])).toBe(true);

  // The first row, dropped below the middle of the second: between the second and third.
  await app.drag("id:headline-m1", { y: 50 });
  await app.waitUntil(() => patches.length === 1);
  const key = (d: string) => -Date.parse(at(d));
  expect(patches[0]).toEqual(["m1", { sort: (key("2") + key("1")) / 2 }]);

  // Sorted by date, nothing is dragged.
  await app.press("id:sort-button");
  await app.chooseMenuItem("By date ↓");
  await app.drag("id:headline-m3", { y: -90 });
  expect(patches.length).toBe(1);
});

test("desktop: the search box suggests conditions, their values, and recent searches", async () => {
  const searches: string[] = [];
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      ...readable,
      [`GET ${S}/v1/search*`]: (r: { url: string }) => {
        const q = new URL(r.url).searchParams.get("q") ?? "";
        searches.push(q);
        const hit = q.includes("#rust") ? [{ bookmark: library.bookmarks[0], snippet: null }] : [];
        return { body: { hits: hit, estimatedTotal: hit.length } };
      },
    },
  });
  await app.waitFor("text:Article a");

  // Nothing typed: the conditions that narrow the list, with how many each leaves.
  await app.type("id:search", "");
  await app.waitFor("id:search-suggestions");
  expect(app.texts()).toContain("Suggested");
  expect(app.shows("label:Tag, 1")).toBe(true); // one tag: rust
  expect(app.shows("label:Without tags, 2")).toBe(true);
  expect(app.texts()).toContain(
    "Put - (dash) in front of a condition you want to exclude from search",
  );

  // Tag puts in `#` and lists the tags; picking one searches.
  await app.press("id:suggest-tag");
  expect(app.value("id:search")).toBe("#");
  await app.waitFor("id:suggest-tag:rust");
  expect(app.texts()).toContain("Narrow your search");
  await app.press("id:suggest-tag:rust");
  expect(app.value("id:search")).toBe("#rust ");
  await app.waitFor("text:1 bookmark found");
  expect(searches).toEqual(["#rust"]);
  expect(app.shows("id:search-suggestions")).toBe(false);
  expect(app.storage()["search.recent.v1"]).toContain('"query":"#rust"');

  // A word searches as it's typed, and names collections and tags.
  await app.clear("id:search");
  await app.waitFor("text:All bookmarks");
  await app.type("id:search", "home");
  await app.waitFor("id:suggest-submit");
  expect(app.texts()).toContain('Search "home"');
  expect(app.shows("id:suggest-collection:c1")).toBe(true);
  await app.waitFor("text:0 bookmarks found");
  expect(app.shows("id:search-suggestions")).toBe(true);
  // Return searches for it once more only if it changed, and remembers it.
  await app.press("id:suggest-submit");
  expect(app.storage()["search.recent.v1"]).toContain('"query":"home"');
  expect(searches.filter((q) => q === "home")).toEqual(["home"]);
  // A condition being typed waits for its value; a space applies it.
  await app.clear("id:search");
  await app.waitFor("text:All bookmarks");
  const before = searches.length;
  await app.type("id:search", "#ru");
  await app.waitFor("id:suggest-tag:rust");
  await app.wait(400); // past the search's 180 ms debounce
  expect(searches.length).toBe(before);
  await app.type("id:search", "st ");
  await app.waitFor("text:1 bookmark found");
  expect(searches.at(-1)).toBe("#rust");
  await app.clear("id:search");
  await app.waitFor("text:All bookmarks");
  await app.type("id:search", "home");
  // The results redraw the panel: wait for them before picking a row.
  await app.waitFor("text:0 bookmarks found");
  await app.press("id:suggest-collection:c1");
  await app.waitFor("text:Homelab");
  expect(app.value("id:search")).toBe("");

  // The recent search comes back, and runs again.
  await app.type("id:search", "");
  await app.waitFor("id:suggest-recent:#rust");
  await app.press("id:suggest-recent:#rust");
  await app.waitFor("text:1 bookmark found");
  expect(searches.at(-1)).toBe("#rust");
});

test("desktop: the filter button narrows what the search found", async () => {
  const app = await open("./App.tsx", { ...desktop, network: readable });
  await app.waitFor("text:Article a");
  await app.press("id:search-filters");
  await app.waitFor("id:search-suggestions");
  expect(app.texts()).toContain("Narrow your search");
  // Only what would leave something: no notes here, and words aren't typed.
  expect(app.shows("id:suggest-note")).toBe(false);
  expect(app.shows("id:suggest-info")).toBe(false);
  await app.press("id:suggest-type");
  expect(app.value("id:search")).toBe("type:");
  await app.waitFor("id:suggest-type:article");
});

test("a server whose database was replaced is synced again from the start", async () => {
  const sinces: string[] = [];
  let generation = "g1";
  const app = await open("./App.tsx", {
    ...desktop,
    network: {
      [`GET ${S}/v1/sync*`]: (r) => {
        sinces.push(new URL(r.url).searchParams.get("since") ?? "");
        if (generation === "g1") return { body: { ...library, generation } };
        // A backup restored: an older library, its seqs behind the cursor the app holds.
        const bookmarks = library.bookmarks.filter((b) => b.id !== "bb");
        return { body: { ...library, cursor: 3, bookmarks, generation } };
      },
    },
  });
  await app.waitFor("text:Article bb");
  await app.waitFor("text:Up to date");
  expect(sinces[0]).toBe("0");
  expect(sinces.slice(1).every((s) => s === "9")).toBe(true);
  const before = sinces.length;
  generation = "g2";
  await app.press("id:sync");
  await app.waitUntil(() => !app.shows("text:Article bb"));
  // The page from the old cursor is dropped, and the library pulled from 0.
  expect(sinces.slice(before, before + 2)).toEqual(["9", "0"]);
  expect(app.shows("text:Article a")).toBe(true);
  // The same database again: on from its cursor.
  await app.waitFor("text:Up to date");
  const after = sinces.length;
  await app.press("id:sync");
  await app.waitUntil(() => sinces.length > after);
  expect(sinces[after]).toBe("3");
});
