import type { SiteAdapter, SiteDocument } from "./types.ts";

const LOGIN_WALL = "Xiaohongshu note needs a login";

interface Note {
  title?: string;
  desc?: string;
  time?: number;
  type?: string;
  user?: { nickname?: string };
  imageList?: { urlDefault?: string; url?: string; infoList?: { url?: string }[] }[];
}

/** The note in the page's server-rendered state, if the page has one. */
function noteFrom(doc: SiteDocument): Note | null {
  for (const s of doc.querySelectorAll("script:not([src])")) {
    const js = s.textContent ?? "";
    const at = js.indexOf("window.__INITIAL_STATE__=");
    if (at < 0) continue;
    try {
      // Not JSON: `undefined` appears as a value.
      const state = JSON.parse(
        js.slice(at + 25).replace(/([:[,])undefined(?=[,}\]])/g, "$1null"),
      ) as { note?: { noteDetailMap?: Record<string, { note?: Note }> } };
      for (const entry of Object.values(state.note?.noteDetailMap ?? {})) {
        if (entry?.note?.title || entry?.note?.desc) return entry.note;
      }
    } catch {}
    return null;
  }
  return null;
}

const imageUrl = (img: NonNullable<Note["imageList"]>[number]) =>
  img.urlDefault || img.url || img.infoList?.find((i) => i.url)?.url || null;

/**
 * Xiaohongshu (RED) notes. The page is an app shell; the note (text, images,
 * author) sits in `window.__INITIAL_STATE__`. Without a logged-in session
 * the site redirects notes to a `/404/sec_…` page, so only the extension can
 * save them; a fetched one fails instead of storing the error page.
 */
export const xiaohongshu: SiteAdapter = {
  name: "xiaohongshu",
  hosts: ["xiaohongshu.com", "xhslink.com"],
  noBrowser: "save it from a logged-in browser with the extension",

  transform(doc, url) {
    const path = url.pathname;
    if (path === "/" || path.startsWith("/404") || path.startsWith("/website-login")) {
      return { blocked: LOGIN_WALL };
    }
    const note = noteFrom(doc);
    if (!note) {
      const isNote = /^\/(explore|discovery\/item|user\/profile\/[^/]+)\/[\da-f]{24}/.test(path);
      return isNote ? { blocked: LOGIN_WALL } : null;
    }

    const article = doc.createElement("article");
    if (note.title) {
      const h1 = doc.createElement("h1");
      h1.textContent = note.title;
      article.append(h1);
    }
    // Hashtags are written `#tag[话题]#`.
    const desc = (note.desc ?? "").replace(/#([^#[\]]+)\[话题\]#/g, "#$1");
    for (const para of desc.split(/\n+/)) {
      if (!para.trim()) continue;
      const p = doc.createElement("p");
      p.textContent = para;
      article.append(p);
    }
    const images = (note.imageList ?? []).map(imageUrl).filter((u): u is string => !!u);
    for (const src of images) {
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      article.append(img);
    }
    doc.body.replaceChildren(article);
    return {
      meta: {
        title: note.title || null,
        author: note.user?.nickname || null,
        publishedAt: note.time ? new Date(note.time).toISOString() : null,
        coverUrl: images[0] ?? null,
        excerpt: desc.trim().slice(0, 280) || null,
      },
    };
  },
};
