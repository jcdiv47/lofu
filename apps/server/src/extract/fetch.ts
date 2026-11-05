import type { BookmarkType } from "@lofu/shared";

export type FetchResult =
  | { kind: "html"; html: string; finalUrl: string; bytes: number }
  | { kind: "other"; type: BookmarkType; contentType: string; finalUrl: string };

export class FetchError extends Error {
  constructor(
    message: string,
    /** Permanent errors (404, unsupported type) are not retried. */
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** Counting semaphore. */
class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/**
 * Page fetcher with a global concurrency cap and a per-host cap (politeness:
 * a bulk import of 2,000 links from one site must not hammer it).
 */
export class Fetcher {
  private global: Semaphore;
  private hosts = new Map<string, { sem: Semaphore; users: number }>();

  constructor(
    private opts: {
      concurrency: number;
      perHost: number;
      timeoutMs: number;
      maxBytes: number;
      http2: boolean;
    },
  ) {
    this.global = new Semaphore(opts.concurrency);
  }

  async fetch(url: string): Promise<FetchResult> {
    const host = new URL(url).host;
    let h = this.hosts.get(host);
    if (!h) {
      h = { sem: new Semaphore(this.opts.perHost), users: 0 };
      this.hosts.set(host, h);
    }
    h.users++;
    const releaseHost = await h.sem.acquire();
    const releaseGlobal = await this.global.acquire();
    try {
      return await this.doFetch(url);
    } finally {
      releaseGlobal();
      releaseHost();
      if (--h.users === 0) this.hosts.delete(host);
    }
  }

  /** Hosts whose h2 attempt failed; they go straight to HTTP/1.1 from then on. */
  private h1Only = new Set<string>();

  /**
   * HTTPS requests try HTTP/2 first, like a browser. Some servers reject
   * HTTP/1.1 clients outright (e.g. paulgraham.com answers 500), while others
   * don't speak h2 at all; those fail fast and are retried over HTTP/1.1.
   * Uses Bun's experimental `protocol` fetch option.
   */
  private async request(url: string): Promise<Response> {
    const init: RequestInit = {
      redirect: "follow",
      signal: AbortSignal.timeout(this.opts.timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      },
    };
    const host = new URL(url).host;
    if (this.opts.http2 && url.startsWith("https:") && !this.h1Only.has(host)) {
      try {
        return await fetch(url, { ...init, protocol: "http2" });
      } catch (e) {
        const name = (e as Error).name;
        if (name === "TimeoutError" || name === "AbortError") throw e;
        if (this.h1Only.size > 10_000) this.h1Only.clear();
        this.h1Only.add(host);
      }
    }
    return fetch(url, init);
  }

  private async doFetch(url: string): Promise<FetchResult> {
    let res: Response;
    try {
      res = await this.request(url);
    } catch (e) {
      throw new FetchError(`fetch failed: ${(e as Error).message}`, false);
    }
    const finalUrl = res.url || url;
    if (!res.ok) {
      await res.body?.cancel();
      const permanent = res.status === 404 || res.status === 410 || res.status === 451;
      throw new FetchError(`HTTP ${res.status}`, permanent);
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const mime = contentType.split(";")[0]!.trim();
    if (mime && mime !== "text/html" && mime !== "application/xhtml+xml") {
      await res.body?.cancel();
      return { kind: "other", type: typeForMime(mime), contentType: mime, finalUrl };
    }

    const bytes = await readCapped(res, this.opts.maxBytes);
    return {
      kind: "html",
      html: decodeHtml(bytes, contentType),
      finalUrl,
      bytes: bytes.byteLength,
    };
  }
}

function typeForMime(mime: string): BookmarkType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime.startsWith("application/vnd.") ||
    mime === "application/epub+zip"
  )
    return "document";
  return "link";
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) {
    await res.body?.cancel();
    throw new FetchError(`page too large (${len} bytes)`, true);
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new FetchError(`page too large (> ${maxBytes} bytes)`, true);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Decodes with the declared charset: Content-Type header, then BOM, then a
 * <meta> sniff of the first 4 KiB, defaulting to UTF-8. Needed for the many
 * GBK / Big5 / Shift_JIS pages that `Response.text()` would garble.
 */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  }
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset =
      /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
      /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown label
  }
}
