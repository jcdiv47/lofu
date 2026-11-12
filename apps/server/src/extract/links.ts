import { isRedirectLink, unwrapUrl } from "@lofu/shared";
import { HONEST_USER_AGENT } from "./fetch.ts";
import { assertPublicUrl, type FetchFn } from "./netguard.ts";

/** One hop, off private networks. */
const publicHop: FetchFn = async (url, init) => {
  await assertPublicUrl(url);
  return fetch(url, init);
};

const MAX_HOPS = 6;
/** Interstitial pages are small; a shortener answering with a whole page is done. */
const MAX_BODY = 64 * 1024;

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/\\\//g, "/");

/** Where a short link's page sends the browser: a meta refresh or a script. */
export function pageRedirect(html: string, base: string): string | null {
  const patterns = [
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=['"]?([^"'>\s]+)/i,
    /<meta[^>]+content=["'][^"']*?url=['"]?([^"'>\s]+)[^>]*http-equiv=["']?refresh/i,
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']/i,
    /(?:window|document|top)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (!m?.[1]) continue;
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {}
  }
  return null;
}

/**
 * The page a short link (t.co, t.cn, xhslink.com…) or a wrapper
 * (`weibo.cn/sinaurl?u=…`) leads to, so the bookmark is the article rather
 * than the hop, and saving both finds one bookmark. Follows redirects one at
 * a time and stops at the first host that isn't a redirect, so the article
 * itself is never downloaded here. Anything that goes wrong (a timeout, a dead
 * link, a hop to a site's home page) leaves the link as it was given.
 */
export async function resolveLink(
  url: string,
  opts: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<string> {
  const fetchFn = opts.fetch ?? publicHop;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 6000);
  let current = unwrapUrl(url);
  try {
    for (let hop = 0; hop < MAX_HOPS && isRedirectLink(current); hop++) {
      const res = await fetchFn(current, {
        redirect: "manual",
        signal: deadline,
        headers: { "user-agent": HONEST_USER_AGENT, accept: "text/html,*/*;q=0.8" },
      });
      let next: string | null = null;
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        next = new URL(location, current).href;
        void res.body?.cancel();
      } else if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
        next = pageRedirect((await res.text()).slice(0, MAX_BODY), current);
      } else {
        void res.body?.cancel();
      }
      if (!next || next === current) break;
      current = unwrapUrl(next);
    }
  } catch {
    // Keep what was resolved so far.
  }
  return landedHome(url, current) ? url : current;
}

/** Sites whose short links land on their home page or a login wall when the post is gone or hidden. */
const OWN_SITES = new Set([
  "x.com",
  "twitter.com",
  "weibo.com",
  "weibo.cn",
  "xiaohongshu.com",
  "bilibili.com",
  "douyin.com",
]);

/**
 * A short link that ends on an error or login page, or on its own site's home
 * page, expired or hit a wall: keeping the short link at least says what was
 * shared (and the extension can still save the page itself).
 */
function landedHome(original: string, resolved: string): boolean {
  if (original === resolved) return false;
  try {
    const r = new URL(resolved);
    if (/^\/(404|login|signin|website-login|passport)\b/i.test(r.pathname)) return true;
    const host = r.hostname.toLowerCase().replace(/^www\./, "");
    const own = [...OWN_SITES].some((s) => host === s || host.endsWith(`.${s}`));
    return own && r.pathname === "/";
  } catch {
    return true;
  }
}
