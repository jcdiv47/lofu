import { describe, expect, test } from "bun:test";
import { pageRedirect, resolveLink } from "../src/extract/links.ts";
import { setupServer } from "./harness.ts";

/** A fake network: URL → response, recording what was requested. */
function net(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetch = async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected request ${url}`);
    return r();
  };
  return { fetch, seen };
}
const redirect = (to: string, status = 301) =>
  new Response(null, { status, headers: { location: to } });
const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("resolveLink", () => {
  test("follows a short link to the article and stops there", async () => {
    const n = net({
      "https://t.co/abc": () => redirect("https://blog.example.com/post?ref=x"),
    });
    expect(await resolveLink("https://t.co/abc", n)).toBe("https://blog.example.com/post?ref=x");
    expect(n.seen).toEqual(["https://t.co/abc"]);
  });

  test("chains: t.cn to Weibo's leaving page to the target", async () => {
    const n = net({
      "http://t.cn/A6xyz": () =>
        redirect("https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.com%2Farticle", 302),
    });
    expect(await resolveLink("http://t.cn/A6xyz", n)).toBe("https://example.com/article");
  });

  test("reads a meta refresh or script redirect off an interstitial page", async () => {
    const n = net({
      "https://t.co/meta": () =>
        html(
          `<head><meta http-equiv="refresh" content="0;URL=https://example.com/a?x=1&amp;y=2"></head>`,
        ),
      "https://bit.ly/js": () =>
        html(`<script>window.location.replace("https:\\/\\/example.com\\/b")</script>`),
    });
    expect(await resolveLink("https://t.co/meta", n)).toBe("https://example.com/a?x=1&y=2");
    expect(await resolveLink("https://bit.ly/js", n)).toBe("https://example.com/b");
  });

  test("unwraps a wrapper without asking the network", async () => {
    const n = net({});
    expect(await resolveLink("https://link.zhihu.com/?target=https%3A//github.com/a/b", n)).toBe(
      "https://github.com/a/b",
    );
    expect(n.seen).toEqual([]);
  });

  test("leaves ordinary links alone", async () => {
    const n = net({});
    expect(await resolveLink("https://x.com/user/status/1", n)).toBe("https://x.com/user/status/1");
    expect(n.seen).toEqual([]);
  });

  test("keeps the short link when it dies, loops or ends on a wall", async () => {
    const n = net({
      "https://t.co/dead": () => new Response("gone", { status: 404 }),
      "https://bit.ly/loop": () => redirect("https://bit.ly/loop"),
      "http://xhslink.com/a/x": () => redirect("https://www.xiaohongshu.com/404/sec_abc"),
      "https://t.co/home": () => redirect("https://x.com/"),
      "http://t.cn/gone": () => redirect("https://luck.sc.weibo.com/?source=ugsx", 302),
      "https://t.co/fails": () => {
        throw new Error("network down");
      },
    });
    for (const u of [
      "https://t.co/dead",
      "https://bit.ly/loop",
      "http://xhslink.com/a/x",
      "https://t.co/home",
      "http://t.cn/gone",
      "https://t.co/fails",
    ]) {
      expect(await resolveLink(u, n)).toBe(u);
    }
  });

  test("a link to a site's home page is still followed", async () => {
    const n = net({ "https://t.co/site": () => redirect("https://lofu.example/") });
    expect(await resolveLink("https://t.co/site", n)).toBe("https://lofu.example/");
  });

  test("pageRedirect ignores pages without one", () => {
    expect(pageRedirect("<p>hello</p>", "https://t.co/x")).toBeNull();
    expect(
      pageRedirect(`<script>location.href="javascript:1"</script>`, "https://t.co/x"),
    ).toBeNull();
  });
});

describe("saving a wrapped link", () => {
  const { api, base } = setupServer();
  test("saves the page the wrapper leads to, once", async () => {
    const target = `${base.replace("localhost", "127.0.0.1")}/article`;
    const a = await api("POST", "/v1/bookmarks", {
      url: `https://weibo.cn/sinaurl?u=${encodeURIComponent(target)}`,
    });
    expect(a.data.url).toBe(target);
    const b = await api("POST", "/v1/bookmarks", { url: target });
    expect(b.status).toBe(200);
    expect(b.data.id).toBe(a.data.id);
  });
});
