import { describe, expect, test } from "bun:test";
import { Browser, findChromium } from "../src/extract/browser.ts";
import { allowPrivateNetworks } from "../src/extract/netguard.ts";
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

describe.if(Boolean(chromium))("browser requests to private networks (real Chromium)", () => {
  test("a page's own requests can't reach the LAN", async () => {
    let hits = 0;
    const lan = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("secret");
      },
    });
    const browser = new Browser(
      { kind: "launch", executable: chromium!, args: [] },
      { concurrency: 1, timeoutMs: 6_000, idleMs: 60_000 },
    );
    allowPrivateNetworks(false);
    try {
      const target = `http://127.0.0.1:${lan.port}/hit`;
      const page = `<title>t</title><script>fetch(${JSON.stringify(target)}).catch(()=>{});
        const s=document.createElement("script");s.src=${JSON.stringify(`${target}.js`)};document.head.append(s);
        setTimeout(()=>{location.href=${JSON.stringify(`${target}-nav`)}},500);</script>`;
      await browser.render(`data:text/html,${encodeURIComponent(page)}`).catch(() => null);
      expect(hits).toBe(0);
    } finally {
      allowPrivateNetworks(true);
      browser.shutdown();
      lan.stop(true);
    }
  }, 30_000);
});
