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
    storage: { ...saved.storage, "library.v2": snapshot("http://127.0.0.1:8787") },
    network: { [`GET ${S}/v1/sync*`]: { body: library } },
  });
  await other.waitFor("text:Article a");
  expect(other.shows("text:Elsewhere")).toBe(false);
  expect(other.shows("text:Article zzz")).toBe(false);

  // This server's own snapshot shows, and the sync only catches up.
  const same = await open("./App.tsx", {
    ...desktop,
    storage: { ...saved.storage, "library.v2": snapshot(S) },
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
  const app = await open("./App.tsx", { ...saved, network: editable(log) });
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
  expect(log.patches).toEqual([["bb", { archived: true }]]);
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
  expect(log.patches).toEqual([["bb", { archived: true }]]);
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
  expect(log.patches).toEqual([["bb", { collectionId: "c1", archived: false }]]);
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
  expect(log.patches[0]).toEqual(["bb", { collectionId: "c1", archived: false }]);

  await app.rightClick("id:card-a");
  await app.chooseMenuItem("Delete");
  await app.waitUntil(() => log.patches.length === 2);
  expect(log.patches[1]).toEqual(["a", { archived: true }]);
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
  await app.waitFor("id:open-in-browser");
  await app.press("id:open-in-browser");
  expect(app.storage()["prefs.v1"]).toContain('"openIn":"browser"');
  await app.press("text:Cancel");
  await app.press("text:Article a");
  expect(app.openedUrls()).toEqual(["https://example.com/a"]);
  expect(app.shows("id:article")).toBe(false);
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
  expect(log.patches).toEqual([["a", { archived: true }]]);
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
        body: [{ id: "h1", bookmarkId: "a", quote: "words that are gone", prefix: "", suffix: "" }],
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
