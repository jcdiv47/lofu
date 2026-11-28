import { describe, expect, test } from "bun:test";
import { setupServer } from "./harness.ts";

/** Phase 3 of the /v1 API: `trashed`, the Trash left out by default, `{ items }`, content statuses. */
const { sys, api, base, withSearch } = setupServer();

const html = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><article>${body}</article></body></html>`;
const para = (words: string) =>
  `<p>${words} ${"Filler words that make the article long enough to be read as one. ".repeat(4)}</p>`;

async function saved(path: string, extra: Record<string, unknown> = {}) {
  const r = await api("POST", "/v1/bookmarks?wait=true", {
    url: `${base}/contract/${path}`,
    html: html(path, para("Trashy words.")),
    tags: ["contract"],
    ...extra,
  });
  expect([200, 201]).toContain(r.status);
  return r.data;
}

const ids = (items: { id: string }[]) => items.map((b) => b.id).sort();

describe("trashed", () => {
  let active: any;
  let trashed: any;

  test("is the field's name; archived is gone", async () => {
    active = await saved("active");
    trashed = await saved("trashed", { trashed: true });
    expect(active.trashed).toBe(false);
    expect(trashed.trashed).toBe(true);
    expect("archived" in trashed).toBe(false);
    const back = await api("PATCH", `/v1/bookmarks/${trashed.id}`, { trashed: false });
    expect(back.data.trashed).toBe(false);
    const again = await api("PATCH", `/v1/bookmarks/${trashed.id}`, { trashed: true });
    expect(again.data.trashed).toBe(true);
    expect(again.data.seq).toBeGreaterThan(back.data.seq);
  });

  test("the list leaves the Trash out unless asked", async () => {
    const list = async (q = "") =>
      ids((await api("GET", `/v1/bookmarks?tags=contract${q}`)).data.items);
    expect(await list()).toEqual([active.id]);
    expect(await list("&trashed=false")).toEqual([active.id]);
    expect(await list("&trashed=0")).toEqual([active.id]);
    expect(await list("&trashed=true")).toEqual([trashed.id]);
    expect(await list("&trashed=1")).toEqual([trashed.id]);
    expect(await list("&trashed=all")).toEqual(ids([active, trashed]));
    expect((await api("GET", "/v1/bookmarks?trashed=maybe")).status).toBe(400);
  });

  test("search leaves the Trash out unless asked", async () => {
    if (withSearch) await sys.indexer!.flush();
    for (const q of ["", "trashy"]) {
      const hits = async (t = "") =>
        (await api("GET", `/v1/search?q=${q}&tags=contract${t}`)).data.hits
          .map((h: any) => h.bookmark.id)
          .sort();
      expect(await hits()).toEqual([active.id]);
      expect(await hits("&trashed=true")).toEqual([trashed.id]);
      expect(await hits("&trashed=all")).toEqual(ids([active, trashed]));
    }
  });

  test("lookup leaves the Trash out unless includeTrashed", async () => {
    const one = (url: string, q = "") =>
      api("GET", `/v1/bookmarks/lookup?url=${encodeURIComponent(url)}${q}`);
    expect((await one(active.url)).data.id).toBe(active.id);
    const hidden = await one(trashed.url);
    expect([hidden.status, hidden.data.code]).toEqual([404, "NOT_FOUND"]);
    expect((await one(trashed.url, "&includeTrashed=true")).data.id).toBe(trashed.id);

    const many = await api("POST", "/v1/bookmarks/lookup", { urls: [active.url, trashed.url] });
    expect(many.data.items[active.url].id).toBe(active.id);
    expect(many.data.items[trashed.url]).toBeNull();
    const withTrash = await api("POST", "/v1/bookmarks/lookup", {
      urls: [active.url, trashed.url],
      includeTrashed: true,
    });
    expect(withTrash.data.items[trashed.url].id).toBe(trashed.id);
  });

  test("highlights of the Trash are left out unless asked", async () => {
    const ha = (await api("POST", `/v1/bookmarks/${active.id}/highlights`, { quote: "Trashy" }))
      .data;
    const ht = (await api("POST", `/v1/bookmarks/${trashed.id}/highlights`, { quote: "Trashy" }))
      .data;
    const list = async (q = "") =>
      ids((await api("GET", `/v1/highlights?tag=contract${q}`)).data.items);
    expect(await list()).toEqual([ha.id]);
    expect(await list("&trashed=true")).toEqual([ht.id]);
    expect(await list("&trashed=all")).toEqual(ids([ha, ht]));
    // One by id is still found: the Trash is not deleted.
    expect((await api("GET", `/v1/highlights/${ht.id}`)).status).toBe(200);
  });

  test("tags leave the Trash out unless includeTrashed", async () => {
    await api("PATCH", `/v1/bookmarks/${trashed.id}`, { addTags: ["only-trash"] });
    const names = async (q = "") =>
      (await api("GET", `/v1/tags${q}`)).data.items.map((t: any) => t.name);
    expect(await names()).not.toContain("only-trash");
    expect(await names("?includeTrashed=true")).toContain("only-trash");
  });

  test("sync still sends the Trash, and tombstones", async () => {
    const gone = await saved("gone");
    await api("DELETE", `/v1/bookmarks/${gone.id}`);
    const s = (await api("GET", "/v1/sync?since=0&limit=5000")).data;
    const byId = new Map(s.bookmarks.map((b: any) => [b.id, b]));
    expect((byId.get(trashed.id) as any).trashed).toBe(true);
    expect((byId.get(active.id) as any).trashed).toBe(false);
    expect((byId.get(gone.id) as any).deletedAt).not.toBeNull();
  });

  test("is in the OpenAPI document", async () => {
    const doc = (await api("GET", "/openapi.json")).data;
    const schemas = doc.components.schemas;
    expect(schemas.Bookmark.properties.trashed).toBeDefined();
    expect(schemas.Bookmark.properties.archived).toBeUndefined();
    const params = doc.paths["/v1/bookmarks"].get.parameters.map((p: any) => p.name);
    expect(params).toContain("trashed");
    expect(params).not.toContain("archived");
  });
});

describe("list envelopes", () => {
  test("tags, collections and a bookmark's highlights come as { items }", async () => {
    const b = await saved("envelope");
    await api("POST", `/v1/bookmarks/${b.id}/highlights`, { quote: "Trashy" });
    await api("POST", "/v1/collections", { name: "Enveloped" });
    const tags = (await api("GET", "/v1/tags")).data;
    expect(tags.items).toBeArray();
    expect(tags.items.find((t: any) => t.name === "contract").count).toBeGreaterThan(0);
    const cols = (await api("GET", "/v1/collections")).data;
    expect(cols.items.map((c: any) => c.name)).toContain("Enveloped");
    const hl = (await api("GET", `/v1/bookmarks/${b.id}/highlights`)).data;
    expect(hl.items.map((h: any) => h.quote)).toEqual(["Trashy"]);
    const doc = (await api("GET", "/openapi.json")).data;
    const ref = (path: string) =>
      doc.paths[path].get.responses["200"].content["application/json"].schema.$ref;
    expect(ref("/v1/tags")).toBe("#/components/schemas/TagList");
    expect(ref("/v1/collections")).toBe("#/components/schemas/CollectionList");
    expect(ref("/v1/bookmarks/{id}/highlights")).toBe("#/components/schemas/HighlightList");
  });
});

describe("content", () => {
  test("is Markdown by default", async () => {
    const b = await saved("markdown-default");
    const r = await api("GET", `/v1/bookmarks/${b.id}/content`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toStartWith("text/markdown");
  });

  test("says why it isn't there", async () => {
    const missing = await api("GET", "/v1/bookmarks/nope/content");
    expect([missing.status, missing.data.code]).toEqual([404, "NOT_FOUND"]);

    // The page answers 404: extraction fails, and there is no content.
    const failed = (await api("POST", "/v1/bookmarks?wait=true", { url: `${base}/gone/contract` }))
      .data;
    expect(failed.contentStatus).toBe("failed");
    const f = await api("GET", `/v1/bookmarks/${failed.id}/content`);
    expect([f.status, f.data.code]).toEqual([422, "CONTENT_FAILED"]);
    expect(f.data.error).toBe(failed.contentError ?? "content extraction failed");

    const setStatus = (status: string) =>
      sys.ctx.db
        .query("UPDATE bookmarks SET content_status = ? WHERE id = ?")
        .run(status, failed.id);
    const get = async () => {
      const r = await api("GET", `/v1/bookmarks/${failed.id}/content?format=text`);
      return [r.status, r.data.code];
    };
    setStatus("pending");
    expect(await get()).toEqual([409, "CONTENT_PENDING"]);
    setStatus("skipped");
    expect(await get()).toEqual([422, "CONTENT_SKIPPED"]);
    setStatus("ok");
    expect(await get()).toEqual([404, "CONTENT_NOT_FOUND"]);
    setStatus("failed");

    const doc = (await api("GET", "/openapi.json")).data;
    const responses = doc.paths["/v1/bookmarks/{id}/content"].get.responses;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(["404", "409", "422"]));
    const format = doc.paths["/v1/bookmarks/{id}/content"].get.parameters.find(
      (p: any) => p.name === "format",
    );
    expect(format.schema.default).toBe("markdown");
  });
});

describe("highlights of deleted bookmarks", () => {
  test("are not found one by one", async () => {
    const b = await saved("orphan");
    const h = (await api("POST", `/v1/bookmarks/${b.id}/highlights`, { quote: "Trashy" })).data;
    // As a build before deletes tombstoned highlights would leave it.
    sys.ctx.db.query("UPDATE bookmarks SET deleted_at = 1 WHERE id = ?").run(b.id);
    const r = await api("GET", `/v1/highlights/${h.id}`);
    expect([r.status, r.data.code]).toEqual([404, "NOT_FOUND"]);
    expect((await api("PATCH", `/v1/highlights/${h.id}`, { note: "x" })).status).toBe(404);
  });
});
