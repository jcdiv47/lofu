import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { Meili } from "../src/search/meili.ts";
import { Searcher } from "../src/search/search.ts";
import { setupServer } from "./harness.ts";

/** Phase 1 fixes and Phase 2 additions to the /v1 API. */
const { sys, app, api, base, withSearch } = setupServer();

const html = (title: string, body: string, head = "") =>
  `<html><head><title>${title}</title>${head}</head><body><article>${body}</article></body></html>`;
const para = (words: string) =>
  `<p>${words} ${"Filler words that make the article long enough to be read as one. ".repeat(4)}</p>`;

/** Saves a page from HTML (nothing fetched) and waits for it to be read. */
async function saved(
  path: string,
  body = para("Plain text."),
  extra: Record<string, unknown> = {},
) {
  const r = await api("POST", "/v1/bookmarks?wait=true", {
    url: `${base}/v1test/${path}`,
    html: html(path, body),
    ...extra,
  });
  expect([200, 201]).toContain(r.status);
  return r.data;
}

const sync = async (since: number) => (await api("GET", `/v1/sync?since=${since}&limit=5000`)).data;
const cursorNow = async () => (await sync(0)).cursor as number;

describe("errors", () => {
  test("carry a stable code", async () => {
    const unauth = await app.request("/v1/bookmarks");
    expect([unauth.status, ((await unauth.json()) as any).code]).toEqual([401, "UNAUTHORIZED"]);
    const bad = await api("POST", "/v1/bookmarks", { url: "nope" });
    expect([bad.status, bad.data.code]).toEqual([400, "INVALID_REQUEST"]);
    expect(bad.data.details).toBeArray();
    const missing = await api("GET", "/v1/bookmarks/nope");
    expect([missing.status, missing.data.code]).toEqual([404, "NOT_FOUND"]);
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const res = await app.request("/v1/bookmarks", {
      method: "POST",
      headers: { authorization: `Bearer ${sys.token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("INVALID_REQUEST");
  });

  test("lookup rejects what isn't an http(s) URL with a 400", async () => {
    for (const url of ["ftp://example.com/x", "javascript:alert(1)", "not a url"]) {
      const r = await api("GET", `/v1/bookmarks/lookup?url=${encodeURIComponent(url)}`);
      expect([url, r.status, r.data.code]).toEqual([url, 400, "INVALID_REQUEST"]);
    }
  });

  test("lookup unwraps a wrapper link before comparing", async () => {
    // A wrapper only leads to a dotted host name.
    const b = (
      await api("POST", "/v1/bookmarks", {
        url: "https://wrapped.example/post?id=1",
        html: html("w", para("x")),
      })
    ).data;
    const wrapped = `https://link.zhihu.com/?target=${encodeURIComponent(b.url)}`;
    const r = await api("GET", `/v1/bookmarks/lookup?url=${encodeURIComponent(wrapped)}`);
    expect([r.status, r.data.id]).toEqual([200, b.id]);
  });
});

describe("bookmark integrity", () => {
  test("a collection must exist and be live, on create and on update", async () => {
    const col = (await api("POST", "/v1/collections", { name: "Doomed" })).data;
    await api("DELETE", `/v1/collections/${col.id}`);
    const create = await api("POST", "/v1/bookmarks", {
      url: `${base}/v1test/in-deleted`,
      collectionId: col.id,
    });
    expect([create.status, create.data.code]).toEqual([404, "NOT_FOUND"]);
    const b = await saved("update-into-deleted");
    const upd = await api("PATCH", `/v1/bookmarks/${b.id}`, { collectionId: col.id });
    expect(upd.status).toBe(404);
    expect((await api("PATCH", `/v1/bookmarks/${b.id}`, { collectionId: "nope" })).status).toBe(
      404,
    );
  });

  test("saving a bookmark in the Trash again takes it out, unless told otherwise", async () => {
    const b = await saved("trashed");
    await api("PATCH", `/v1/bookmarks/${b.id}`, { archived: true });
    const again = await api("POST", "/v1/bookmarks", { url: b.url });
    expect([again.status, again.data.archived]).toEqual([200, false]);
    await api("PATCH", `/v1/bookmarks/${b.id}`, { archived: true });
    const kept = await api("POST", "/v1/bookmarks", { url: b.url, archived: true });
    expect(kept.data.archived).toBe(true);
  });

  test("an empty title doesn't replace the title", async () => {
    const b = await saved("titled", para("Text."), { title: "Kept title" });
    for (const title of ["", "   "]) {
      const r = await api("POST", "/v1/bookmarks", { url: b.url, title });
      expect(r.data.title).toBe("Kept title");
    }
  });

  test("a cover can't be a script or overlong", async () => {
    const b = await saved("cover");
    for (const coverUrl of [
      "javascript:alert(1)",
      " JaVa\tScript:x",
      "vbscript:x",
      "x".repeat(5000),
    ]) {
      const r = await api("PATCH", `/v1/bookmarks/${b.id}`, { coverUrl });
      expect([r.status, r.data.code]).toEqual([400, "INVALID_REQUEST"]);
    }
    expect((await api("PATCH", `/v1/bookmarks/${b.id}`, { coverUrl: "../c.png" })).status).toBe(
      200,
    );
  });

  test("deleting a bookmark tombstones its highlights and cancels its jobs", async () => {
    const b = await saved("with-highlights");
    const h = await api("POST", `/v1/bookmarks/${b.id}/highlights`, { quote: "Plain text." });
    sys.ctx.db
      .query("INSERT INTO jobs (kind, bookmark_id, run_at) VALUES ('markdown', ?, ?)")
      .run(b.id, Date.now() + 3_600_000);
    const cursor = await cursorNow();
    expect((await api("DELETE", `/v1/bookmarks/${b.id}`)).status).toBe(204);
    const delta = await sync(cursor);
    expect(delta.highlights.map((x: any) => [x.id, Boolean(x.deletedAt)])).toEqual([
      [h.data.id, true],
    ]);
    expect(delta.highlights[0].seq).toBeGreaterThan(cursor);
    const jobs = sys.ctx.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM jobs WHERE bookmark_id = ?")
      .get(b.id);
    expect(jobs?.n).toBe(0);
    expect((await api("GET", `/v1/highlights/${h.data.id}`)).status).toBe(404);
  });

  test("a refetch that fails keeps the excerpt and cover", async () => {
    // Read from the HTML sent; the page itself answers 404.
    const r = await api("POST", "/v1/bookmarks?wait=true", {
      url: `${base}/gone/refetch-fails`,
      html: html("Saved", para("Body."), "<meta name='description' content='Kept excerpt'>"),
    });
    expect(r.data.excerpt).toBe("Kept excerpt");
    await api("PATCH", `/v1/bookmarks/${r.data.id}`, { coverUrl: "https://example.com/kept.png" });
    const after = await api("POST", `/v1/bookmarks/${r.data.id}/refetch?waitMs=10000`);
    expect([after.status, after.data.contentStatus]).toEqual([200, "failed"]);
    expect([after.data.excerpt, after.data.coverUrl, after.data.title]).toEqual([
      "Kept excerpt",
      "https://example.com/kept.png",
      "Saved",
    ]);
  });

  test("tag counts leave out the Trash unless asked", async () => {
    const b = await saved("trash-tag", para("x"), { tags: ["only-in-trash"] });
    const counts = async (q = "") =>
      Object.fromEntries(
        (await api("GET", `/v1/tags${q}`)).data.map((t: any) => [t.name, t.count]),
      );
    expect((await counts())["only-in-trash"]).toBe(1);
    await api("PATCH", `/v1/bookmarks/${b.id}`, { archived: true });
    expect((await counts())["only-in-trash"]).toBeUndefined();
    expect((await counts("?includeTrashed=true"))["only-in-trash"]).toBe(1);
  });

  test("deleting a collection leaves deleted bookmarks' seq alone", async () => {
    const col = (await api("POST", "/v1/collections", { name: "Mixed" })).data;
    const live = await saved("col-live", para("x"), { collectionId: col.id });
    const dead = await saved("col-dead", para("x"), { collectionId: col.id });
    await api("DELETE", `/v1/bookmarks/${dead.id}`);
    const cursor = await cursorNow();
    await api("DELETE", `/v1/collections/${col.id}`);
    expect((await sync(cursor)).bookmarks.map((b: any) => b.id)).toEqual([live.id]);
    // Saved again, the tombstone doesn't come back in the deleted collection.
    const revived = await api("POST", "/v1/bookmarks", { url: dead.url });
    expect([revived.status, revived.data.collectionId]).toEqual([201, null]);
  });
});

describe("hardening", () => {
  test("the image proxy rejects odd widths with JSON", async () => {
    const path = sys.ctx.images.path("https://example.com/a.png")!;
    for (const w of ["abc", "1.5", "NaN", "0", "123"]) {
      const res = await app.request(`${path}&w=${w}`);
      expect([w, res.status]).toEqual([w, 400]);
      expect(((await res.json()) as any).error).toBe("unsupported width");
    }
    const forged = await app.request("/img/forged?u=https%3A%2F%2Fexample.com%2Fa.png");
    expect([forged.status, ((await forged.json()) as any).error]).toEqual([403, "bad signature"]);
  });

  test("a compressed upload that decodes too large is a 413", async () => {
    const bomb = Bun.gzipSync(new Uint8Array(33 * 1024 * 1024));
    const res = await app.request("/v1/bookmarks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sys.token}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: bomb,
    });
    expect([res.status, ((await res.json()) as any).code]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
  });

  test("an import over 50 MiB is a 413", async () => {
    const res = await app.request("/v1/import/raindrop", {
      method: "POST",
      headers: { authorization: `Bearer ${sys.token}`, "content-type": "text/csv" },
      body: new Uint8Array(51 * 1024 * 1024),
    });
    expect([res.status, ((await res.json()) as any).code]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
  });

  test("every operation has an id and tags; content and health are documented", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    const ids = new Set<string>();
    for (const [path, ops] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        expect([path, method, typeof op.operationId]).toEqual([path, method, "string"]);
        expect(op.tags?.length).toBeGreaterThan(0);
        expect(ids.has(op.operationId)).toBe(false);
        ids.add(op.operationId);
      }
    }
    expect(doc.paths["/v1/bookmarks/{id}/content"].get.responses["304"]).toBeDefined();
    expect(doc.paths["/health"].get).toBeDefined();
    expect(doc.components.schemas.ApiError.properties.code).toBeDefined();
  });
});

describe("bookmark updates", () => {
  test("addTags and removeTags change the tags it has", async () => {
    const b = await saved("tag-edits", para("x"), { tags: ["a", "b"] });
    const r = await api("PATCH", `/v1/bookmarks/${b.id}`, {
      addTags: ["C", "a"],
      removeTags: ["b"],
    });
    expect(r.data.tags).toEqual(["a", "c"]);
    const both = await api("PATCH", `/v1/bookmarks/${b.id}`, { tags: ["x"], addTags: ["y"] });
    expect([both.status, both.data.code]).toEqual([400, "INVALID_REQUEST"]);
  });

  test("expectedSeq and If-Match refuse a stale update", async () => {
    const b = await saved("seq-check");
    const stale = await api("PATCH", `/v1/bookmarks/${b.id}`, {
      note: "x",
      expectedSeq: b.seq - 1,
    });
    expect([stale.status, stale.data.code, stale.data.details.seq]).toEqual([
      409,
      "SEQ_CONFLICT",
      b.seq,
    ]);
    const ok = await api("PATCH", `/v1/bookmarks/${b.id}`, { note: "x", expectedSeq: b.seq });
    expect([ok.status, ok.data.note]).toEqual([200, "x"]);
    const header = await api(
      "PATCH",
      `/v1/bookmarks/${b.id}`,
      { note: "y" },
      { "if-match": `"${b.seq}"` },
    );
    expect(header.status).toBe(409);
    const fresh = await api(
      "PATCH",
      `/v1/bookmarks/${b.id}`,
      { note: "y" },
      { "if-match": `"${ok.data.seq}"` },
    );
    expect(fresh.data.note).toBe("y");
    expect(
      (await api("PATCH", `/v1/bookmarks/${b.id}`, { note: "z" }, { "if-match": "nope" })).status,
    ).toBe(400);
  });

  test("batch patches many in one go, each with its own seq", async () => {
    const [a, b] = [await saved("batch-a"), await saved("batch-b")];
    const r = await api("POST", "/v1/bookmarks/batch", {
      ids: [a.id, b.id, "missing-id", a.id],
      patch: { favorite: true, addTags: ["batched"] },
    });
    expect(r.data).toEqual({ updated: 2, deleted: 0, missingIds: ["missing-id"] });
    const [na, nb] = await Promise.all(
      [a, b].map(async (x) => (await api("GET", `/v1/bookmarks/${x.id}`)).data),
    );
    expect([na.favorite, nb.favorite, na.tags, nb.tags]).toEqual([
      true,
      true,
      ["batched"],
      ["batched"],
    ]);
    expect(na.seq).not.toBe(nb.seq);
    expect((await api("POST", "/v1/bookmarks/batch", { ids: [a.id] })).status).toBe(400);
    expect(
      (
        await api("POST", "/v1/bookmarks/batch", {
          ids: [a.id],
          patch: { favorite: true },
          delete: true,
        })
      ).status,
    ).toBe(400);
    expect((await api("POST", "/v1/bookmarks/batch", { ids: [a.id], patch: {} })).status).toBe(400);
    expect(
      (
        await api("POST", "/v1/bookmarks/batch", {
          ids: [a.id],
          patch: { note: "x", expectedSeq: 1 },
        })
      ).status,
    ).toBe(400);
  });

  test("batch delete tombstones the bookmarks and their highlights", async () => {
    const a = await saved("batch-del-a");
    const h = await api("POST", `/v1/bookmarks/${a.id}/highlights`, { quote: "Plain" });
    const cursor = await cursorNow();
    const r = await api("POST", "/v1/bookmarks/batch", { ids: [a.id, "gone"], delete: true });
    expect(r.data).toEqual({ updated: 0, deleted: 1, missingIds: ["gone"] });
    const delta = await sync(cursor);
    expect(delta.bookmarks.map((x: any) => [x.id, Boolean(x.deletedAt)])).toEqual([[a.id, true]]);
    expect(delta.highlights.map((x: any) => [x.id, Boolean(x.deletedAt)])).toEqual([
      [h.data.id, true],
    ]);
  });

  test("lookup of many URLs answers each", async () => {
    const b = await saved("lookup-many");
    const urls = [`${b.url}?utm_source=x`, `${base}/v1test/never`, "ftp://x/y", b.url];
    const r = await api("POST", "/v1/bookmarks/lookup", { urls });
    expect(r.status).toBe(200);
    expect(Object.keys(r.data.items)).toEqual(urls);
    expect(urls.map((u) => r.data.items[u]?.id ?? null)).toEqual([b.id, null, null, b.id]);
    expect((await api("POST", "/v1/bookmarks/lookup", { urls: [] })).status).toBe(400);
  });
});

describe("highlights", () => {
  let bm: any;
  let made: any[];

  test("a client's id makes creating idempotent", async () => {
    bm = await saved("hl-host", para("Quokkas smile."), { tags: ["hl-tag"] });
    const body = { id: "hl-client-1", quote: "Quokkas smile", note: "cute" };
    const first = await api("POST", `/v1/bookmarks/${bm.id}/highlights`, body);
    const again = await api("POST", `/v1/bookmarks/${bm.id}/highlights`, body);
    expect([first.status, again.status, again.data.id]).toEqual([201, 200, "hl-client-1"]);
    expect((await api("GET", `/v1/bookmarks/${bm.id}/highlights`)).data).toHaveLength(1);
    const other = await saved("hl-other");
    const clash = await api("POST", `/v1/bookmarks/${other.id}/highlights`, body);
    expect([clash.status, clash.data.code]).toEqual([409, "CONFLICT"]);
    made = [first.data];
    for (const [quote, color] of [
      ["Filler words", "yellow"],
      ["long enough", "blue"],
    ]) {
      made.push((await api("POST", `/v1/bookmarks/${bm.id}/highlights`, { quote, color })).data);
    }
  });

  test("list across the library, newest first, filtered and paged", async () => {
    const list = async (q: string) =>
      (await api("GET", `/v1/highlights?bookmarkId=${bm.id}&${q}`)).data;
    const all = await list("");
    expect(all.items.map((h: any) => h.id)).toEqual(made.map((h) => h.id).reverse());
    expect(all.items[0]).toMatchObject({
      bookmarkTitle: bm.title,
      bookmarkUrl: bm.url,
      bookmarkDomain: bm.domain,
    });
    expect((await list("color=blue")).items.map((h: any) => h.quote)).toEqual(["long enough"]);
    expect((await list("hasNote=true")).items.map((h: any) => h.id)).toEqual(["hl-client-1"]);
    expect((await list("q=CUTE")).items.map((h: any) => h.id)).toEqual(["hl-client-1"]);
    expect((await list("q=filler")).items).toHaveLength(1);
    const byTag = (await api("GET", "/v1/highlights?tag=hl-tag")).data.items;
    expect(byTag).toHaveLength(3);
    const p1 = await list("limit=2");
    const p2 = await list(`limit=2&cursor=${p1.nextCursor}`);
    expect([p1.items.length, p2.items.length, p2.nextCursor]).toEqual([2, 1, null]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await list(`createdAfter=${future}`)).items).toHaveLength(0);
    expect((await list(`createdBefore=${future}`)).items).toHaveLength(3);
  });

  test("get one; those of a bookmark in the Trash can be left out", async () => {
    const one = await api("GET", `/v1/highlights/${made[1].id}`);
    expect([one.status, one.data.quote]).toEqual([200, "Filler words"]);
    await api("PATCH", `/v1/bookmarks/${bm.id}`, { archived: true });
    expect(
      (await api("GET", `/v1/highlights?bookmarkId=${bm.id}&archived=false`)).data.items,
    ).toHaveLength(0);
    expect((await api("GET", `/v1/highlights?bookmarkId=${bm.id}`)).data.items).toHaveLength(3);
    await api("PATCH", `/v1/bookmarks/${bm.id}`, { archived: false });
  });
});

describe("collections, stats, capabilities", () => {
  test("collections carry their bookmark count", async () => {
    const col = (await api("POST", "/v1/collections", { name: "Counted" })).data;
    await saved("counted-1", para("x"), { collectionId: col.id });
    const t = await saved("counted-2", para("x"), { collectionId: col.id });
    await api("PATCH", `/v1/bookmarks/${t.id}`, { archived: true });
    const one = await api("GET", `/v1/collections/${col.id}`);
    expect([one.status, one.data.name, one.data.bookmarkCount]).toEqual([200, "Counted", 1]);
    const listed = (await api("GET", "/v1/collections")).data.find((c: any) => c.id === col.id);
    expect(listed.bookmarkCount).toBe(1);
    expect((await api("GET", "/v1/collections/nope")).status).toBe(404);
  });

  test("stats count the library", async () => {
    const s = (await api("GET", "/v1/stats")).data;
    const all = (await api("GET", "/v1/bookmarks?limit=500")).data.items;
    const active = all.filter((b: any) => !b.archived);
    expect(s.bookmarks.total).toBe(all.length);
    expect(s.bookmarks.active).toBe(active.length);
    expect(s.bookmarks.trashed).toBe(all.length - active.length);
    expect(s.bookmarks.favorites).toBe(active.filter((b: any) => b.favorite).length);
    expect(s.bookmarks.unsorted).toBe(active.filter((b: any) => !b.collectionId).length);
    const byType = Object.values<number>(s.bookmarks.byType).reduce((a, b) => a + b, 0);
    expect(byType).toBe(active.length);
    expect(s.bookmarks.withHighlights).toBeGreaterThan(0);
    expect(s.highlights).toBeGreaterThanOrEqual(3);
    expect(s.collections).toBe((await api("GET", "/v1/collections")).data.length);
    expect(s.tags).toBe((await api("GET", "/v1/tags")).data.length);
  });

  test("capabilities say what the server and the token can do", async () => {
    const c = (await api("GET", "/v1/capabilities")).data;
    expect(c).toMatchObject({
      version: expect.any(String),
      search: withSearch ? "meilisearch" : "sqlite",
      browserExtraction: false,
      scopes: ["read", "write", "delete", "admin"],
    });
    expect(typeof c.pdfExtraction).toBe("boolean");
  });
});

describe("content", () => {
  let b: any;
  const body =
    "<h2>First part</h2>" +
    para("Alpha section.") +
    "<h2>Second part</h2>" +
    para("Beta section.") +
    '<p><img src="https://example.com/p.png" alt="pic"></p>';

  test("extractedAt is set once read", async () => {
    b = await saved("content", body);
    expect(b.contentStatus).toBe("ok");
    expect(Date.parse(b.extractedAt)).toBeGreaterThan(0);
  });

  test("include picks what comes along; Markdown alone still gets its media", async () => {
    const get = async (q: string) => (await api("GET", `/v1/bookmarks/${b.id}?${q}`)).data;
    const legacy = await get("content=markdown");
    expect(legacy.images).toBeArray();
    expect(legacy.images.map((i: any) => i.src)).toContain("https://example.com/p.png");
    expect(legacy.formulas).toBeArray();
    expect(legacy.highlightCount).toBe(0);
    expect(legacy.highlights).toBeUndefined();
    const none = await get("content=markdown&include=none");
    expect([none.images, none.formulas, typeof none.content]).toEqual([null, null, "string"]);
    await api("POST", `/v1/bookmarks/${b.id}/highlights`, { quote: "Alpha" });
    const hl = await get("content=markdown&include=highlights");
    expect([hl.images, hl.highlightCount, hl.highlights.length]).toEqual([null, 1, 1]);
    const both = await get("content=markdown&include=media,highlights");
    expect([Array.isArray(both.images), both.highlights.length]).toEqual([true, 1]);
    expect((await get("include=bogus")).code).toBe("INVALID_REQUEST");
  });

  test("content comes in slices, with Markdown's headings", async () => {
    const whole = (await api("GET", `/v1/bookmarks/${b.id}?content=markdown&include=none`)).data
      .content;
    const s = (
      await api(
        "GET",
        `/v1/bookmarks/${b.id}?content=markdown&include=none&contentOffset=5&contentMaxChars=20`,
      )
    ).data;
    expect([s.content, s.contentOffset, s.contentTotalChars, s.contentHasMore]).toEqual([
      whole.slice(5, 25),
      5,
      whole.length,
      true,
    ]);
    expect(s.headings.map((h: any) => [h.level, h.text])).toEqual([
      [2, "First part"],
      [2, "Second part"],
    ]);
    expect(whole.slice(s.headings[1].offset)).toStartWith("## Second part");
    const tail = (
      await api("GET", `/v1/bookmarks/${b.id}?content=text&contentOffset=${whole.length * 2}`)
    ).data;
    expect([tail.content, tail.contentHasMore, tail.headings]).toEqual(["", false, undefined]);
  });

  test("the content document has an ETag, answers If-None-Match, and slices", async () => {
    const first = await api("GET", `/v1/bookmarks/${b.id}/content?format=markdown`);
    const etag = first.res.headers.get("etag")!;
    expect(etag).toStartWith('W/"');
    const again = await api("GET", `/v1/bookmarks/${b.id}/content?format=markdown`, undefined, {
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    const other = await api("GET", `/v1/bookmarks/${b.id}/content?format=text`, undefined, {
      "if-none-match": etag,
    });
    expect(other.status).toBe(200);
    const zstd = await api("GET", `/v1/bookmarks/${b.id}/content?format=markdown`, undefined, {
      "accept-encoding": "zstd",
    });
    expect([zstd.res.headers.get("content-encoding"), zstd.res.headers.get("etag")]).toEqual([
      "zstd",
      etag,
    ]);
    const s = await api(
      "GET",
      `/v1/bookmarks/${b.id}/content?format=markdown&offset=3&maxChars=10`,
      undefined,
      { "accept-encoding": "zstd" },
    );
    expect(s.res.headers.get("content-encoding")).toBeNull();
    expect(s.data).toBe(first.data.slice(3, 13));
    expect([
      s.res.headers.get("x-content-total-chars"),
      s.res.headers.get("x-content-offset"),
      s.res.headers.get("x-content-has-more"),
    ]).toEqual([String(first.data.length), "3", "true"]);
    expect((await api("GET", `/v1/bookmarks/${b.id}/content?format=pdf`)).status).toBe(400);
    expect((await api("GET", `/v1/bookmarks/${b.id}/content?maxChars=0`)).status).toBe(400);
  });

  test("a refetch can be given the page's HTML, and waited for", async () => {
    const r = await api("POST", `/v1/bookmarks/${b.id}/refetch?waitMs=10000`, {
      html: html("Fresh title", para("Gamma section.")),
    });
    expect([r.status, r.data.contentStatus, r.data.title]).toEqual([200, "ok", "Fresh title"]);
    expect(Date.parse(r.data.extractedAt)).toBeGreaterThan(Date.parse(b.extractedAt));
    const text = (await api("GET", `/v1/bookmarks/${b.id}?content=text`)).data.content;
    expect(text).toContain("Gamma");
    // Without a body or a wait: queued, as before.
    const queued = await api("POST", `/v1/bookmarks/${b.id}/refetch`);
    expect([queued.status, queued.data.contentStatus]).toEqual([202, "pending"]);
    await sys.runner.idle();
  });

  test("no wait answers at once, still pending; waits are bounded", async () => {
    const r = await api("POST", "/v1/bookmarks?waitMs=0", {
      url: `${base}/v1test/no-wait`,
      html: html("x", para("x")),
    });
    expect([r.status, r.data.contentStatus]).toEqual([201, "pending"]);
    expect((await api("POST", "/v1/bookmarks?waitMs=20000", { url: `${base}/x` })).status).toBe(
      400,
    );
    await sys.runner.idle();
  });
});

describe("list filters", () => {
  let ids: { a: string; b: string; c: string };

  test("by ids, domain, note, highlights, tags and dates", async () => {
    const day = (d: number) => `2020-02-0${d}T12:00:00.000Z`;
    const mk = async (name: string, extra: Record<string, unknown>) =>
      (await saved(`filters/${name}`, para("x"), extra)).id as string;
    ids = {
      a: await mk("a", { createdAt: day(1), note: "has a note", tags: ["lf"] }),
      b: await mk("b", { createdAt: day(2) }),
      c: await mk("c", { createdAt: day(3), tags: ["lf"] }),
    };
    await api("POST", `/v1/bookmarks/${ids.b}/highlights`, { quote: "x" });
    const list = async (q: string) =>
      (await api("GET", `/v1/bookmarks?limit=500&${q}`)).data.items.map((b: any) => b.id);
    const mine = `ids=${[ids.a, ids.b, ids.c].join(",")}`;
    expect(await list(mine)).toEqual([ids.c, ids.b, ids.a]);
    expect(await list(`${mine}&hasNote=true`)).toEqual([ids.a]);
    expect(await list(`${mine}&hasNote=false`)).toEqual([ids.c, ids.b]);
    expect(await list(`${mine}&hasHighlights=true`)).toEqual([ids.b]);
    expect(await list(`${mine}&untagged=true`)).toEqual([ids.b]);
    expect(await list(`${mine}&untagged=false`)).toEqual([ids.c, ids.a]);
    expect(await list(`${mine}&createdAfter=${day(2)}&createdBefore=${day(3)}`)).toEqual([ids.b]);
    expect(await list(`${mine}&domain=${new URL(base).hostname}`)).toHaveLength(3);
    expect(await list(`${mine}&domain=elsewhere.test`)).toEqual([]);
    expect((await api("GET", "/v1/bookmarks?createdAfter=yesterday")).status).toBe(400);
  });

  test("sorts, each paging with its own cursor", async () => {
    const mine = `ids=${[ids.a, ids.b, ids.c].join(",")}`;
    const pages = async (sort: string) => {
      const out: string[] = [];
      let cursor = "";
      for (let i = 0; i < 5; i++) {
        const r = (await api("GET", `/v1/bookmarks?${mine}&sort=${sort}&limit=1${cursor}`)).data;
        out.push(...r.items.map((b: any) => b.id));
        if (!r.nextCursor) break;
        cursor = `&cursor=${r.nextCursor}`;
      }
      return out;
    };
    expect(await pages("newest")).toEqual([ids.c, ids.b, ids.a]);
    expect(await pages("oldest")).toEqual([ids.a, ids.b, ids.c]);
    await Bun.sleep(2);
    await api("PATCH", `/v1/bookmarks/${ids.a}`, { note: "touched" });
    expect((await pages("updated"))[0]).toBe(ids.a);
    await api("PATCH", `/v1/bookmarks/${ids.a}`, { sort: -1e15 });
    expect(await pages("manual")).toEqual([ids.a, ids.c, ids.b]);
  });

  test("a collection with its subcollections", async () => {
    const top = (await api("POST", "/v1/collections", { name: "Top" })).data;
    const sub = (await api("POST", "/v1/collections", { name: "Sub", parentId: top.id })).data;
    const leaf = (await api("POST", "/v1/collections", { name: "Leaf", parentId: sub.id })).data;
    const inTop = await saved("tree/top", para("x"), { collectionId: top.id });
    const inLeaf = await saved("tree/leaf", para("x"), { collectionId: leaf.id });
    const list = async (q: string) =>
      (await api("GET", `/v1/bookmarks?${q}`)).data.items.map((b: any) => b.id).sort();
    expect(await list(`collectionId=${top.id}`)).toEqual([inTop.id]);
    expect(await list(`collectionId=${top.id}&includeSubcollections=true`)).toEqual(
      [inTop.id, inLeaf.id].sort(),
    );
  });
});

describe("search", () => {
  let a: any;
  let b: any;

  test("finds words in text, notes and highlights; excludes; snippets from each", async () => {
    a = await saved("search/a", para("Pangolins curl up into armoured balls."), {
      note: "Remember the pangolin scales",
      tags: ["srch"],
    });
    b = await saved("search/b", para("Armadillos also roll into balls."), { tags: ["srch"] });
    await api("POST", `/v1/bookmarks/${b.id}/highlights`, {
      quote: "Armadillos also roll",
      note: "tatu",
    });
    await sys.indexer?.flush();
    const search = async (q: string, extra = "") =>
      (await api("GET", `/v1/search?q=${encodeURIComponent(q)}${extra}`)).data;
    const ids = (r: any) => r.hits.map((h: any) => h.bookmark.id).sort();
    expect(ids(await search("balls #srch"))).toEqual([a.id, b.id].sort());
    expect(ids(await search("balls -pangolins #srch"))).toEqual([b.id]);
    expect(ids(await search("tatu"))).toEqual([b.id]);
    const multi = await search("pangolin", "&maxSnippets=3");
    const hit = multi.hits.find((h: any) => h.bookmark.id === a.id);
    expect(hit.snippet).toContain("<mark>");
    expect(hit.snippets.length).toBeGreaterThanOrEqual(2);
    expect(hit.snippets.some((s: string) => s.includes("scales"))).toBe(true);
    expect(multi.semanticApplied).toBe(false);
    expect(multi.engine).toBe(withSearch ? "meilisearch" : "sqlite");
  });

  test("conditions alone are answered by the database, with the new filters", async () => {
    const r = await api("GET", "/v1/search?q=%23srch&hasNote=true");
    expect(r.data.engine).toBe("sqlite");
    expect(r.data.hits.map((h: any) => h.bookmark.id)).toEqual([a.id]);
    expect(r.data.estimatedTotal).toBe(1);
    const hl = await api("GET", "/v1/search?tags=srch&hasHighlights=true&contentStatus=ok");
    expect(hl.data.hits.map((h: any) => h.bookmark.id)).toEqual([b.id]);
    const failed = await api("GET", "/v1/search?tags=srch&contentStatus=failed");
    expect(failed.data.hits).toHaveLength(0);
    expect((await api("GET", "/v1/search?maxSnippets=9")).status).toBe(400);
  });

  test("a Meilisearch that fails leaves the database to answer", async () => {
    const down = new Searcher(new Meili("http://127.0.0.1:1", ""), "none", sys.ctx.bookmarks, "");
    const warn = console.warn;
    console.warn = () => {};
    try {
      const r = await down.search({
        q: "pangolins",
        tags: ["srch"],
        sort: "relevance",
        limit: 10,
        offset: 0,
        snippets: true,
      });
      expect([r.engine, r.hits.map((h) => h.bookmark.id)]).toEqual(["sqlite", [a.id]]);
    } finally {
      console.warn = warn;
    }
  });

  test.if(withSearch)("Meilisearch takes the new filters too", async () => {
    await sys.indexer!.flush();
    const r = await api("GET", "/v1/search?q=balls&tags=srch&hasNote=false&contentStatus=ok");
    expect(r.data.engine).toBe("meilisearch");
    expect(r.data.hits.map((h: any) => h.bookmark.id)).toEqual([b.id]);
  });
});

describe("sync generation", () => {
  test("sync says which database and its newest seq", async () => {
    const s = await sync(0);
    expect(s.generation).toBe(sys.ctx.db.generation);
    expect(s.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.serverSeq).toBeGreaterThanOrEqual(s.cursor);
  });
});

describe("token scopes", () => {
  const as = (scopes: ("read" | "write" | "delete" | "admin")[]) => {
    const { token } = sys.ctx.tokens.create(`scoped-${scopes.join("-")}`, scopes);
    return (method: string, path: string, body?: unknown) =>
      api(method, path, body, { authorization: `Bearer ${token}` });
  };

  test("read only reads", async () => {
    const ro = as(["read"]);
    expect((await ro("GET", "/v1/bookmarks")).status).toBe(200);
    expect((await ro("POST", "/v1/bookmarks/lookup", { urls: [`${base}/x`] })).status).toBe(200);
    const denied = await ro("POST", "/v1/bookmarks", { url: `${base}/v1test/ro` });
    expect([denied.status, denied.data.code]).toEqual([403, "FORBIDDEN"]);
    expect((await ro("GET", "/v1/capabilities")).data.scopes).toEqual(["read"]);
  });

  test("write can't delete or administer; delete is needed for batch delete", async () => {
    const rw = as(["read", "write"]);
    const b = (
      await rw("POST", "/v1/bookmarks", { url: `${base}/v1test/rw`, html: html("rw", para("x")) })
    ).data;
    expect((await rw("PATCH", `/v1/bookmarks/${b.id}`, { favorite: true })).status).toBe(200);
    expect((await rw("DELETE", `/v1/bookmarks/${b.id}`)).status).toBe(403);
    expect((await rw("POST", "/v1/bookmarks/batch", { ids: [b.id], delete: true })).status).toBe(
      403,
    );
    const patched = await rw("POST", "/v1/bookmarks/batch", {
      ids: [b.id],
      patch: { favorite: false },
    });
    expect(patched.status).toBe(200);
    expect((await rw("PATCH", "/v1/settings", { skipDomains: [] })).status).toBe(403);
    expect(
      (await rw("POST", "/v1/import/raindrop", "url,title,folder,tags,created\n")).status,
    ).toBe(403);
    const admin = as(["admin"]);
    expect((await admin("PATCH", "/v1/settings", { skipDomains: [] })).status).toBe(200);
    expect((await as(["delete"])("DELETE", `/v1/bookmarks/${b.id}`)).status).toBe(204);
    await sys.runner.idle();
  });
});

describe("error classes", () => {
  test("a runtime TypeError is a 500; a RangeError a 400", async () => {
    const fresh = createApp(sys.ctx);
    fresh.get("/v1/test-errors/:kind", (c) => {
      if (c.req.param("kind") === "type") throw new TypeError("oops");
      throw new RangeError("bad input");
    });
    const get = async (kind: string) => {
      const res = await fresh.request(`/v1/test-errors/${kind}`, {
        headers: { authorization: `Bearer ${sys.token}` },
      });
      return { status: res.status, data: (await res.json()) as any };
    };
    const type = await get("type");
    expect([type.status, type.data.code]).toEqual([500, "INTERNAL_ERROR"]);
    const range = await get("range");
    expect([range.status, range.data.code, range.data.error]).toEqual([
      400,
      "INVALID_REQUEST",
      "bad input",
    ]);
  });
});
