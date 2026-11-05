import { Storage } from "nsh";

/** The subset of the lofu API the reader uses (shapes from packages/shared/src/schemas.ts). */
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  domain: string;
  type: string;
  wordCount: number | null;
  contentStatus: "pending" | "ok" | "failed" | "skipped";
  createdAt: string;
}

export interface Highlight {
  id: string;
  bookmarkId: string;
  quote: string;
  prefix: string;
  suffix: string;
  note: string | null;
  color: string | null;
}

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

export async function saveSettings(s: Settings): Promise<void> {
  await Storage.setItem("server", s.server.trim().replace(/\/+$/, ""));
  await Storage.setItem("token", s.token.trim());
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { server, token } = await loadSettings();
  if (!server || !token) throw new Error("Set your lofu server in Settings.");
  const res = await fetch(`${server}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  library: async () =>
    (await request<{ items: Bookmark[] }>("GET", "/v1/bookmarks?archived=false&limit=100")).items,
  markdown: async (id: string) =>
    (await request<{ content: string | null }>("GET", `/v1/bookmarks/${id}?content=markdown`))
      .content,
  highlights: (id: string) => request<Highlight[]>("GET", `/v1/bookmarks/${id}/highlights`),
  addHighlight: (id: string, h: { quote: string; prefix: string; suffix: string }) =>
    request<Highlight>("POST", `/v1/bookmarks/${id}/highlights`, h),
  removeHighlight: (id: string) => request<null>("DELETE", `/v1/highlights/${id}`),
};
