import { describe, expect, test } from "bun:test";
import { findChromium } from "../src/extract/browser.ts";
import { setupServer } from "./harness.ts";

const chromium = findChromium(process.env.LOFU_CHROME_PATH || undefined);

describe.if(Boolean(chromium))("browser fallback (real Chromium)", () => {
  const { sys, api, base } = setupServer({ browser: "auto", browserTimeoutMs: 15_000 });

  test("client-rendered pages are rendered in Chromium", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/spa` });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}?content=text`)).data;
    expect(b.contentStatus).toBe("ok");
    expect(b.content).toContain("pangolin");
  }, 30_000);

  test("403 bot walls that admit real browsers are retried in Chromium", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/bot-wall` });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}`)).data;
    expect([b.contentStatus, b.title]).toEqual(["ok", "Sourdough Science"]);
  }, 30_000);

  test("a 403 the browser can't pass either fails with both reasons", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/forbidden` });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}`)).data;
    expect(b.contentStatus).toBe("failed");
    expect(b.contentError).toStartWith("blocked by site (HTTP 403); ");
  }, 30_000);
});
