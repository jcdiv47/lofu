import { describe, expect, test } from "bun:test";
import { setupServer } from "./harness.ts";

const { sys, app, api, base, withSearch } = setupServer();

describe("auth", () => {
  test("rejects missing and bad tokens", async () => {
    expect((await app.request("/v1/bookmarks")).status).toBe(401);
    expect(
      (await api("GET", "/v1/bookmarks", undefined, { authorization: "Bearer nope" })).status,
    ).toBe(401);
  });
  test("health and openapi are public", async () => {
    expect((await app.request("/health")).status).toBe(200);
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    expect(doc.paths["/v1/bookmarks"]).toBeDefined();
  });
});

describe("bookmarks", () => {
  let id: string;

  test("save fetches and extracts the page off-thread", async () => {
    const r = await api("POST", "/v1/bookmarks", {
      url: `${base}/article?utm_source=x`,
      tags: ["Baking"],
    });
    expect(r.status).toBe(201);
    expect(r.data.contentStatus).toBe("pending");
    expect(r.data.tags).toEqual(["baking"]);
    id = r.data.id;

    await sys.runner.idle();
    const b = await api("GET", `/v1/bookmarks/${id}?content=markdown`);
    expect(b.data.contentStatus).toBe("ok");
    expect(b.data.title).toBe("Sourdough Science");
    expect(b.data.type).toBe("article");
    expect(b.data.author).toBe("Ada Baker");
    expect(b.data.coverUrl).toBe("https://example.com/cover.jpg");
    expect(b.data.coverProxy).toBe(sys.ctx.images.path("https://example.com/cover.jpg"));
    expect(b.data.content).toContain("zymurgy");
    expect(b.data.content).not.toContain("Privacy");
  });

  test("re-saving the same page is idempotent and merges tags", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/article#top`, tags: ["science"] });
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(id);
    expect(r.data.tags).toEqual(["baking", "science"]);
  });

  test("content endpoint passes stored zstd through untouched", async () => {
    const z = await api("GET", `/v1/bookmarks/${id}/content?format=markdown`, undefined, {
      "accept-encoding": "zstd",
    });
    expect(z.res.headers.get("content-encoding")).toBe("zstd");
    const plain = await api("GET", `/v1/bookmarks/${id}/content?format=text`, undefined, {
      "accept-encoding": "identity",
    });
    expect(plain.data).toContain("zymurgy");
  });

  test("user-set title survives extraction; html payload skips fetching", async () => {
    const r = await api("POST", "/v1/bookmarks", {
      url: "https://unreachable.invalid/private-page",
      title: "My title",
      html: "<html><head><title>Server title</title></head><body><article><p>Members-only text about quokkas, the small marsupials of Rottnest Island.</p></article></body></html>",
    });
    await sys.runner.idle();
    const b = await api("GET", `/v1/bookmarks/${r.data.id}?content=text`);
    expect(b.data.content).toContain("quokkas");
    expect(b.data.contentStatus).toBe("ok");
    expect(b.data.title).toBe("My title");
  });

  test("decodes legacy charsets", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/gbk` });
    await sys.runner.idle();
    expect((await api("GET", `/v1/bookmarks/${r.data.id}`)).data.title).toBe("你好世界");
  });

  test("PDFs get full text via poppler; images are typed and skipped; 404 fails", async () => {
    const pdf = await api("POST", "/v1/bookmarks", { url: `${base}/paper.pdf` });
    const img = await api("POST", "/v1/bookmarks", { url: `${base}/image.png` });
    const missing = await api("POST", "/v1/bookmarks", { url: `${base}/gone` });
    await sys.runner.idle();
    const p = (await api("GET", `/v1/bookmarks/${pdf.data.id}?content=text`)).data;
    expect([p.contentStatus, p.type, p.title]).toEqual(["ok", "document", "Quokka Dynamics"]);
    expect(p.content).toContain("photogenic grin");
    const i = (await api("GET", `/v1/bookmarks/${img.data.id}`)).data;
    expect([i.contentStatus, i.type, i.title]).toEqual(["skipped", "image", "image.png"]);
    const m = (await api("GET", `/v1/bookmarks/${missing.data.id}`)).data;
    expect([m.contentStatus, m.contentError]).toEqual(["failed", "HTTP 404"]);
  });

  test("corrupt PDFs, 403s and JavaScript-only pages fail with a reason", async () => {
    const ids = await Promise.all(
      ["broken.pdf", "forbidden", "js-app"].map(
        async (p) => (await api("POST", "/v1/bookmarks", { url: `${base}/${p}` })).data.id,
      ),
    );
    await sys.runner.idle();
    const [broken, forbidden, js] = await Promise.all(
      ids.map(async (id) => (await api("GET", `/v1/bookmarks/${id}`)).data),
    );
    expect([broken.contentStatus, broken.contentError]).toEqual([
      "failed",
      expect.stringContaining("PDF"),
    ]);
    expect([forbidden.contentStatus, forbidden.contentError]).toEqual([
      "failed",
      "blocked by site (HTTP 403)",
    ]);
    // Metadata survives even though the body was empty.
    expect([js.contentStatus, js.title]).toEqual(["failed", "A post title"]);
    expect(js.contentError).toContain("JavaScript");
  });

  test("captcha pages are not stored as content; the job retries later", async () => {
    // A different host name for the same fixture server: the captcha penalizes
    // (slows down) its host, which must not slow the other tests.
    const r = await api("POST", "/v1/bookmarks", {
      url: `${base.replace("localhost", "127.0.0.1")}/captcha`,
    });
    await sys.runner.idle();
    expect((await api("GET", `/v1/bookmarks/${r.data.id}`)).data.contentStatus).toBe("pending");
    const job = sys.ctx.db
      .query<{ last_error: string }, [string]>("SELECT last_error FROM jobs WHERE bookmark_id = ?")
      .get(r.data.id);
    expect(job?.last_error).toBe("blocked by site: WeChat verification page");
  });

  test("markdown files are stored as content", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/notes.md` });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}?content=markdown`)).data;
    expect([b.contentStatus, b.type, b.title]).toEqual(["ok", "document", "notes.md"]);
    expect(b.content).toContain("axolotls");
  });

  test("lookup finds a bookmark by any variant of its URL", async () => {
    const r = await api(
      "GET",
      `/v1/bookmarks/lookup?url=${encodeURIComponent(`${base}/article?utm_medium=x#frag`)}`,
    );
    expect([r.status, r.data.id]).toEqual([200, id]);
    const miss = await api(
      "GET",
      `/v1/bookmarks/lookup?url=${encodeURIComponent(`${base}/never-saved`)}`,
    );
    expect(miss.status).toBe(404);
  });

  test("gzip-compressed uploads are accepted", async () => {
    const body = JSON.stringify({
      url: "https://unreachable.invalid/gzipped",
      html: `<html><head><title>Zipped</title></head><body><article><p>${"Compressed upload about narwhals and their tusks. ".repeat(20)}</p></article></body></html>`,
    });
    const res = await sys.app.request("/v1/bookmarks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sys.token}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: Bun.gzipSync(body),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${created.id}?content=text`)).data;
    expect([b.contentStatus, b.title]).toEqual(["ok", "Zipped"]);
    expect(b.content).toContain("narwhals");
  });

  test("list filters by content status", async () => {
    const failed = await api("GET", "/v1/bookmarks?contentStatus=failed&limit=100");
    expect(failed.data.items.length).toBeGreaterThan(0);
    expect(failed.data.items.every((b: any) => b.contentStatus === "failed")).toBe(true);
  });

  test("list filters by tags and paginates with a cursor", async () => {
    const tagged = await api("GET", "/v1/bookmarks?tags=baking,science");
    expect(tagged.data.items.map((b: any) => b.id)).toEqual([id]);
    const p1 = await api("GET", "/v1/bookmarks?limit=2");
    expect(p1.data.items).toHaveLength(2);
    const p2 = await api("GET", `/v1/bookmarks?limit=2&cursor=${p1.data.nextCursor}`);
    const ids = [...p1.data.items, ...p2.data.items].map((b: any) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every bookmark carries its cover's proxy path", async () => {
    const proxy = sys.ctx.images.path("https://example.com/cover.jpg");
    expect(proxy).toMatch(/^\/img\/[\w-]{22}\?u=https%3A%2F%2Fexample\.com%2Fcover\.jpg$/);
    const listed = (await api("GET", "/v1/bookmarks?limit=500")).data.items;
    expect(listed.find((b: any) => b.id === id).coverProxy).toBe(proxy);
    const synced = (await api("GET", "/v1/sync?since=0&limit=5000")).data.bookmarks;
    expect(synced.find((b: any) => b.id === id).coverProxy).toBe(proxy);
    expect((await api("POST", "/v1/bookmarks", { url: `${base}/article` })).data.coverProxy).toBe(
      proxy,
    );

    // Old rows may hold a cover relative to the page; it's resolved against the page URL.
    const page = (await api("POST", "/v1/bookmarks", { url: `${base}/covers/post` })).data;
    expect(page.coverProxy).toBeNull();
    const rel = await api("PATCH", `/v1/bookmarks/${page.id}`, { coverUrl: "../img/c.png" });
    expect(rel.data.coverUrl).toBe("../img/c.png");
    expect(rel.data.coverProxy).toBe(sys.ctx.images.path(`${base}/img/c.png`));
    const pr = await api("PATCH", `/v1/bookmarks/${page.id}`, { coverUrl: "//cdn.test/c.png" });
    expect(pr.data.coverProxy).toBe(sys.ctx.images.path("http://cdn.test/c.png"));
    for (const coverUrl of ["data:image/png;base64,iVBOR", null]) {
      const r = await api("PATCH", `/v1/bookmarks/${page.id}`, { coverUrl });
      expect(r.data.coverProxy).toBeNull();
    }
  });

  test("validation errors are 400", async () => {
    expect((await api("POST", "/v1/bookmarks", { url: "javascript:alert(1)" })).status).toBe(400);
    expect(
      (await api("POST", "/v1/bookmarks", { url: `${base}/x`, collectionId: "nope" })).status,
    ).toBe(409);
  });

  test("highlights round-trip", async () => {
    const h = await api("POST", `/v1/bookmarks/${id}/highlights`, {
      quote: "fermentation curves",
      prefix: "sourdough starters, ",
      suffix: " and crumb",
      note: "key idea",
    });
    expect(h.status).toBe(201);
    const list = await api("GET", `/v1/bookmarks/${id}/highlights`);
    expect(list.data).toHaveLength(1);
  });
});

describe.if(withSearch)("search", () => {
  test("finds content, notes and highlights; snippet is highlighted", async () => {
    await sys.indexer!.flush();
    const r = await api("GET", "/v1/search?q=zymurgy");
    expect(r.status).toBe(200);
    expect(r.data.hits[0].bookmark.title).toBe("Sourdough Science");
    expect(r.data.hits[0].bookmark.coverProxy).toStartWith("/img/");
    expect(r.data.hits[0].snippet).toContain("<mark>");
    const byHighlight = await api("GET", "/v1/search?q=key%20idea");
    expect(byHighlight.data.hits.length).toBeGreaterThan(0);
    const filtered = await api("GET", "/v1/search?q=zymurgy&tags=nonexistent");
    expect(filtered.data.hits).toHaveLength(0);
  });
});

describe("tags", () => {
  const tagsOf = async (ids: string[]) =>
    Promise.all(ids.map(async (id) => (await api("GET", `/v1/bookmarks/${id}`)).data.tags));
  const counts = async () =>
    Object.fromEntries(
      (await api("GET", "/v1/tags")).data.map((t: any) => [t.name, t.count]),
    ) as Record<string, number>;
  let ids: string[];

  test("rename merges into an existing tag without duplicates, and bumps seq", async () => {
    ids = await Promise.all(
      [["Old-Name", "keep"], ["old-name", "new-name"], ["new-name"]].map(
        async (tags, i) =>
          (await api("POST", "/v1/bookmarks", { url: `${base}/tags/${i}`, tags })).data.id,
      ),
    );
    await sys.runner.idle();
    const cursor = (await api("GET", "/v1/sync?since=0&limit=5000")).data.cursor;

    // Tag names are normalized like everywhere else: trimmed and lowercased.
    const r = await api("POST", "/v1/tags/rename", { from: " OLD-NAME ", to: "New-Name" });
    expect([r.status, r.data]).toEqual([200, { updated: 2 }]);
    expect(await tagsOf(ids)).toEqual([["new-name", "keep"], ["new-name"], ["new-name"]]);
    const c = await counts();
    expect([c["old-name"], c["new-name"], c.keep]).toEqual([undefined, 3, 1]);

    const delta = (await api("GET", `/v1/sync?since=${cursor}`)).data.bookmarks;
    expect(delta.map((b: any) => b.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(delta.every((b: any) => b.seq > cursor)).toBe(true);

    expect((await api("POST", "/v1/tags/rename", { from: "absent", to: "x" })).data).toEqual({
      updated: 0,
    });
    expect((await api("POST", "/v1/tags/rename", { from: "keep", to: "KEEP" })).data).toEqual({
      updated: 0,
    });
    expect((await api("POST", "/v1/tags/rename", { from: "keep", to: " " })).status).toBe(400);
    expect((await api("POST", "/v1/tags/rename", { from: "keep" })).status).toBe(400);
  });

  test("the search index follows a rename", async () => {
    if (!withSearch) return;
    await sys.indexer!.flush();
    const hits = (await api("GET", "/v1/search?q=&tags=new-name&snippets=false")).data.hits;
    expect(hits.map((h: any) => h.bookmark.id).sort()).toEqual([...ids].sort());
    expect((await api("GET", "/v1/search?q=&tags=old-name")).data.hits).toHaveLength(0);
  });

  test("delete removes a tag from every bookmark", async () => {
    await api("PATCH", `/v1/bookmarks/${ids[2]}`, { tags: ["new-name", "c++/rust"] });
    const cursor = (await api("GET", "/v1/sync?since=0&limit=5000")).data.cursor;
    const r = await api("DELETE", "/v1/tags/New-Name");
    expect([r.status, r.data]).toEqual([200, { updated: 3 }]);
    expect(await tagsOf(ids)).toEqual([["keep"], [], ["c++/rust"]]);
    const delta = (await api("GET", `/v1/sync?since=${cursor}`)).data.bookmarks;
    expect(delta).toHaveLength(3);

    // Any tag name, URL-encoded.
    const odd = await api("DELETE", `/v1/tags/${encodeURIComponent("c++/rust")}`);
    expect(odd.data).toEqual({ updated: 1 });
    expect((await api("DELETE", "/v1/tags/absent")).data).toEqual({ updated: 0 });
    expect((await counts())["c++/rust"]).toBeUndefined();
  });

  test("are in the OpenAPI document", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    expect(doc.paths["/v1/tags/rename"].post).toBeDefined();
    expect(doc.paths["/v1/tags/{name}"].delete).toBeDefined();
    const bookmark = doc.components.schemas.Bookmark.properties;
    expect(bookmark.archived.description).toContain("Trash");
    expect(bookmark.coverProxy).toBeDefined();
  });
});

describe("sync and deletes", () => {
  test("collections can be renamed and reordered", async () => {
    const col = await api("POST", "/v1/collections", { name: "Drafts", sort: 1 });
    const r = await api("PATCH", `/v1/collections/${col.data.id}`, { name: "Ideas", sort: 2.5 });
    expect([r.status, r.data.name, r.data.sort]).toEqual([200, "Ideas", 2.5]);
    expect(r.data.seq).toBeGreaterThan(col.data.seq);
  });

  test("collections delete moves bookmarks to unsorted and leaves a tombstone", async () => {
    const col = await api("POST", "/v1/collections", { name: "Read later" });
    const b = await api("POST", "/v1/bookmarks", {
      url: `${base}/article-2`,
      collectionId: col.data.id,
    });
    expect(b.data.collectionId).toBe(col.data.id);
    await sys.runner.idle();
    const cursor = (await api("GET", "/v1/sync?since=0&limit=5000")).data.cursor;
    expect((await api("DELETE", `/v1/collections/${col.data.id}`)).status).toBe(204);
    expect((await api("GET", `/v1/bookmarks/${b.data.id}`)).data.collectionId).toBeNull();
    expect((await api("GET", "/v1/collections")).data.map((c: any) => c.id)).not.toContain(
      col.data.id,
    );
    const delta = (await api("GET", `/v1/sync?since=${cursor}`)).data;
    expect(delta.bookmarks.map((x: any) => [x.id, x.collectionId])).toEqual([[b.data.id, null]]);
    expect(delta.collections.map((x: any) => [x.id, Boolean(x.deletedAt)])).toEqual([
      [col.data.id, true],
    ]);
  });

  test("delta sync returns changes after a cursor, including tombstones", async () => {
    const all = await api("GET", "/v1/sync?since=0");
    const cursor = all.data.cursor;
    const victim = all.data.bookmarks.find((b: any) => !b.deletedAt);
    expect((await api("DELETE", `/v1/bookmarks/${victim.id}`)).status).toBe(204);
    expect((await api("GET", `/v1/bookmarks/${victim.id}`)).status).toBe(404);
    const delta = await api("GET", `/v1/sync?since=${cursor}`);
    expect(delta.data.bookmarks.map((b: any) => [b.id, Boolean(b.deletedAt)])).toEqual([
      [victim.id, true],
    ]);
    expect((await api("GET", `/v1/sync?since=${delta.data.cursor}`)).data.bookmarks).toHaveLength(
      0,
    );
  });

  test("sync pages never split and report hasMore", async () => {
    const page = await api("GET", "/v1/sync?since=0&limit=2");
    expect(page.data.hasMore).toBe(true);
    const n =
      page.data.bookmarks.length + page.data.collections.length + page.data.highlights.length;
    expect(n).toBe(2);
  });

  test("re-saving a deleted URL revives the same id", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/gone2` });
    await api("DELETE", `/v1/bookmarks/${r.data.id}`);
    const again = await api("POST", "/v1/bookmarks", { url: `${base}/gone2` });
    expect([again.status, again.data.id]).toEqual([201, r.data.id]);
  });
});

describe("cors", () => {
  test("extension origins may call the API; web pages may not", async () => {
    const pre = (origin: string) =>
      app.request("/v1/bookmarks", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization",
        },
      });
    const ext = await pre("chrome-extension://abcdefghijklmnop");
    expect(ext.headers.get("access-control-allow-origin")).toBe(
      "chrome-extension://abcdefghijklmnop",
    );
    expect(
      (await pre("moz-extension://1234-uuid")).headers.get("access-control-allow-origin"),
    ).toBe("moz-extension://1234-uuid");
    expect(
      (await pre("https://evil.example")).headers.get("access-control-allow-origin"),
    ).toBeNull();
    sys.ctx.config.corsOrigins.push("http://127.0.0.1:8790");
    expect((await pre("http://127.0.0.1:8790")).headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:8790",
    );
  });
});
