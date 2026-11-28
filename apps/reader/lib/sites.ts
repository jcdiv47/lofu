import { Storage, signal } from "nsh";
import { onSite, siteDomain } from "../../../packages/shared/src/url";
import { api, type Bookmark } from "./api";

export { siteDomain };

const KEY = "sites.v1";

/**
 * Sites whose bookmarks open as the page itself, with no reader (Settings ›
 * Open as web pages). Kept on the server for every device, and here as well
 * so the app knows them offline; read again with each sync.
 */
export const skipDomains = signal<string[]>([]);

void Storage.getItem(KEY)
  .then((v) => {
    if (v) skipDomains.set(JSON.parse(v) as string[]);
  })
  .catch(() => {});

function keep(list: string[]) {
  skipDomains.set(list);
  void Storage.setItem(KEY, JSON.stringify(list)).catch(() => {});
}

/** The server's list (each sync). A server from before it has none to give: the list stays. */
export async function loadSites() {
  try {
    const s = await api.settings();
    if (Array.isArray(s?.skipDomains)) keep(s.skipDomains);
  } catch {
    // Offline, or an older server.
  }
}

/** Saves the list on the server; throws (the list unchanged) if it can't. */
export async function setSites(list: string[]) {
  const s = await api.updateSettings({ skipDomains: list });
  keep(s.skipDomains);
}

/** Whether a bookmark opens as its page, never in the reader. */
export const opensAsPage = (b: Pick<Bookmark, "domain">) => onSite(b.domain, skipDomains());

/** Forgets the list (another server). */
export function forgetSites() {
  keep([]);
}
