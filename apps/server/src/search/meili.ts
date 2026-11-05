/**
 * Minimal Meilisearch HTTP client covering exactly what lofu uses. Plain
 * fetch over a keep-alive connection; no SDK dependency.
 */
export class MeiliError extends Error {}

export interface MeiliTask {
  taskUid: number;
}

export class Meili {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new MeiliError(`meilisearch ${method} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async waitForTask(uid: number, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 10;
    for (;;) {
      const t = await this.request<{ status: string; error?: { message: string } }>(
        "GET",
        `/tasks/${uid}`,
      );
      if (t.status === "succeeded") return;
      if (t.status === "failed" || t.status === "canceled") {
        throw new MeiliError(`meilisearch task ${uid} ${t.status}: ${t.error?.message ?? ""}`);
      }
      if (Date.now() > deadline) throw new MeiliError(`meilisearch task ${uid} timed out`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }
}
