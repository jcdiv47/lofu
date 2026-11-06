import type { SiteAdapter, SiteMeta } from "./types.ts";

const scriptVar = (js: string, name: string) =>
  new RegExp(`var ${name}\\s*=\\s*(?:htmlDecode\\()?(["'])(.*?)\\1`).exec(js)?.[2]?.trim() || null;

/**
 * WeChat Official Account articles (mp.weixin.qq.com). The article body is
 * `#js_content`, hidden until a script reveals it and with lazy images in
 * `data-src`. Around it sit the account card, reward and "read in the novel
 * reader" widgets that Defuddle would keep. Author and publish time exist
 * only as script variables.
 *
 * The captcha WeChat serves to bursts is a rate limit, handled in blocked.ts
 * and the extract job.
 */
export const wechat: SiteAdapter = {
  name: "wechat",
  hosts: ["mp.weixin.qq.com"],

  transform(doc) {
    const js = [...doc.querySelectorAll("script:not([src])")]
      .map((s) => s.textContent ?? "")
      .filter((t) => t.includes("var ct") || t.includes("var nickname"))
      .join("\n");
    const decode = (s: string | null) => {
      if (!s) return null;
      const el = doc.createElement("textarea");
      el.innerHTML = s;
      return el.textContent?.trim() || null;
    };
    const text = (sel: string) => doc.querySelector(sel)?.textContent?.trim() || null;

    const seconds = Number(scriptVar(js, "ct") ?? scriptVar(js, "create_time"));
    const meta: SiteMeta = {
      title: text("#activity-name"),
      author:
        decode(scriptVar(js, "author")) ??
        text("#js_author_name") ??
        decode(scriptVar(js, "nickname")) ??
        text("#js_name"),
      publishedAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    };

    const content = doc.querySelector("#js_content");
    // Picture posts and video pages have no #js_content: keep the metadata only.
    if (!content) return { meta };
    content.removeAttribute("style");
    for (const img of content.querySelectorAll("img[data-src]")) {
      img.setAttribute("src", img.getAttribute("data-src")!);
    }
    const article = doc.createElement("article");
    if (meta.title) {
      const h1 = doc.createElement("h1");
      h1.textContent = meta.title;
      article.append(h1);
    }
    article.append(content);
    doc.body.replaceChildren(article);
    return { meta };
  },
};
