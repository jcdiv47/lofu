import type { BookmarkType } from "@lofu/shared";
import { Semaphore } from "../util/semaphore.ts";
import { BlockedAddressError, publicFetch } from "./netguard.ts";

export type FetchResult =
  | { kind: "html"; html: string; finalUrl: string; bytes: number }
  | { kind: "pdf"; data: Uint8Array; finalUrl: string }
  | { kind: "text"; text: string; markdown: boolean; finalUrl: string; bytes: number }
  | { kind: "other"; type: BookmarkType; contentType: string; finalUrl: string };

/** Papers and books run larger than web pages. */
const PDF_MAX_BYTES = 64 * 1024 * 1024;
/** Ceiling for the adaptive per-host backoff. */
const MAX_PENALTY_MS = 60_000;

export class FetchError extends Error {
  constructor(
    message: string,
    /** Permanent errors (404, unsupported type) are not retried. */
    readonly permanent: boolean,
    /** 401/403: the site refuses this client; a real browser might get through. */
    readonly blocked = false,
  ) {
    super(message);
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/**
 * A user agent that says what it is. Cloudflare challenges a Chrome user agent
 * that lacks Chrome's TLS fingerprint, yet lets many sites (V2EX, personal
 * blogs) serve an honest client.
 */
export const HONEST_USER_AGENT = "lofu/1.0 (bookmark reader)";

export interface RequestOptions {
  /** Replaces the default Chrome user agent. */
  userAgent?: string;
  /** Extra headers; `accept` overrides the HTML default. */
  headers?: Record<string, string>;
}

/** Response of `fetchText`: any status, body read as text. */
export interface TextResponse {
  status: number;
  text: string;
  contentType: string;
  finalUrl: string;
  headers: Headers;
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
      /** Minimum gap between request starts to the same host. */
      hostIntervalMs: number;
    },
  ) {
    this.global = new Semaphore(opts.concurrency);
  }

  fetch(url: string, req: RequestOptions = {}): Promise<FetchResult> {
    return this.polite(url, () => this.doFetch(url, req));
  }

  /**
   * A request for an API rather than a page: returns any status and any
   * content type as text, under the same concurrency caps and host pacing.
   */
  fetchText(url: string, req: RequestOptions = {}): Promise<TextResponse> {
    return this.polite(url, async () => {
      const res = await this.request(url, req);
      const contentType = res.headers.get("content-type") ?? "";
      const bytes = await readCapped(res, this.opts.maxBytes);
      return {
        status: res.status,
        text: decodeHtml(bytes, contentType),
        contentType,
        finalUrl: res.url || url,
        headers: res.headers,
      };
    });
  }

  private async polite<T>(url: string, run: () => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    let h = this.hosts.get(host);
    if (!h) {
      h = { sem: new Semaphore(this.opts.perHost), users: 0 };
      this.hosts.set(host, h);
    }
    h.users++;
    const releaseHost = await h.sem.acquire();
    await this.pace(host);
    const releaseGlobal = await this.global.acquire();
    try {
      return await run();
    } finally {
      releaseGlobal();
      releaseHost();
      if (--h.users === 0) this.hosts.delete(host);
    }
  }

  private nextStart = new Map<string, number>();
  private penalty = new Map<string, number>();

  /**
   * Spaces request starts to one host by `hostIntervalMs`, or longer while
   * the host is penalized. Slots are reserved before sleeping, so concurrent
   * callers queue up behind each other. Sites like WeChat or Weibo serve
   * captchas to bursts, so a bulk import that is 30% one host must trickle
   * rather than hammer it.
   */
  private async pace(host: string) {
    const interval = Math.max(this.opts.hostIntervalMs, this.penalty.get(host) ?? 0);
    if (interval <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextStart.get(host) ?? 0);
    this.nextStart.set(host, at + interval);
    if (this.nextStart.size > 10_000) {
      for (const [k, t] of this.nextStart) if (t < now) this.nextStart.delete(k);
    }
    if (at > now) await Bun.sleep(at - now);
  }

  /**
   * Adaptive politeness: a host that rate-limits us (429/503, or a captcha
   * page detected after extraction) gets its interval doubled, up to a
   * minute. Each successful response relaxes it again.
   */
  penalize(url: string) {
    const host = new URL(url).host;
    const cur = this.penalty.get(host) ?? 0;
    this.penalty.set(host, Math.min(MAX_PENALTY_MS, Math.max(5_000, cur * 2)));
  }

  private relax(host: string) {
    const cur = this.penalty.get(host);
    if (cur === undefined) return;
    if (cur * 0.8 <= this.opts.hostIntervalMs || cur < 500) this.penalty.delete(host);
    else this.penalty.set(host, cur * 0.8);
  }

  /** Hosts whose h2 attempt failed; they go straight to HTTP/1.1 from then on. */
  private h1Only = new Set<string>();

  /**
   * HTTPS requests try HTTP/2 first, like a browser. Some servers reject
   * HTTP/1.1 clients outright (e.g. paulgraham.com answers 500), while others
   * don't speak h2 at all; those fail fast and are retried over HTTP/1.1.
   * Uses Bun's experimental `protocol` fetch option. Redirects are followed
   * by `publicFetch`, which keeps every hop off private networks.
   */
  private request(url: string, req: RequestOptions = {}): Promise<Response> {
    const init: RequestInit = {
      signal: AbortSignal.timeout(this.opts.timeoutMs),
      headers: {
        "user-agent": req.userAgent ?? USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        ...req.headers,
      },
    };
    return publicFetch(url, init, (hopUrl, hopInit) => this.requestOnce(hopUrl, hopInit));
  }

  private async requestOnce(url: string, init: RequestInit): Promise<Response> {
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

  private async doFetch(url: string, req: RequestOptions): Promise<FetchResult> {
    let res: Response;
    try {
      res = await this.request(url, req);
    } catch (e) {
      if (e instanceof BlockedAddressError) throw new FetchError(e.message, true);
      throw new FetchError(`fetch failed: ${(e as Error).message}`, false);
    }
    const finalUrl = res.url || url;
    const host = new URL(url).host;
    if (!res.ok) {
      await res.body?.cancel();
      const s = res.status;
      if (s === 429 || s === 503) this.penalize(url);
      // 401/403 here are bot walls (Cloudflare, Zhihu, Medium): retrying from
      // the same client won't help. They need the (future) browser fallback.
      if (s === 401 || s === 403) throw new FetchError(`blocked by site (HTTP ${s})`, true, true);
      throw new FetchError(`HTTP ${s}`, s === 404 || s === 410 || s === 451);
    }
    this.relax(host);

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const mime = contentType.split(";")[0]!.trim();
    if (
      mime === "application/pdf" ||
      (mime === "application/octet-stream" && /\.pdf$/i.test(new URL(finalUrl).pathname))
    ) {
      return { kind: "pdf", data: await readCapped(res, PDF_MAX_BYTES), finalUrl };
    }
    if (mime === "text/plain" || mime === "text/markdown" || mime === "text/x-markdown") {
      const bytes = await readCapped(res, this.opts.maxBytes);
      const markdown =
        mime !== "text/plain" || /\.(md|markdown)$/i.test(new URL(finalUrl).pathname);
      return {
        kind: "text",
        text: decodeHtml(bytes, contentType),
        markdown,
        finalUrl,
        bytes: bytes.byteLength,
      };
    }
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
