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
  // Chromium goes through a local proxy, so pages can sit at public addresses
  // (which the guard lets through) and their requests to private ones arrive
  // here when nothing stops them (Chromium's own local-network checks see
  // only the proxy's address).
  async function lanHits(guarded: boolean): Promise<string[]> {
    const hits: string[] = [];
    const lan = "http://10.0.0.1";
    const html = (body: string) =>
      new Response(`<!doctype html><title>t</title>${body}`, {
        headers: { "content-type": "text/html" },
      });
    const proxy = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.hostname === "8.8.8.8") {
          // An article whose scripts, worker and cross-site frame aim at the LAN.
          return html(`<iframe src="http://1.1.1.1/frame"></iframe><script>
            fetch("${lan}/hit-fetch").catch(() => {});
            const s = document.createElement("script"); s.src = "${lan}/hit-script"; document.head.append(s);
            new Worker(URL.createObjectURL(new Blob(['fetch("${lan}/hit-worker")'], { type: "text/javascript" })));
            setTimeout(() => { location.href = "${lan}/hit-nav"; }, 1500);
          </script>`);
        }
        if (u.hostname === "1.1.1.1") {
          return html(`<script>fetch("${lan}/hit-frame").catch(() => {});</script>`);
        }
        if (u.pathname.startsWith("/hit-")) hits.push(u.pathname);
        return new Response("secret", { headers: { "access-control-allow-origin": "*" } });
      },
    });
    const browser = new Browser(
      {
        kind: "launch",
        executable: chromium!,
        args: [
          `--proxy-server=http://127.0.0.1:${proxy.port}`,
          "--proxy-bypass-list=<-loopback>",
          "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable",
        ],
      },
      { concurrency: 1, timeoutMs: 5_000, idleMs: 60_000 },
    );
    allowPrivateNetworks(!guarded);
    try {
      await browser.render("http://8.8.8.8/article").catch(() => null);
      return hits.sort();
    } finally {
      allowPrivateNetworks(true);
      browser.shutdown();
      proxy.stop(true);
    }
  }

  test("without the guard, the page's requests reach the LAN (the test sees them)", async () => {
    expect(await lanHits(false)).toEqual([
      "/hit-fetch",
      "/hit-frame",
      "/hit-nav",
      "/hit-script",
      "/hit-worker",
    ]);
  }, 30_000);

  test("with it, none of them do: page, worker, cross-site frame", async () => {
    expect(await lanHits(true)).toEqual([]);
  }, 30_000);
});
