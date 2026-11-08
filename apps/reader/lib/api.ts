import { Secrets, ShareExtension } from "lofu/native";
import { Storage } from "nsh";

/** The subset of the lofu API the app uses (shapes from packages/shared/src/schemas.ts). */
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  excerpt: string | null;
  note: string | null;
  coverUrl: string | null;
  /** The cover through the server's image proxy (a path), for sites that refuse hotlinks; older servers send none. */
  coverProxy?: string | null;
  faviconUrl: string | null;
  domain: string;
  type: "article" | "video" | "image" | "audio" | "document" | "link";
  tags: string[];
  collectionId: string | null;
  favorite: boolean;
  archived: boolean;
  readProgress: number;
  wordCount: number | null;
  contentStatus: "pending" | "ok" | "failed" | "skipped";
  contentError: string | null;
  /**
   * Its place in its collection's manual order, ascending: minus the save
   * time (ms) until it's dragged. Older servers send none; `manualKey` stands
   * in for it.
   */
  sort?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  seq: number;
}

export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  color: string | null;
  deletedAt: string | null;
  seq: number;
}

export interface Highlight {
  id: string;
  bookmarkId: string;
  quote: string;
  prefix: string;
  suffix: string;
  note: string | null;
  color: string | null;
  deletedAt?: string | null;
}

export interface SyncPage {
  cursor: number;
  hasMore: boolean;
  bookmarks: Bookmark[];
  collections: Collection[];
  highlights: Highlight[];
}

/** An image of an article (`ContentImage` in packages/shared/src/schemas.ts). */
export interface ArticleImage {
  src: string;
  width: number | null;
  height: number | null;
  /** Absolute URL of the server's image proxy, or null to load `src` itself. */
  proxy: string | null;
}

export interface Article {
  markdown: string | null;
  images: ArticleImage[];
}

export interface SearchHit {
  bookmark: Bookmark;
  /** Matched content with `<mark>` around hits. */
  snippet: string | null;
}

export type BookmarkPatch = Partial<
  Pick<
    Bookmark,
    "title" | "note" | "tags" | "collectionId" | "favorite" | "archived" | "readProgress" | "sort"
  >
>;

/**
 * The server couldn't be reached (no network, or it's down), as opposed to
 * one that answered and refused. Changes made meanwhile wait and are sent
 * later (`lib/store.ts`); reading falls back to what was kept on the device.
 */
export class OfflineError extends Error {}

export interface Settings {
  server: string;
  token: string;
}

/** The token goes to the Keychain where there is one the app can use (iOS). */
const keychain = (() => {
  try {
    return Secrets.available();
  } catch {
    return false; // No native module (headless tests, the web).
  }
})();

let current: Settings | null = null;

/** The settings once loaded (`loadSettings`), for code that can't wait. */
export const loadedSettings = () => current;

export async function loadSettings(): Promise<Settings> {
  if (current) return current;
  const server = (await Storage.getItem("server")) ?? "";
  let token = (await Storage.getItem("token")) ?? "";
  if (keychain) {
    // Logins from before the Keychain move there on first use.
    if (token && Secrets.set("token", token)) await Storage.removeItem("token");
    token = Secrets.get("token") ?? token;
  }
  current = { server, token };
  return current;
}

export const normalizeServer = (s: string) => s.trim().replace(/\/+$/, "");

export async function saveSettings(s: Settings): Promise<void> {
  const next = { server: normalizeServer(s.server), token: s.token.trim() };
  await Storage.setItem("server", next.server);
  if (keychain && Secrets.set("token", next.token)) await Storage.removeItem("token");
  else await Storage.setItem("token", next.token);
  current = next;
  shareLogin(next);
}

/**
 * Hands the server and token to the iOS share extension (`share/`), which
 * saves with them from other apps' share sheets. A no-op where there's no
 * extension: other platforms, and builds without it.
 */
export function shareLogin(s: Settings) {
  try {
    ShareExtension.remember(normalizeServer(s.server), s.token.trim());
  } catch {
    // No native module (headless tests, the web).
  }
}

async function request<T>(method: string, path: string, body?: unknown, settings?: Settings) {
  const { server, token } = settings ?? (await loadSettings());
  if (!server || !token) throw new Error("Set your lofu server in Settings.");
  let res: Response;
  try {
    res = await fetch(`${normalizeServer(server)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token.trim()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OfflineError(`Can't reach ${server}.`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy's HTML error page, say; the status explains it.
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error("The server didn't accept this token.");
    throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

const q = encodeURIComponent;

/** Search results come in pages of this many. */
export const SEARCH_PAGE = 60;

/** An absolute URL for a path the server handed out (its image proxy). */
export async function serverUrl(path: string): Promise<string> {
  return `${normalizeServer((await loadSettings()).server)}${path}`;
}

export const api = {
  /** Checks a server address and token before they're saved. */
  check: (s: Settings) => request<SyncPage>("GET", "/v1/sync?since=0&limit=1", undefined, s),
  sync: (since: number) => request<SyncPage>("GET", `/v1/sync?since=${since}&limit=1000`),
  search: (
    query: string,
    filter: {
      collectionId?: string;
      tags?: string;
      favorite?: boolean;
      type?: Bookmark["type"];
      archived?: boolean;
    },
    offset = 0,
  ) => {
    const params = [`q=${q(query)}`, `limit=${SEARCH_PAGE}`, `offset=${offset}`];
    if (filter.archived !== undefined) params.push(`archived=${filter.archived}`);
    if (filter.type) params.push(`type=${q(filter.type)}`);
    if (filter.collectionId) params.push(`collectionId=${q(filter.collectionId)}`);
    if (filter.tags) params.push(`tags=${q(filter.tags)}`);
    if (filter.favorite) params.push("favorite=true");
    return request<{ hits: SearchHit[]; estimatedTotal?: number }>(
      "GET",
      `/v1/search?${params.join("&")}`,
    );
  },
  /** Saves a URL; the server fetches and reads the page afterwards. Saving one again merges `fields`. */
  create: (
    url: string,
    fields: Partial<Pick<Bookmark, "id" | "tags" | "collectionId" | "favorite">> = {},
  ) => request<Bookmark>("POST", "/v1/bookmarks", { url, ...fields }),
  bookmark: (id: string) => request<Bookmark>("GET", `/v1/bookmarks/${id}`),
  update: (id: string, patch: BookmarkPatch) =>
    request<Bookmark>("PATCH", `/v1/bookmarks/${id}`, patch),
  /** Deletes a bookmark for good (the server keeps a tombstone for sync). */
  remove: (id: string) => request<null>("DELETE", `/v1/bookmarks/${id}`),
  createCollection: (name: string) => request<Collection>("POST", "/v1/collections", { name }),
  updateCollection: (id: string, patch: { name?: string; sort?: number }) =>
    request<Collection>("PATCH", `/v1/collections/${id}`, patch),
  /** Deletes a collection; its bookmarks go to Unsorted. */
  removeCollection: (id: string) => request<null>("DELETE", `/v1/collections/${id}`),
  /** Renames a tag on every bookmark (merging into `to` where it's there already). */
  renameTag: (from: string, to: string) =>
    request<{ updated: number }>("POST", "/v1/tags/rename", { from, to }),
  /** Takes a tag off every bookmark. */
  removeTag: (name: string) => request<{ updated: number }>("DELETE", `/v1/tags/${q(name)}`),
  refetch: (id: string) => request<Bookmark>("POST", `/v1/bookmarks/${id}/refetch`),
  /** The saved text as Markdown, and its images (sizes, and where to load them from). */
  article: async (id: string): Promise<Article> => {
    const r = await request<{ content: string | null; images?: ArticleImage[] | null }>(
      "GET",
      `/v1/bookmarks/${id}?content=markdown`,
    );
    const server = normalizeServer((await loadSettings()).server);
    return {
      markdown: r.content,
      // Servers from before image sizes send none.
      images: (r.images ?? []).map((i) => ({ ...i, proxy: i.proxy && `${server}${i.proxy}` })),
    };
  },
  highlights: (id: string) => request<Highlight[]>("GET", `/v1/bookmarks/${id}/highlights`),
  addHighlight: (id: string, h: { quote: string; prefix: string; suffix: string }) =>
    request<Highlight>("POST", `/v1/bookmarks/${id}/highlights`, h),
  removeHighlight: (id: string) => request<null>("DELETE", `/v1/highlights/${id}`),
};
