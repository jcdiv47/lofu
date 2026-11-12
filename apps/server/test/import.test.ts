import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { Fetcher } from "../src/extract/fetch.ts";
import { allowPrivateNetworks } from "../src/extract/netguard.ts";
import { parseCsv } from "../src/importers/csv.ts";
import { parseRaindropHighlights } from "../src/importers/raindrop.ts";
import { noopHooks } from "../src/store/hooks.ts";
import { JobStore, Priority } from "../src/store/jobs.ts";
import { startFixtureServer } from "./fixtures.ts";
import { setupServer } from "./harness.ts";

const { sys, api, base } = setupServer();

describe("csv parser", () => {
  test("quotes, escaped quotes, embedded newlines, CRLF, BOM", () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["2", "line1\nline2", ""],
    ]);
  });
  test("no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

test("placeholder titles from Raindrop are not imported", async () => {
  const { isPlaceholderTitle } = await import("../src/importers/raindrop.ts");
  const pdf = "https://arxiv.org/pdf/1910.10683.pdf";
  for (const t of [
    pdf,
    "arxiv.org/pdf/1910.10683.pdf",
    "1910.10683.pdf",
    "Webpage: arxiv.org",
    "arxiv.org",
    "",
  ]) {
    expect([t, isPlaceholderTitle(t, pdf)]).toEqual([t, true]);
  }
  expect(isPlaceholderTitle("Exploring the Limits of Transfer Learning", pdf)).toBe(false);
});

test("raindrop highlights column", () => {
  expect(parseRaindropHighlights("Highlight:one\nNote:why\nHighlight:two")).toEqual([
    { quote: "one", note: "why" },
    { quote: "two" },
  ]);
  expect(parseRaindropHighlights("")).toEqual([]);
});

describe("raindrop import", () => {
  const csv = `id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite
1,"Sourdough, explained",My note,"Excerpt with ""quotes""",${base}/article-rd-1,Read Later,"baking, Science",2024-01-02T03:04:05.000Z,https://rdl.ink/render/x,"Highlight:fermentation curves
Note:key idea
Highlight:crumb structure",true
2,,,,${base}/article-rd-2,Unsorted,,2023-05-06T00:00:00.000Z,https://example.com/c.jpg,,false
3,Ext,,,chrome-extension://abc/index.html,Learn,,2023-05-06T00:00:00.000Z,,,false
4,中文标题,,,${base}/article-rd-3?utm_source=x,已归档书签,中文,2022-01-01T00:00:00.000Z,,,false
`;

  test("imports bookmarks, collections, tags, highlights; skips unsupported URLs", async () => {
    const r = await api("POST", "/v1/import/raindrop", csv);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      total: 4,
      created: 3,
      merged: 0,
      highlightsAdded: 2,
      queued: 3,
      collectionsCreated: ["Read Later", "已归档书签"],
    });
    expect(r.data.skipped).toEqual([
      {
        row: 4,
        url: "chrome-extension://abc/index.html",
        reason: expect.stringContaining("unsupported"),
      },
    ]);

    await sys.runner.idle();
    const items = (await api("GET", "/v1/bookmarks?limit=10")).data.items;
    const first = items.find((b: any) => b.url.endsWith("/article-rd-1"));
    expect(first).toMatchObject({
      title: "Sourdough, explained", // Raindrop title kept over the page's
      note: "My note",
      excerpt: 'Excerpt with "quotes"',
      tags: ["baking", "science"],
      favorite: true,
      createdAt: "2024-01-02T03:04:05.000Z",
      coverUrl: "https://example.com/cover.jpg", // rdl.ink render dropped, og:image used
      contentStatus: "ok",
    });
    const hs = (await api("GET", `/v1/bookmarks/${first.id}/highlights`)).data;
    expect(hs.map((h: any) => [h.quote, h.note])).toEqual([
      ["fermentation curves", "key idea"],
      ["crumb structure", null],
    ]);
    const second = items.find((b: any) => b.url.endsWith("/article-rd-2"));
    expect([second.collectionId, second.coverUrl]).toEqual([null, "https://example.com/c.jpg"]);
    const cols = (await api("GET", "/v1/collections")).data.map((c: any) => c.name);
    expect(cols.sort()).toEqual(["Read Later", "已归档书签"]);
  });

  test("re-importing the same export changes nothing", async () => {
    const r = await api("POST", "/v1/import/raindrop", csv);
    expect(r.data).toMatchObject({
      created: 0,
      merged: 3,
      highlightsAdded: 0,
      collectionsCreated: [],
    });
    expect((await api("GET", "/v1/collections")).data).toHaveLength(2);
  });

  test("rejects files that aren't Raindrop exports", async () => {
    const r = await api("POST", "/v1/import/raindrop", "a,b\n1,2\n");
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("not a Raindrop CSV");
  });
});

test("interactive jobs are claimed before bulk ones", () => {
  const db = openDb(":memory:");
  const jobs = new JobStore(db, noopHooks);
  for (let i = 0; i < 5; i++) jobs.enqueue("extract", `bulk-${i}`, null, Priority.bulk);
  jobs.enqueue("extract", "mine", null, Priority.interactive);
  expect(jobs.claim(1, 60_000).map((j) => j.bookmark_id)).toEqual(["mine"]);
  db.close();
});

test("fetcher paces requests to the same host", async () => {
  allowPrivateNetworks(true); // the fixture site is on localhost
  const site = startFixtureServer();
  const f = new Fetcher({
    concurrency: 8,
    perHost: 4,
    timeoutMs: 5000,
    maxBytes: 1e6,
    http2: false,
    hostIntervalMs: 100,
  });
  const t0 = performance.now();
  await Promise.all([1, 2, 3].map((i) => f.fetch(`http://localhost:${site.port}/article-${i}`)));
  expect(performance.now() - t0).toBeGreaterThanOrEqual(195);
  site.stop(true);
});

test("block page detection only fires on short interstitials", async () => {
  const { detectBlockPage } = await import("../src/extract/blocked.ts");
  expect(detectBlockPage("验证", "环境异常 当前环境异常，完成验证后即可继续访问。")).toBe(
    "WeChat verification page",
  );
  expect(detectBlockPage("Just a moment...", "Enable JavaScript and cookies to continue")).toBe(
    "Cloudflare challenge",
  );
  expect(
    detectBlockPage("Captchas explained", `${"Long article about captcha design. ".repeat(40)}`),
  ).toBeNull();
  expect(detectBlockPage("Hello", "A short but normal page.")).toBeNull();
  const zhihu =
    '{"error":{"message":"您当前请求存在异常，暂时限制本次访问。如有疑问，您可以通过手机摇一摇或登录后私信知乎小管家反馈。","code":40362}}';
  expect(detectBlockPage("知乎", zhihu)).toBe("Zhihu rate limit");
});

test("pdf reflow joins wrapped lines, hyphenation and CJK", async () => {
  const { reflow } = await import("../src/extract/pdf.ts");
  expect(
    reflow("Attention is all\nyou need. Trans-\nformers rock.\n\n注意力机制\n是一切\fNext page"),
  ).toEqual(["Attention is all you need. Transformers rock.", "注意力机制是一切", "Next page"]);
});

test("startup releases leases left by a dead process", () => {
  const db = openDb(":memory:");
  const jobs = new JobStore(db, noopHooks);
  jobs.enqueue("extract", "b1");
  expect(jobs.claim(10, 60_000)).toHaveLength(1);
  expect(jobs.claim(10, 60_000)).toHaveLength(0); // leased
  jobs.releaseAll();
  expect(jobs.claim(10, 60_000)).toHaveLength(1);
  db.close();
});
