import { HONEST_USER_AGENT } from "../fetch.ts";
import type { SiteAdapter } from "./types.ts";

/**
 * V2EX sits behind Cloudflare, which challenges our Chrome user agent (and
 * headless Chromium) but serves an honest client the full topic. Defuddle
 * keeps only the topic body; the replies, often the useful part of a
 * thread, are kept too (the first page of them).
 */
export const v2ex: SiteAdapter = {
  name: "v2ex",
  hosts: ["v2ex.com"],
  request: { userAgent: HONEST_USER_AGENT },

  transform(doc, url) {
    if (!/^\/t\/\d+/.test(url.pathname)) return null;
    const topic = doc.querySelector(".topic_content");
    const replies = [...doc.querySelectorAll('div.cell[id^="r_"]')];
    if (!topic && replies.length === 0) return null;

    const article = doc.createElement("article");
    const title = doc.querySelector(".header h1")?.textContent?.trim();
    if (title) {
      const h1 = doc.createElement("h1");
      h1.textContent = title;
      article.append(h1);
    }
    if (topic) article.append(topic);
    // Appendices the author added later ("第 1 条附言").
    for (const extra of doc.querySelectorAll(".subtle")) {
      const body = extra.querySelector(".topic_content");
      if (!body) continue;
      const h = doc.createElement("h3");
      h.textContent = extra.querySelector(".fade")?.textContent?.split("·")[0]?.trim() || "附言";
      article.append(h, body);
    }
    if (replies.length) {
      const h2 = doc.createElement("h2");
      h2.textContent = `${replies.length} replies`;
      article.append(h2);
      for (const cell of replies) {
        const content = cell.querySelector(".reply_content");
        if (!content) continue;
        const who = cell.querySelector("strong a.dark")?.textContent?.trim() ?? "";
        const section = doc.createElement("section");
        const p = doc.createElement("p");
        const strong = doc.createElement("strong");
        strong.textContent =
          `#${cell.querySelector(".no")?.textContent?.trim() ?? ""} ${who}`.trim();
        p.append(strong);
        const body = doc.createElement("div");
        body.innerHTML = content.innerHTML;
        section.append(p, body);
        article.append(section);
      }
    }
    doc.body.replaceChildren(article);
    return {};
  },
};
