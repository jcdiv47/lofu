/**
 * Finding the page a shared or pasted link means: the link inside share text
 * ("【Title】 http://xhslink.com/a/xyz 复制本条信息…"), the target inside a
 * site's "you are leaving" wrapper (`weibo.cn/sinaurl?u=…`), and which hosts
 * only redirect (t.co, t.cn), so the server follows them before it saves.
 *
 * Pure functions, no network: the reader app (QuickJS) uses them too.
 */

/** Characters a link never contains in share text: spaces, CJK punctuation, quotes. */
const STOP =
  "\\s<>\"'`\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\u2018-\\u201f\\u4e00-\\u9fff";
const WITH_SCHEME = new RegExp(`https?://[^${STOP}]+`, "i");
/** `www.example.com/…` or `xhslink.com/a/xyz`: a host with a dot, then a path or `www.`. */
const BARE = new RegExp(
  `(?:^|[${STOP}(])((?:[a-z0-9-]+\\.)+[a-z]{2,}(?::\\d+)?(?:/[^${STOP}]*)?)`,
  "i",
);

/** Drops the punctuation a sentence puts after a link, keeping balanced brackets. */
function trimTail(url: string): string {
  let u = url;
  for (;;) {
    const last = u.at(-1) ?? "";
    if (/[.,;:!?'"*]/.test(last)) u = u.slice(0, -1);
    else if (last === ")" && count(u, "(") < count(u, ")")) u = u.slice(0, -1);
    else if (last === "]" && count(u, "[") < count(u, "]")) u = u.slice(0, -1);
    else return u;
  }
}
const count = (s: string, ch: string) => s.split(ch).length - 1;

const isHttp = (s: string) => {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
};

/**
 * The first web link in `text`, or null. Links without a scheme count when
 * they start with `www.`, have a path, or are all of the text, so a sentence
 * that mentions "e.g." or "Node.js" doesn't become a link.
 */
export function extractUrl(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // One link and nothing else: as it is, CJK path and all.
  if (!/\s/.test(t) && /^https?:\/\//i.test(t) && isHttp(t)) return t;
  const m = WITH_SCHEME.exec(t);
  if (m) {
    const u = trimTail(m[0]);
    if (isHttp(u)) return u;
  }
  const b = BARE.exec(t);
  if (b?.[1]) {
    const raw = trimTail(b[1]);
    const host = raw.split(/[/:]/)[0] ?? "";
    const plausible = raw === t || raw.includes("/") || host.toLowerCase().startsWith("www.");
    if (plausible && /\.[a-z]{2,}$/i.test(host) && isHttp(`https://${raw}`))
      return `https://${raw}`;
  }
  return null;
}

/** Wrapper pages that carry the real link in a query parameter: host → path prefix and params. */
const WRAPPERS: Record<string, { path?: string; params: string[] }> = {
  "weibo.cn": { path: "/sinaurl", params: ["u", "toasturl"] },
  "m.weibo.cn": { path: "/sinaurl", params: ["u", "toasturl"] },
  "link.zhihu.com": { params: ["target"] },
  "link.juejin.cn": { params: ["target"] },
  "link.csdn.net": { params: ["target"] },
  "jianshu.com": { path: "/go-wild", params: ["url"] },
  "douban.com": { path: "/link2", params: ["url"] },
  "google.com": { path: "/url", params: ["q", "url"] },
  "youtube.com": { path: "/redirect", params: ["q"] },
  "l.facebook.com": { path: "/l.php", params: ["u"] },
  "lm.facebook.com": { path: "/l.php", params: ["u"] },
  "l.instagram.com": { params: ["u"] },
  "out.reddit.com": { params: ["url"] },
  "steamcommunity.com": { path: "/linkfilter", params: ["url", "u"] },
  "t.umblr.com": { path: "/redirect", params: ["z"] },
};

const bareHost = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");

/** The link a wrapper page leads to (`weibo.cn/sinaurl?u=…` → its `u`), or `url` itself. */
export function unwrapUrl(url: string): string {
  let current = url;
  for (let i = 0; i < 3; i++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return current;
    }
    const w = WRAPPERS[bareHost(u)];
    if (!w || (w.path && !u.pathname.startsWith(w.path))) return current;
    let next: string | null = null;
    for (const p of w.params) {
      let v = u.searchParams.get(p);
      if (v && /^https?%3a/i.test(v)) v = decodeURIComponent(v);
      if (v && isHttp(v)) {
        next = v;
        break;
      }
    }
    if (!next) return current;
    current = next;
  }
  return current;
}

/** Hosts that only redirect: a saved bookmark should be where they lead. */
const SHORTENERS = new Set([
  "t.co",
  "t.cn",
  "xhslink.com",
  "b23.tv",
  "v.douyin.com",
  "url.cn",
  "dwz.cn",
  "sourl.cn",
  "bit.ly",
  "j.mp",
  "tinyurl.com",
  "ow.ly",
  "buff.ly",
  "is.gd",
  "lnkd.in",
  "dlvr.it",
  "goo.gl",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "t.ly",
  "tiny.cc",
  "reurl.cc",
  "amzn.to",
  "a.co",
]);

/** Whether `url` is a short link or a wrapper page, which the server follows before saving. */
export function isRedirectLink(url: string): boolean {
  try {
    const u = new URL(url);
    return SHORTENERS.has(bareHost(u)) || unwrapUrl(url) !== url;
  } catch {
    return false;
  }
}
