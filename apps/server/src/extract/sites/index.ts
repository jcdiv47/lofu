import { github } from "./github.ts";
import type { SiteAdapter } from "./types.ts";
import { v2ex } from "./v2ex.ts";
import { wechat } from "./wechat.ts";
import { xiaohongshu } from "./xiaohongshu.ts";
import { zhihu } from "./zhihu.ts";

export type {
  SiteAdapter,
  SiteContext,
  SiteDocument,
  SiteElement,
  SiteMeta,
  SiteTransform,
} from "./types.ts";

export const SITES: readonly SiteAdapter[] = [github, wechat, xiaohongshu, zhihu, v2ex];

const byHost = new Map(SITES.flatMap((s) => s.hosts.map((h) => [h, s] as const)));

/** The adapter for a URL's host or its nearest parent domain, if any. */
export function siteFor(url: string | URL): SiteAdapter | null {
  let host: string;
  try {
    host = (typeof url === "string" ? new URL(url) : url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (;;) {
    const site = byHost.get(host);
    if (site) return site;
    const dot = host.indexOf(".");
    if (dot < 0) return null;
    host = host.slice(dot + 1);
  }
}
