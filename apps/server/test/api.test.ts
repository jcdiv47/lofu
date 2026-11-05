import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { wire } from "../src/wire.ts";
import { startFixtureServer } from "./fixtures.ts";

const site = startFixtureServer();
const base = `http://localhost:${site.port}`;
const withSearch = Boolean(process.env.MEILI_URL);
const sys = wire({
  ...config,
  dbPath: ":memory:",
  authDisabled: false,
  extractWorkers: 2,
  meiliUrl: withSearch ? (process.env.MEILI_URL as string) : "",
  meiliIndex: `test_${Date.now()}`,
});
const app = createApp(sys.ctx);
const { token } = sys.ctx.tokens.create("test");

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data, res };
}

beforeAll(() => sys.start());
afterAll(async () => {
  if (withSearch && sys.indexer) {
    await fetch(`${process.env.MEILI_URL}/indexes/${sys.indexer.index}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${process.env.MEILI_MASTER_KEY}` },
    });
  }
  await sys.stop();
  site.stop(true);
});

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
      html: "<html><head><title>Server title</title></head><body><article><p>Members-only text about quokkas.</p></article></body></html>",
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

  test("non-HTML is typed and skipped; 404 fails permanently", async () => {
    const pdf = await api("POST", "/v1/bookmarks", { url: `${base}/paper.pdf` });
    const missing = await api("POST", "/v1/bookmarks", { url: `${base}/gone` });
    await sys.runner.idle();
    const p = (await api("GET", `/v1/bookmarks/${pdf.data.id}`)).data;
    expect([p.contentStatus, p.type, p.title]).toEqual(["skipped", "document", "paper.pdf"]);
    const m = (await api("GET", `/v1/bookmarks/${missing.data.id}`)).data;
    expect([m.contentStatus, m.contentError]).toEqual(["failed", "HTTP 404"]);
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
    expect(r.data.hits[0].snippet).toContain("<mark>");
    const byHighlight = await api("GET", "/v1/search?q=key%20idea");
    expect(byHighlight.data.hits.length).toBeGreaterThan(0);
    const filtered = await api("GET", "/v1/search?q=zymurgy&tags=nonexistent");
    expect(filtered.data.hits).toHaveLength(0);
  });
});

describe("sync and deletes", () => {
  test("collections delete moves bookmarks to unsorted", async () => {
    const col = await api("POST", "/v1/collections", { name: "Read later" });
    const b = await api("POST", "/v1/bookmarks", {
      url: `${base}/article-2`,
      collectionId: col.data.id,
    });
    expect(b.data.collectionId).toBe(col.data.id);
    expect((await api("DELETE", `/v1/collections/${col.data.id}`)).status).toBe(204);
    expect((await api("GET", `/v1/bookmarks/${b.data.id}`)).data.collectionId).toBeNull();
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
