import { unwrapUrl } from "@lofu/shared";
import { FetchError, type FetchResult } from "../fetch.ts";
import type { SiteAdapter, SiteDocument, SiteElement } from "./types.ts";

interface Pic {
  url?: string;
  large?: { url?: string; geo?: { width?: number | string; height?: number | string } };
}

interface Status {
  id?: string;
  mid?: string;
  bid?: string;
  text?: string;
  created_at?: string;
  isLongText?: boolean;
  user?: { screen_name?: string } | null;
  pics?: Pic[];
  page_info?: {
    type?: string;
    page_url?: string;
    page_title?: string;
    content1?: string;
    page_pic?: { url?: string };
  } | null;
  retweeted_status?: Status | null;
}

/** A post's id in a status URL: numeric (mid) or base62 (bid), both accepted by the API. */
const POST_ID = /^(\d{10,20}|[0-9A-Za-z]{9})$/;

/** The post a URL points at, or null for anything else (profiles, wrappers, search). */
export function weiboPostId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const [a, b] = url.pathname.split("/").filter(Boolean);
  if (host !== "weibo.com" && host !== "www.weibo.com" && host !== "m.weibo.cn") return null;
  if (a === "status" || a === "detail") return b && POST_ID.test(b) ? b : null;
  // weibo.com/<uid>/<id>
  return a && /^\d+$/.test(a) && b && POST_ID.test(b) ? b : null;
}

/** Share links (`mapp.api.weibo.cn/fx/….html`) redirect to the post. */
const isShareLink = (url: URL) =>
  url.hostname === "mapp.api.weibo.cn" && url.pathname.startsWith("/fx/");

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
/** m.weibo.cn's JSON endpoints answer XHRs without the visitor check pages get. */
const API = {
  userAgent: MOBILE_UA,
  headers: {
    accept: "application/json",
    referer: "https://m.weibo.cn/",
    "x-requested-with": "XMLHttpRequest",
  },
};

/** Marks the HTML `fetch` builds, so `transform` reads the post from it. */
const STATUS_SCRIPT_ID = "lofu-weibo-status";

/** The post in the page: ours from `fetch`, or the m.weibo.cn page's `$render_data`. */
function statusFrom(doc: SiteDocument): Status | null {
  const own = doc.querySelector(`script#${STATUS_SCRIPT_ID}`)?.textContent;
  if (own) {
    try {
      return JSON.parse(own) as Status;
    } catch {
      return null;
    }
  }
  for (const s of doc.querySelectorAll("script:not([src])")) {
    const js = s.textContent ?? "";
    const at = js.indexOf("var $render_data = ");
    if (at < 0) continue;
    const end = js.indexOf("[0] || {}", at);
    if (end < 0) return null;
    try {
      const data = JSON.parse(js.slice(at + 19, end)) as { status?: Status }[];
      return data[0]?.status ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Plain text of Weibo's post HTML, for the title and excerpt. */
function plainText(doc: SiteDocument, html: string): string {
  const el = doc.createElement("div");
  el.innerHTML = html.replace(/<br\s*\/?>/gi, "\n");
  cleanText(el);
  return (el.textContent ?? "").replace(/[ \t]+/g, " ").trim();
}

/** Emoji images become their `[name]`, link-card icons go, links skip Weibo's redirect page. */
function cleanText(el: SiteElement) {
  for (const icon of el.querySelectorAll(".url-icon")) {
    const alt = icon.querySelector("img")?.getAttribute("alt");
    icon.replaceWith(alt ?? "");
  }
  for (const a of el.querySelectorAll("a[href]")) {
    a.setAttribute("href", unwrapUrl(a.getAttribute("href")!));
  }
}

/**
 * The full-size version of a picture on Weibo's image hosts, which serve any
 * size from the same path (`/orj480/x.jpg` → `/mw2000/x.jpg`). Null for
 * anything else: link cards use icons from img.t.sinajs.cn as pictures.
 */
function fullSize(src: string | undefined): string | null {
  if (!src || !URL.canParse(src)) return null;
  const u = new URL(src);
  if (!u.hostname.endsWith(".sinaimg.cn")) return null;
  u.pathname = u.pathname.replace(
    /^\/(orj\d+|thumb\d+|bmiddle|small|square|mw\d+|large)\//,
    "/mw2000/",
  );
  return u.href;
}

function appendPost(doc: SiteDocument, into: SiteElement, status: Status) {
  const body = doc.createElement("div");
  body.innerHTML = status.text ?? "";
  cleanText(body);
  into.append(body);

  for (const pic of status.pics ?? []) {
    const src = fullSize(pic.large?.url || pic.url);
    if (!src) continue;
    const img = doc.createElement("img");
    img.setAttribute("src", src);
    const { width, height } = pic.large?.geo ?? {};
    if (width && height) {
      img.setAttribute("width", String(width));
      img.setAttribute("height", String(height));
    }
    // One per paragraph: Defuddle drops a list of only images as metadata.
    const p = doc.createElement("p");
    p.append(img);
    into.append(p);
  }

  const page = status.page_info;
  if (
    page?.page_url &&
    (page.type === "article" || page.type === "video" || page.type === "webpage")
  ) {
    const p = doc.createElement("p");
    const pic = fullSize(page.page_pic?.url);
    if (pic) {
      const img = doc.createElement("img");
      img.setAttribute("src", pic);
      p.append(img, doc.createElement("br"));
    }
    const a = doc.createElement("a");
    a.setAttribute("href", unwrapUrl(page.page_url));
    a.textContent = page.content1 || page.page_title || page.page_url;
    p.append(a);
    into.append(p);
  }
}

const parseDate = (s: string | undefined) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** The first line of the post, shortened, as a title (posts have none). */
function titleOf(text: string): string | null {
  const line = text
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return null;
  const chars = [...line];
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : line;
}

/**
 * Weibo posts. Pages are a JavaScript app behind a visitor check, and the
 * rendered page puts the pictures in an image-only list that Defuddle drops
 * as "metadata", while the text it keeps has emoji and link-card icons for
 * images. So the post comes from m.weibo.cn's JSON API (or, in a page the
 * browser rendered, its `$render_data` copy of the same JSON) and is rebuilt
 * as text, full-size pictures, a retweet and a link card.
 *
 * Desktop weibo.com pages from the extension have neither and fall back to
 * the generic path.
 */
export const weibo: SiteAdapter = {
  name: "weibo",
  hosts: ["weibo.com", "weibo.cn"],

  async fetch(url, { fetcher }): Promise<FetchResult | null> {
    let id = weiboPostId(url);
    if (!id && isShareLink(url)) {
      // Lands on the post, or on the visitor check with the post in `url=`.
      const landed = new URL(
        (await fetcher.fetchText(url.href, { userAgent: MOBILE_UA })).finalUrl,
      );
      const target = landed.searchParams.get("url");
      id = weiboPostId(target && URL.canParse(target) ? new URL(target) : landed);
    }
    if (!id) return null;

    const res = await fetcher.fetchText(`https://m.weibo.cn/statuses/show?id=${id}`, API);
    let body: { ok?: number; msg?: string; data?: Status };
    try {
      body = JSON.parse(res.text);
    } catch {
      // A redirect to a login or visitor page: let the generic path and the browser try.
      return null;
    }
    if (body.ok !== 1 || !body.data) {
      // "暂无查看权限", "由于博主设置，目前内容暂不可见。", deleted posts.
      if (body.msg) throw new FetchError(`Weibo: ${body.msg}`, true);
      return null;
    }
    const status = body.data;
    if (status.isLongText && status.text?.includes(">全文<")) {
      const long = await fetcher.fetchText(`https://m.weibo.cn/statuses/extend?id=${id}`, API);
      try {
        const text = (JSON.parse(long.text) as { data?: { longTextContent?: string } }).data
          ?.longTextContent;
        if (text) status.text = text;
      } catch {}
    }
    const json = JSON.stringify(status).replace(/</g, "\\u003c");
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="application/json" id="${STATUS_SCRIPT_ID}">${json}</script></body></html>`;
    return {
      kind: "html",
      html,
      finalUrl: `https://m.weibo.cn/detail/${status.mid ?? status.id ?? id}`,
      bytes: Buffer.byteLength(html),
    };
  },

  transform(doc) {
    const status = statusFrom(doc);
    if (!status?.text && !status?.pics?.length) return null;

    const article = doc.createElement("article");
    appendPost(doc, article, status);
    const rt = status.retweeted_status;
    if (rt) {
      const quote = doc.createElement("blockquote");
      if (rt.user?.screen_name) {
        const who = doc.createElement("p");
        who.textContent = `@${rt.user.screen_name}`;
        quote.append(who);
      }
      appendPost(doc, quote, rt);
      article.append(quote);
    }
    doc.body.replaceChildren(article);

    const text = plainText(doc, status.text ?? "");
    const firstPic = status.pics?.[0] ?? rt?.pics?.[0];
    return {
      complete: true,
      meta: {
        title: titleOf(text) ?? (rt ? titleOf(plainText(doc, rt.text ?? "")) : null),
        author: status.user?.screen_name || null,
        publishedAt: parseDate(status.created_at),
        excerpt: text.replace(/\s+/g, " ").slice(0, 280) || null,
        coverUrl:
          fullSize(firstPic?.large?.url || firstPic?.url) ??
          fullSize(status.page_info?.page_pic?.url),
      },
    };
  },
};
