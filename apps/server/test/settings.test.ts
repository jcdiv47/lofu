import { describe, expect, test } from "bun:test";
import { onSite, siteDomain } from "@lofu/shared";
import { setupServer } from "./harness.ts";

// The fixture site is `localhost`: every page on it is on one site.
const { sys, api, base } = setupServer();

describe("site domains", () => {
  test("what's typed becomes a bare domain", () => {
    expect(siteDomain("https://www.Example.com/a?b")).toBe("example.com");
    expect(siteDomain("  x.com ")).toBe("x.com");
    expect(siteDomain("*.medium.com")).toBe("medium.com");
    expect(siteDomain("mobile.x.com/")).toBe("mobile.x.com");
    expect(siteDomain("")).toBeNull();
    expect(siteDomain("not a site")).toBeNull();
  });
  test("a subdomain is on its site; a lookalike isn't", () => {
    expect(onSite("x.com", ["x.com"])).toBe(true);
    expect(onSite("mobile.x.com", ["x.com"])).toBe(true);
    expect(onSite("box.com", ["x.com"])).toBe(false);
    expect(onSite("x.com", ["mobile.x.com"])).toBe(false);
  });
});

describe("sites not read", () => {
  test("start empty, and are saved as domains", async () => {
    expect((await api("GET", "/v1/settings")).data).toEqual({ skipDomains: [] });
    const r = await api("PATCH", "/v1/settings", {
      skipDomains: ["https://www.YouTube.com/watch", "x.com", "x.com"],
    });
    expect(r.status).toBe(200);
    expect(r.data.skipDomains).toEqual(["x.com", "youtube.com"]);
    expect((await api("PATCH", "/v1/settings", { skipDomains: ["no such thing"] })).status).toBe(
      400,
    );
    expect((await api("GET", "/v1/settings")).data.skipDomains).toEqual(["x.com", "youtube.com"]);
  });

  test("a bookmark on one is skipped without being fetched, even with HTML", async () => {
    const failed = (await api("POST", "/v1/bookmarks", { url: `${base}/gone` })).data;
    await sys.runner.idle();
    expect((await api("GET", `/v1/bookmarks/${failed.id}`)).data.contentStatus).toBe("failed");

    // Adding the site: what failed there isn't *Unreadable* any more.
    const { data: before } = await api("GET", `/v1/bookmarks/${failed.id}`);
    await api("PATCH", "/v1/settings", { skipDomains: ["localhost", "x.com"] });
    const after = (await api("GET", `/v1/bookmarks/${failed.id}`)).data;
    expect([after.contentStatus, after.contentError]).toEqual(["skipped", null]);
    expect(after.seq).toBeGreaterThan(before.seq);

    const page = (await api("POST", "/v1/bookmarks", { url: `${base}/article`, title: "Mine" }))
      .data;
    const sent = (
      await api("POST", "/v1/bookmarks", {
        url: `${base}/rendered`,
        html: "<html><body><article><p>Lots of words here.</p></article></body></html>",
      })
    ).data;
    await sys.runner.idle();
    for (const id of [page.id, sent.id]) {
      const b = (await api("GET", `/v1/bookmarks/${id}?content=markdown`)).data;
      expect([b.contentStatus, b.content]).toEqual(["skipped", null]);
    }
    expect((await api("GET", `/v1/bookmarks/${page.id}`)).data.title).toBe("Mine");
  });

  test("taking a site off reads its skipped bookmarks again", async () => {
    const b = (await api("POST", "/v1/bookmarks", { url: `${base}/article?again=1` })).data;
    await sys.runner.idle();
    expect((await api("GET", `/v1/bookmarks/${b.id}`)).data.contentStatus).toBe("skipped");

    await api("PATCH", "/v1/settings", { skipDomains: ["x.com"] });
    expect((await api("GET", `/v1/bookmarks/${b.id}`)).data.contentStatus).toBe("pending");
    await sys.runner.idle();
    const read = (await api("GET", `/v1/bookmarks/${b.id}`)).data;
    expect([read.contentStatus, read.title]).toEqual(["ok", "Sourdough Science"]);
  });

  test("are in the OpenAPI document", async () => {
    const doc = (await (await sys.app.request("/openapi.json")).json()) as any;
    expect(doc.paths["/v1/settings"].patch).toBeDefined();
  });
});
