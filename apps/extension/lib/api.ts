import type { Bookmark, Collection, UpdateBookmark } from "@lofu/shared/types";
import { getSettings, isConfigured } from "./settings.ts";

export type { Bookmark, Collection };
export type TagCount = { name: string; count: number };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Above this, request bodies are gzipped (rendered pages are often several MB). */
const GZIP_THRESHOLD = 32 * 1024;

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; status: number }> {
  const s = await getSettings();
  if (!isConfigured(s)) throw new ApiError("Set your lofu server in the extension options.", 0);
  const headers: Record<string, string> = { authorization: `Bearer ${s.token}` };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    const json = JSON.stringify(body);
    headers["content-type"] = "application/json";
    if (json.length > GZIP_THRESHOLD) {
      headers["content-encoding"] = "gzip";
      payload = await gzip(json);
    } else {
      payload = json;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${s.serverUrl}${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(
      `Can't reach ${new URL(s.serverUrl).host}. Is the server up, and Tailscale connected?`,
      0,
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      res.status === 401 ? "The server rejected the token." : (data?.error ?? `HTTP ${res.status}`);
    throw new ApiError(msg, res.status);
  }
  return { data: data as T, status: res.status };
}

export const api = {
  health: () => request<{ ok: boolean; version: string; search: boolean | null }>("GET", "/health"),
  async save(input: {
    url: string;
    html?: string;
    tags?: string[];
    note?: string;
    collectionId?: string | null;
  }) {
    const { data, status } = await request<Bookmark>("POST", "/v1/bookmarks", input);
    return { bookmark: data, created: status === 201 };
  },
  get: async (id: string) => (await request<Bookmark>("GET", `/v1/bookmarks/${id}`)).data,
  /** The bookmark of a URL; one in the Trash only with `includeTrashed`. */
  lookup: async (url: string, opts: { includeTrashed?: boolean } = {}) => {
    const trash = opts.includeTrashed ? "&includeTrashed=true" : "";
    try {
      return (
        await request<Bookmark>(
          "GET",
          `/v1/bookmarks/lookup?url=${encodeURIComponent(url)}${trash}`,
        )
      ).data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  update: async (id: string, patch: UpdateBookmark) =>
    (await request<Bookmark>("PATCH", `/v1/bookmarks/${id}`, patch)).data,
  remove: async (id: string) => {
    await request<null>("DELETE", `/v1/bookmarks/${id}`);
  },
  tags: async () => (await request<{ items: TagCount[] }>("GET", "/v1/tags")).data.items,
  collections: async () =>
    (await request<{ items: Collection[] }>("GET", "/v1/collections")).data.items,
  failed: async () =>
    (await request<{ items: Bookmark[] }>("GET", "/v1/bookmarks?contentStatus=failed&limit=500"))
      .data.items,
};
