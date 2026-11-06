import type { SiteAdapter, SiteElement } from "./types.ts";

/** First path segments that are GitHub pages, not users or orgs. */
const RESERVED = new Set([
  "about",
  "apps",
  "collections",
  "enterprise",
  "explore",
  "features",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "pricing",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

const NAME = /^[\w.-]+$/;

/** `{owner, repo}` when the URL is a repository's home page. */
export function repoRoot(url: URL): { owner: string; repo: string } | null {
  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (RESERVED.has(owner.toLowerCase()) || !NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

const README_MARK = "data-lofu-readme";

/** URLs that are already absolute, protocol-relative or in-page anchors. */
const KEEP = /^([a-z][a-z\d+.-]*:|\/\/|#)/i;

/**
 * GitHub repositories. The repo page is a React app that loads its README
 * after the HTML arrives, so a fetched page holds only the file list and the
 * sidebar. The README comes from the API instead, already rendered, and is
 * spliced into the page so the page's own metadata (title, description,
 * social image) is kept. Files (`/blob/`) are fetched raw.
 *
 * Issues, PRs and discussions are left to Defuddle's own GitHub extractor.
 */
export const github: SiteAdapter = {
  name: "github",
  hosts: ["github.com"],

  async fetch(url, ctx) {
    const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (url.hostname === "github.com" && blob) {
      // Redirects to raw.githubusercontent.com with the file's own content type.
      return ctx.fetcher.fetch(`https://github.com/${blob[1]}/${blob[2]}/raw/${blob[3]}`);
    }
    const root = repoRoot(url);
    if (!root) return null;

    const headers: Record<string, string> = {
      accept: "application/vnd.github.html",
      "x-github-api-version": "2022-11-28",
    };
    if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;
    const [page, readme] = await Promise.all([
      ctx.fetcher.fetch(url.href),
      ctx.fetcher.fetchText(`https://api.github.com/repos/${root.owner}/${root.repo}/readme`, {
        headers,
      }),
    ]);
    if (page.kind !== "html") return page;
    if (readme.status === 404) return page; // no README: the file list is all there is
    if (readme.status === 403 || readme.status === 429) {
      // Unauthenticated, the API allows 60 requests an hour per IP. Retry later
      // rather than store the README-less page as the final result.
      const reset = Number(readme.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const wait = reset > Date.now() ? ` until ${new Date(reset).toISOString()}` : "";
      throw new Error(`GitHub API rate limit${wait} (set LOFU_GITHUB_TOKEN to raise it)`);
    }
    // A bad token or a GitHub outage: retry rather than store the page without its README.
    if (readme.status !== 200) throw new Error(`GitHub API: HTTP ${readme.status} for the README`);

    const block = `<div ${README_MARK}>${readme.text}</div>`;
    const at = page.html.lastIndexOf("</body>");
    const html = at < 0 ? page.html + block : page.html.slice(0, at) + block + page.html.slice(at);
    return { ...page, html, bytes: page.bytes + Buffer.byteLength(readme.text) };
  },

  transform(doc, url) {
    const root = repoRoot(url);
    if (!root) return null;
    // Ours from the API, or the one a real browser rendered (extension saves).
    const readme =
      doc.querySelector(`[${README_MARK}] article.markdown-body`) ??
      doc.querySelector("article.markdown-body");
    if (!readme) return null;

    // README links are relative to the repo root: images to the raw file,
    // links to the file's page.
    const base = `https://github.com/${root.owner}/${root.repo}`;
    const absolutize = (el: SiteElement, attr: string, prefix: string) => {
      const v = el.getAttribute(attr);
      if (!v || KEEP.test(v)) return;
      try {
        el.setAttribute(attr, new URL(v, prefix).href);
      } catch {}
    };
    for (const img of readme.querySelectorAll("img[src]"))
      absolutize(img, "src", `${base}/raw/HEAD/`);
    for (const a of readme.querySelectorAll("a[href]")) absolutize(a, "href", `${base}/blob/HEAD/`);

    // Keep only the repo's description and its README: the file table and
    // sidebar would otherwise outscore the README or be extracted with it.
    const about =
      doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? "";
    const article = doc.createElement("article");
    if (about) {
      const p = doc.createElement("p");
      p.textContent = about;
      article.append(p);
    }
    article.append(readme);
    doc.body.replaceChildren(article);
    return {};
  },
};
