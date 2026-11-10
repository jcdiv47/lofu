import { describe, expect, test } from "bun:test";
import type { Fetcher, FetchResult, TextResponse } from "../src/extract/fetch.ts";
import { github } from "../src/extract/sites/github.ts";
import { siteFor } from "../src/extract/sites/index.ts";
import { weibo, weiboPostId } from "../src/extract/sites/weibo.ts";
import { ARTICLE_HTML } from "./fixtures.ts";
import { setupServer } from "./harness.ts";

const { sys, api, base } = setupServer();

const filler = (topic: string) =>
  `<p>${`A long paragraph about ${topic}, written so the article has enough text to count. `.repeat(6)}</p>`;

/** Saves `html` as if the extension uploaded it for `url`, and returns the result. */
async function saveRendered(url: string, html: string) {
  const r = await api("POST", "/v1/bookmarks", { url, html });
  await sys.runner.idle();
  const b = (await api("GET", `/v1/bookmarks/${r.data.id}?content=markdown`)).data;
  const extractor = sys.ctx.db
    .query<{ extractor: string | null }, [string]>(
      "SELECT extractor FROM contents WHERE bookmark_id = ?",
    )
    .get(r.data.id)?.extractor;
  return { ...b, extractor };
}

describe("siteFor", () => {
  test("matches hosts and their subdomains only", () => {
    expect(siteFor("https://github.com/a/b")?.name).toBe("github");
    expect(siteFor("https://zhuanlan.zhihu.com/p/1")?.name).toBe("zhihu");
    expect(siteFor("https://www.v2ex.com/t/1")?.name).toBe("v2ex");
    expect(siteFor("http://xhslink.com/abc")?.name).toBe("xiaohongshu");
    expect(siteFor("https://notgithub.com/a/b")).toBeNull();
    expect(siteFor("https://example.com/")).toBeNull();
    expect(siteFor("not a url")).toBeNull();
  });
});

describe("github", () => {
  const PAGE = `<html><head><title>owner/repo</title>
<meta property="og:description" content="A tool for sorting socks."></head><body>
<table><tr><td><a href="/owner/repo/tree/main/src">src</a></td></tr></table>
<div class="sidebar">About · 12 stars</div></body></html>`;
  const README = `<div id="readme" class="md"><article class="markdown-body"><h1>Sock sorter</h1>
${filler("pairing socks by colour")}<img src="./docs/demo.png"><a href="docs/USAGE.md">usage</a>
<a href="#install">install</a><img src="https://example.com/abs.png"></article></div>`;

  function stub(readme: Partial<TextResponse>) {
    const calls: string[] = [];
    const fetcher = {
      fetch: async (url: string): Promise<FetchResult> => {
        calls.push(url);
        return { kind: "html", html: PAGE, finalUrl: url, bytes: PAGE.length };
      },
      fetchText: async (url: string): Promise<TextResponse> => {
        calls.push(url);
        return {
          status: 200,
          text: README,
          contentType: "application/vnd.github.html",
          finalUrl: url,
          headers: new Headers(),
          ...readme,
        };
      },
    } as unknown as Fetcher;
    return { calls, ctx: { fetcher, githubToken: null } };
  }

  test("splices the README from the API into the repo page", async () => {
    const { calls, ctx } = stub({});
    const r = await github.fetch!(new URL("https://github.com/owner/repo"), ctx);
    expect(calls).toEqual([
      "https://github.com/owner/repo",
      "https://api.github.com/repos/owner/repo/readme",
    ]);
    expect(r?.kind === "html" && r.html).toContain("Sock sorter");
  });

  test("falls back to the page without a README; retries later when rate limited", async () => {
    const missing = await github.fetch!(
      new URL("https://github.com/owner/repo"),
      stub({ status: 404 }).ctx,
    );
    expect(missing?.kind === "html" && missing.html).not.toContain("Sock sorter");
    await expect(
      github.fetch!(new URL("https://github.com/owner/repo"), stub({ status: 403 }).ctx),
    ).rejects.toThrow("GitHub API rate limit");
    await expect(
      github.fetch!(new URL("https://github.com/owner/repo"), stub({ status: 502 }).ctx),
    ).rejects.toThrow("HTTP 502");
  });

  test("files are fetched raw; other pages are left to the generic fetch", async () => {
    const { calls, ctx } = stub({});
    await github.fetch!(new URL("https://github.com/owner/repo/blob/main/src/a.ts"), ctx);
    expect(calls).toEqual(["https://github.com/owner/repo/raw/main/src/a.ts"]);
    for (const path of ["/owner/repo/issues/1", "/owner", "/settings/profile"]) {
      expect(await github.fetch!(new URL(`https://github.com${path}`), ctx)).toBeNull();
    }
  });

  test("extracts the README, not the file list, with links resolved", async () => {
    const b = await saveRendered(
      "https://github.com/owner/repo",
      PAGE.replace("</body>", `<div data-lofu-readme>${README}</div></body>`),
    );
    expect([b.contentStatus, b.extractor]).toEqual(["ok", "github"]);
    expect(b.content).toContain("pairing socks");
    expect(b.content).not.toContain("12 stars");
    expect(b.content).toContain("https://github.com/owner/repo/raw/HEAD/docs/demo.png");
    expect(b.content).toContain("https://github.com/owner/repo/blob/HEAD/docs/USAGE.md");
    expect(b.content).toContain("https://example.com/abs.png");
  });
});

describe("wechat", () => {
  test("keeps the article body and reads author and date from scripts", async () => {
    const b = await saveRendered(
      "https://mp.weixin.qq.com/s/abc",
      `<html><head><title></title></head><body>
<h1 class="rich_media_title" id="activity-name">  训练笔记  </h1>
<div id="meta_content"><span id="js_author_name">NR Wu</span><a id="js_name">吃果冻</a></div>
<div class="novel-card">在小说阅读器读本章 去阅读</div>
<div id="js_content" style="visibility: hidden; opacity: 0; ">${filler("pipeline parallelism")}
<img data-src="https://mmbiz.qpic.cn/x.png" class="rich_pages"></div>
<div id="js_pc_qr_code">微信扫一扫关注该公众号</div>
<script>var nickname = htmlDecode("吃果冻"); var ct = "1781843010";</script>
<script>var author = "NR Wu";</script></body></html>`,
    );
    expect([b.contentStatus, b.extractor, b.title, b.author]).toEqual([
      "ok",
      "wechat",
      "训练笔记",
      "NR Wu",
    ]);
    expect(b.publishedAt).toStartWith("2026-06-19");
    expect(b.content).toContain("pipeline parallelism");
    expect(b.content).toContain("https://mmbiz.qpic.cn/x.png");
    expect(b.content).not.toContain("小说阅读器");
    expect(b.content).not.toContain("扫一扫");
  });
});

describe("xiaohongshu", () => {
  const state = {
    note: {
      noteDetailMap: {
        "6a2a54c8000000001503d9a3": {
          note: {
            title: "面试官问 KQV",
            desc: "能不能用同一个矩阵？\n答案是不能 #Transformer[话题]#",
            time: 1781780301000,
            user: { nickname: "炼丹师" },
            imageList: [
              { urlDefault: "https://sns-img.xhscdn.com/1.jpg" },
              { url: "https://sns-img.xhscdn.com/2.jpg" },
            ],
          },
        },
      },
    },
  };

  test("builds the note from the page state", async () => {
    const json = JSON.stringify(state).replace('"time"', '"video":undefined,"time"');
    const b = await saveRendered(
      "https://www.xiaohongshu.com/explore/6a2a54c8000000001503d9a3",
      `<html><head><title>小红书</title></head><body><div id="app">发现 直播 发布</div>
<script>window.__INITIAL_STATE__=${json}</script></body></html>`,
    );
    expect([b.contentStatus, b.extractor, b.title, b.author]).toEqual([
      "ok",
      "xiaohongshu",
      "面试官问 KQV",
      "炼丹师",
    ]);
    expect(b.content).toContain("答案是不能 #Transformer");
    expect(b.content).toContain("https://sns-img.xhscdn.com/2.jpg");
    expect(b.coverUrl).toBe("https://sns-img.xhscdn.com/1.jpg");
  });

  test("the logged-out error page fails instead of being stored", async () => {
    const b = await saveRendered(
      "https://www.xiaohongshu.com/404?source=/404/sec_abc",
      "<html><head><title>小红书 - 你访问的页面不见了</title></head><body><nav>发现 直播 发布</nav><footer>行吟信息科技（上海）有限公司</footer></body></html>",
    );
    expect(b.contentStatus).toBe("failed");
    expect(b.contentError).toContain("needs a login");
    expect(b.contentError).toContain("extension");
  });
});

describe("weibo", () => {
  const pic = (id: string) => ({
    url: `https://wx1.sinaimg.cn/orj360/${id}.jpg`,
    large: { url: `https://wx1.sinaimg.cn/large/${id}.jpg`, geo: { width: 2048, height: 1024 } },
  });
  const status = {
    mid: "5363614907110043",
    created_at: "Tue Nov 10 08:01:48 +0800 2026",
    text:
      "投机解码又有新活<span class='url-icon'><img alt='[doge]' src='https://face.t.sinajs.cn/d.png'></span><br />第二行 " +
      "<a href='https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.com%2Fpaper'><span class='url-icon'><img src='https://h5.sinaimg.cn/upload/2015/09/25/3/timeline_card_small_web_default.png'></span><span class=\"surl-text\">网页链接</span></a>",
    user: { screen_name: "karminski-牙医" },
    pics: ["a1", "a2", "a3"].map(pic),
    page_info: {
      type: "webpage",
      page_url: "https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.com%2Fpaper",
      content1: "论文标题",
      page_pic: { url: "https://img.t.sinajs.cn/t6/style/images/face/face_card_longwb.png" },
    },
    retweeted_status: {
      text: "被转发的微博",
      user: { screen_name: "原作者" },
      pics: [pic("b1")],
    },
  };

  test("finds the post in status URLs only", async () => {
    const id = (u: string) => weiboPostId(new URL(u));
    expect(id("https://weibo.com/1727858283/QlZC28yte")).toBe("QlZC28yte");
    expect(id("https://weibo.com/1788911247/5157064956185380?wm=3333_2001")).toBe(
      "5157064956185380",
    );
    expect(id("https://m.weibo.cn/status/5112891411534437?jumpfrom=weibocom")).toBe(
      "5112891411534437",
    );
    expect(id("https://m.weibo.cn/detail/5363614907110043")).toBe("5363614907110043");
    expect(id("https://weibo.com/u/1727858283")).toBeNull();
    expect(id("https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.com")).toBeNull();
    expect(siteFor("https://mapp.api.weibo.cn/fx/e8.html")?.name).toBe("weibo");
  });

  /** A fetcher answering share-link hops and the statuses API from canned responses. */
  function stub(api: object | string) {
    const calls: string[] = [];
    const fetcher = {
      fetchText: async (url: string): Promise<TextResponse> => {
        calls.push(url);
        const share = url.includes("/fx/");
        return {
          status: 200,
          text: share
            ? "<html>Sina Visitor System</html>"
            : typeof api === "string"
              ? api
              : JSON.stringify(api),
          contentType: share ? "text/html" : "application/json",
          finalUrl: share
            ? `https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&url=${encodeURIComponent("https://m.weibo.cn/status/5363614907110043")}`
            : url,
          headers: new Headers(),
        };
      },
    } as unknown as Fetcher;
    return { calls, ctx: { fetcher, githubToken: null } };
  }

  test("fetches a share link's post from the API", async () => {
    const { calls, ctx } = stub({ ok: 1, data: status });
    const r = await weibo.fetch!(new URL("https://mapp.api.weibo.cn/fx/e8.html"), ctx);
    expect(calls[1]).toBe("https://m.weibo.cn/statuses/show?id=5363614907110043");
    expect(r?.kind === "html" && r.finalUrl).toBe("https://m.weibo.cn/detail/5363614907110043");
  });

  test("a hidden post fails with Weibo's reason; a login redirect falls back", async () => {
    const url = new URL("https://weibo.com/1/5075630316325401");
    await expect(
      weibo.fetch!(url, stub({ ok: 0, msg: "由于博主设置，目前内容暂不可见。" }).ctx),
    ).rejects.toThrow("Weibo: 由于博主设置");
    expect(await weibo.fetch!(url, stub("<html>login</html>").ctx)).toBeNull();
  });

  test("a rendered page keeps every full-size picture, the retweet and the link", async () => {
    // What the headless browser returns: the post as $render_data, and the
    // pictures in an image-only list Defuddle would drop.
    const b = await saveRendered(
      "https://m.weibo.cn/status/5363614907110043",
      `<html><head><title>微博</title></head><body><article class="weibo-main">
<div class="weibo-text">投机解码又有新活</div>
<ul class="m-auto-list">${["a1", "a2", "a3"].map((p) => `<li><img src="https://wx1.sinaimg.cn/orj360/${p}.jpg"></li>`).join("")}</ul>
</article><script>var $render_data = [${JSON.stringify({ status })}][0] || {};</script></body></html>`,
    );
    expect([b.contentStatus, b.extractor, b.title, b.author]).toEqual([
      "ok",
      "weibo",
      "投机解码又有新活[doge]",
      "karminski-牙医",
    ]);
    expect(b.publishedAt).toStartWith("2026-11-10T00:01:48");
    for (const p of ["a1", "a2", "a3", "b1"]) {
      expect(b.content).toContain(`https://wx1.sinaimg.cn/mw2000/${p}.jpg`);
    }
    expect(b.coverUrl).toBe("https://wx1.sinaimg.cn/mw2000/a1.jpg");
    expect(b.content).toContain("被转发的微博");
    expect(b.content).toContain("@原作者");
    expect(b.content).toContain("[论文标题](https://example.com/paper)");
    expect(b.content).toContain("[网页链接](https://example.com/paper)");
    expect(b.content).not.toContain("sinajs.cn");
    expect(b.content).not.toContain("timeline_card");
  });
});

describe("weibo short posts", () => {
  test("a one-line caption over pictures is the whole post, not an empty page", async () => {
    const status = {
      text: "叶思福走进了大家的视野。",
      user: { screen_name: "峰哥" },
      pics: [{ large: { url: "https://wx1.sinaimg.cn/large/c1.jpg" } }],
    };
    const b = await saveRendered(
      "https://m.weibo.cn/status/5210175868244096",
      `<html><body><script>var $render_data = [${JSON.stringify({ status })}][0] || {};</script></body></html>`,
    );
    expect([b.contentStatus, b.extractor]).toEqual(["ok", "weibo"]);
    expect(b.content).toContain("https://wx1.sinaimg.cn/mw2000/c1.jpg");
  });
});

describe("zhihu", () => {
  test("a wall fails at once with advice, without trying a browser", async () => {
    const b = await saveRendered(
      "https://zhuanlan.zhihu.com/p/1",
      "<html><head><title>知乎</title></head><body><p>您当前请求存在异常，暂时限制本次访问。</p></body></html>",
    );
    expect(b.contentStatus).toBe("failed");
    expect(b.contentError).toContain("save it from your browser");
  });
});

describe("v2ex", () => {
  test("keeps the replies with the topic", async () => {
    const b = await saveRendered(
      "https://www.v2ex.com/t/1091252",
      `<html><head><title>Mac 自动开启 VPN - V2EX</title></head><body><div id="Main">
<div class="box"><div class="header"><h1>Mac 自动开启 VPN</h1></div>
<div class="cell"><div class="topic_content"><div class="markdown_body">${filler("shortcuts automation")}</div></div></div>
<div class="subtle"><span class="fade">第 1 条附言 · 1 天前</span><div class="topic_content">已解决，谢谢</div></div></div>
<div class="box"><div id="r_1" class="cell"><strong><a href="/member/J3ho" class="dark">J3ho</a></strong>
<span class="no">1</span><div class="reply_content">试试 shortery</div></div></div>
<div id="Rightbar">热门节点</div></div></body></html>`,
    );
    expect([b.contentStatus, b.extractor]).toEqual(["ok", "v2ex"]);
    expect(b.content).toContain("shortcuts automation");
    expect(b.content).toContain("已解决");
    expect(b.content).toContain("#1 J3ho");
    expect(b.content).toContain("试试 shortery");
    expect(b.content).not.toContain("热门节点");
  });
});

describe("generic fallbacks", () => {
  test("a 403 for our Chrome user agent is retried with an honest one", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/cf-wall` });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}?content=text`)).data;
    expect(b.contentStatus).toBe("ok");
    expect(b.content).toContain("sourdough");
  });

  test("pages without an adapter are untouched", async () => {
    const b = await saveRendered("https://example.org/post", ARTICLE_HTML);
    expect([b.contentStatus, b.title, b.extractor]).toEqual(["ok", "Sourdough Science", null]);
  });
});
