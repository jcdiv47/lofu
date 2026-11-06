import { timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.ts";
import { Semaphore } from "../util/semaphore.ts";
import { BROWSER_USER_AGENT } from "./browser.ts";
import { type ImageSize, imageSize } from "./imageSize.ts";

/**
 * Images in saved articles stay at their original URLs. Two things are kept
 * on the side, because readers can't show those URLs as they are:
 *
 * - **Sizes.** nsh's `RichEditor` lays an image out only at an explicit
 *   width and height (it draws a Markdown image, which has neither, at 0×0).
 *   A job reads the first bytes of each image after extraction.
 * - **A proxy.** Hotlink protection answers a request from another site's
 *   page with a placeholder (WeChat: "未经允许不可引用") or a 403 (CSDN). The
 *   server fetches images without a Referer, which those hosts allow. The
 *   reader's `<img>` can't send a bearer token, so proxy URLs are signed:
 *   only URLs the server handed out can be fetched through it.
 */

/** Sizes by image URL; images that couldn't be measured are left out. */
export type ImageSizes = Record<string, [number, number]>;

/** Images per article worth measuring; the rest show unsized. */
const MAX_IMAGES = 300;
/** Enough for any header we parse (JPEGs carry EXIF and thumbnails before their size). */
const PROBE_MAX_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const PROXY_TIMEOUT_MS = 30_000;
const PROXY_MAX_BYTES = 40 * 1024 * 1024;
/** Probes in flight across all articles. */
const probes = new Semaphore(8);

/** `![alt](src)` and `![alt](<src> "title")`: the image URLs of a Markdown text, in order, once each. */
export function markdownImages(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/!\[(?:\\.|[^\]\\])*\]\(\s*<?([^\s)>]+)>?/g)) {
    out.add(m[1]!);
  }
  return [...out];
}

const IMAGE_HEADERS = {
  "user-agent": BROWSER_USER_AGENT,
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

/** An error page is not an image, even when it holds an inline `<svg>` icon. */
const isImageType = (type: string | null) =>
  !type || type.startsWith("image/") || type.startsWith("application/octet-stream");

/** Size of the image at `url` (http(s) or data:), reading as little of it as possible. */
export async function measureImage(url: string): Promise<ImageSize | null> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
    if (!m || !isImageType(m[1] || null)) return null;
    try {
      const bytes = m[2]
        ? Buffer.from(m[3]!, "base64")
        : new TextEncoder().encode(decodeURIComponent(m[3]!));
      return imageSize(bytes);
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const release = await probes.acquire();
  try {
    const res = await fetch(url, {
      headers: { ...IMAGE_HEADERS, range: `bytes=0-${PROBE_MAX_BYTES - 1}` },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body || !isImageType(res.headers.get("content-type"))) {
      await res.body?.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      while (total < PROBE_MAX_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        const size = imageSize(Buffer.concat(chunks, total));
        if (size) return size;
      }
      return null;
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    return null;
  } finally {
    release();
  }
}

/** Measures every image of a Markdown text (failures are left out). */
export async function measureImages(markdown: string): Promise<ImageSizes> {
  const sizes: ImageSizes = {};
  await Promise.all(
    markdownImages(markdown)
      .slice(0, MAX_IMAGES)
      .map(async (src) => {
        const s = await measureImage(src);
        if (s) sizes[src] = [s.width, s.height];
      }),
  );
  return sizes;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** Signs and serves `/img/<signature>?u=<url>`. */
export class ImageProxy {
  constructor(private key: Uint8Array) {}

  /** The key made once and kept in `meta` (proxy URLs stay valid across restarts). */
  static fromDb(db: Db): ImageProxy {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get("image_proxy_key");
    if (row) return new ImageProxy(Buffer.from(row.value, "base64url"));
    const key = crypto.getRandomValues(new Uint8Array(32));
    db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("image_proxy_key", b64url(key));
    return new ImageProxy(key);
  }

  private sign(url: string): string {
    const h = new Bun.CryptoHasher("sha256", this.key);
    h.update(url);
    return b64url(h.digest()).slice(0, 22); // 132 bits
  }

  /** The proxy path for `url` (relative to the server), or null for what it doesn't serve. */
  path(url: string): string | null {
    if (!/^https?:\/\//i.test(url)) return null;
    return `/img/${this.sign(url)}?u=${encodeURIComponent(url)}`;
  }

  verify(sig: string, url: string): boolean {
    const want = Buffer.from(this.sign(url));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Fetches the image for a client: no Referer, image types only, never run as a document. */
  async serve(sig: string, url: string | undefined): Promise<Response> {
    if (!url || !/^https?:\/\//i.test(url) || !this.verify(sig, url)) {
      return new Response("bad signature", { status: 403 });
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: IMAGE_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch (e) {
      return new Response(`upstream failed: ${(e as Error).message}`, { status: 502 });
    }
    const type = res.headers.get("content-type")?.toLowerCase() ?? "";
    const length = Number(res.headers.get("content-length") ?? 0);
    if (!res.ok || !type.startsWith("image/") || length > PROXY_MAX_BYTES) {
      await res.body?.cancel();
      if (!res.ok) return new Response(`upstream HTTP ${res.status}`, { status: 502 });
      return new Response(length > PROXY_MAX_BYTES ? "too large" : "not an image", {
        status: 415,
      });
    }
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": "public, max-age=604800",
      "x-content-type-options": "nosniff",
      // An SVG opened on its own must not run scripts on the server's origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    };
    // fetch() decodes a compressed body, so the upstream length would be wrong.
    if (length && !res.headers.has("content-encoding")) headers["content-length"] = String(length);
    let sent = 0;
    const capped = res.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          sent += chunk.byteLength;
          if (sent > PROXY_MAX_BYTES) out.error(new Error("image too large"));
          else out.enqueue(chunk);
        },
      }),
    );
    return new Response(capped ?? null, { status: 200, headers });
  }
}
