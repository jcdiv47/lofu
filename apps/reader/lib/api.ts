import { Storage } from "nsh";

/** The subset of the lofu API the app uses (shapes from packages/shared/src/schemas.ts). */
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  excerpt: string | null;
  note: string | null;
  coverUrl: string | null;
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

export interface SearchHit {
  bookmark: Bookmark;
  /** Matched content with `<mark>` around hits. */
  snippet: string | null;
}

export type BookmarkPatch = Partial<
  Pick<Bookmark, "title" | "note" | "tags" | "collectionId" | "favorite" | "archived">
>;

export interface Settings {
  server: string;
  token: string;
}

export async function loadSettings(): Promise<Settings> {
  return {
    server: (await Storage.getItem("server")) ?? "",
    token: (await Storage.getItem("token")) ?? "",
  };
}

export const normalizeServer = (s: string) => s.trim().replace(/\/+$/, "");

export async function saveSettings(s: Settings): Promise<void> {
  await Storage.setItem("server", normalizeServer(s.server));
  await Storage.setItem("token", s.token.trim());
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
    throw new Error(`Can't reach ${server}.`);
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

export const api = {
  /** Checks a server address and token before they're saved. */
  check: (s: Settings) => request<SyncPage>("GET", "/v1/sync?since=0&limit=1", undefined, s),
  sync: (since: number) => request<SyncPage>("GET", `/v1/sync?since=${since}&limit=1000`),
  search: (query: string, filter: { collectionId?: string; tags?: string; favorite?: boolean }) => {
    const params = [`q=${q(query)}`, "limit=60"];
    if (filter.collectionId) params.push(`collectionId=${q(filter.collectionId)}`);
    if (filter.tags) params.push(`tags=${q(filter.tags)}`);
    if (filter.favorite) params.push("favorite=true");
    return request<{ hits: SearchHit[] }>("GET", `/v1/search?${params.join("&")}`);
  },
  /** Saves a URL; the server fetches and reads the page afterwards. Saving one again merges `fields`. */
  create: (
    url: string,
    fields: Partial<Pick<Bookmark, "tags" | "collectionId" | "favorite">> = {},
  ) => request<Bookmark>("POST", "/v1/bookmarks", { url, ...fields }),
  update: (id: string, patch: BookmarkPatch) =>
    request<Bookmark>("PATCH", `/v1/bookmarks/${id}`, patch),
  refetch: (id: string) => request<Bookmark>("POST", `/v1/bookmarks/${id}/refetch`),
  markdown: async (id: string) =>
    (await request<{ content: string | null }>("GET", `/v1/bookmarks/${id}?content=markdown`))
      .content,
  highlights: (id: string) => request<Highlight[]>("GET", `/v1/bookmarks/${id}/highlights`),
  addHighlight: (id: string, h: { quote: string; prefix: string; suffix: string }) =>
    request<Highlight>("POST", `/v1/bookmarks/${id}/highlights`, h),
  removeHighlight: (id: string) => request<null>("DELETE", `/v1/highlights/${id}`),
};
