import { timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.ts";
import { Semaphore } from "../util/semaphore.ts";
import { BROWSER_USER_AGENT } from "./browser.ts";
import { ImageCache } from "./imageCache.ts";
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
 *   only URLs the server handed out can be fetched through it. What it
 *   fetched is kept on disk (`imageCache.ts`), and article images come
 *   resized for reading (`ARTICLE_IMAGE_WIDTH`).
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

/** An error is not kept by caches: an upstream hiccup must not stick to a cover. */
const failure = (message: string, status: number) =>
  new Response(message, { status, headers: { "cache-control": "no-store" } });

/**
 * The width article images are served at: twice the reader's measure (680
 * points), so they're sharp on a Retina screen and an iPhone's (whose text
 * is narrower at 3×). A screenshot of 2560×1600 comes to a fifth of its bytes.
 */
export const ARTICLE_IMAGE_WIDTH = 1360;
/** The widths `/img` resizes to; anything else is refused, so the variants a URL can have stay few. */
const IMAGE_WIDTHS: readonly number[] = [ARTICLE_IMAGE_WIDTH];
/** Formats resized (static ones `Bun.Image` decodes everywhere; a GIF may be animated). */
const RESIZABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
/** A bigger canvas isn't decoded (a pixel buffer of ~240 MB). */
const RESIZE_MAX_PIXELS = 60_000_000;
/** Upstream fetches for the proxy at once: an article of 471 images asks for all of them together. */
const upstream = new Semaphore(16);
/** Resizes at once (each runs on Bun's worker threads, a decoded image in memory). */
const resizes = new Semaphore(4);

/** What the proxy serves for a URL and width. */
interface Served {
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** `bytes` at most `width` wide, as WebP; unchanged when already narrower, not resizable, or not smaller. */
export async function resizeImage(served: Served, width: number): Promise<Served> {
  if (!RESIZABLE.has(served.type)) return served;
  const release = await resizes.acquire();
  try {
    const opts = { maxPixels: RESIZE_MAX_PIXELS };
    const meta = await new Bun.Image(served.bytes, opts).metadata();
    if (meta.width <= width) return served;
    const bytes = (await new Bun.Image(served.bytes, opts)
      .resize(width)
      .webp({ quality: 80 })
      .bytes()) as Uint8Array<ArrayBuffer>;
    return bytes.byteLength < served.bytes.byteLength ? { type: "image/webp", bytes } : served;
  } catch {
    return served; // Undecodable here: the client may still manage.
  } finally {
    release();
  }
}

/** The body of `res`, or null past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** Signs and serves `/img/<signature>?u=<url>[&w=<width>]`. */
export class ImageProxy {
  /** Fetches in flight, by cache key: a picture asked for twice at once is fetched once. */
  private inFlight = new Map<string, Promise<Served | Response>>();

  constructor(
    private key: Uint8Array,
    private cache: ImageCache | null = null,
  ) {}

  /** The key made once and kept in `meta` (proxy URLs stay valid across restarts). */
  static fromDb(db: Db, cache: ImageCache | null = null): ImageProxy {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get("image_proxy_key");
    if (row) return new ImageProxy(Buffer.from(row.value, "base64url"), cache);
    const key = crypto.getRandomValues(new Uint8Array(32));
    db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("image_proxy_key", b64url(key));
    return new ImageProxy(key, cache);
  }

  private sign(url: string): string {
    const h = new Bun.CryptoHasher("sha256", this.key);
    h.update(url);
    return b64url(h.digest()).slice(0, 22); // 132 bits
  }

  /**
   * The proxy path for `url` (relative to the server), or null for what it
   * doesn't serve. With a `width`, the picture comes at most that wide.
   */
  path(url: string, width?: number): string | null {
    if (!/^https?:\/\//i.test(url)) return null;
    return `/img/${this.sign(url)}?u=${encodeURIComponent(url)}${width ? `&w=${width}` : ""}`;
  }

  /**
   * The proxy path for a bookmark's cover. Old rows may hold a cover relative
   * to the page (or protocol-relative), so it is resolved against the page URL
   * first.
   */
  coverPath(cover: string | null, pageUrl: string): string | null {
    if (!cover) return null;
    let url: string;
    try {
      url = new URL(cover, pageUrl).href;
    } catch {
      return null;
    }
    return this.path(url);
  }

  verify(sig: string, url: string): boolean {
    const want = Buffer.from(this.sign(url));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * Serves the image for a client: no Referer, image types only, never run as
   * a document. Kept on disk once fetched (and resized, with a width), so the
   * next view doesn't wait on the image's site.
   */
  async serve(sig: string, url: string | undefined, w?: string): Promise<Response> {
    if (!url || !/^https?:\/\//i.test(url) || !this.verify(sig, url)) {
      return failure("bad signature", 403);
    }
    const width = w === undefined ? 0 : Number(w);
    if (width && !IMAGE_WIDTHS.includes(width)) return failure("unsupported width", 400);
    const key = new Bun.CryptoHasher("sha256").update(`${width}\n${url}`).digest("hex");

    const hit = this.cache?.get(key);
    if (hit) return this.respond(hit.type, Bun.file(hit.path), "hit");

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.load(url, width).then(async (got) => {
        if (!(got instanceof Response) && this.cache && ImageCache.keeps(got.type)) {
          await this.cache.put(key, got.type, got.bytes);
        }
        return got;
      });
      this.inFlight.set(key, pending);
      void pending.finally(() => this.inFlight.delete(key));
    }
    const got = await pending;
    // A failure's body can be read once: each waiter gets its own.
    if (got instanceof Response) return got.clone();
    return this.respond(got.type, got.bytes, "miss");
  }

  /** The picture from its site, resized to `width` when given. */
  private async load(url: string, width: number): Promise<Served | Response> {
    const release = await upstream.acquire();
    let served: Served;
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: IMAGE_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        });
      } catch (e) {
        return failure(`upstream failed: ${(e as Error).message}`, 502);
      }
      const type = res.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() ?? "";
      const length = Number(res.headers.get("content-length") ?? 0);
      if (!res.ok || !type.startsWith("image/") || length > PROXY_MAX_BYTES) {
        await res.body?.cancel();
        if (!res.ok) return failure(`upstream HTTP ${res.status}`, 502);
        return failure(length > PROXY_MAX_BYTES ? "too large" : "not an image", 415);
      }
      const bytes = await readCapped(res, PROXY_MAX_BYTES).catch(() => undefined);
      if (bytes === undefined) return failure("upstream failed: body cut short", 502);
      if (bytes === null) return failure("too large", 415);
      served = { type, bytes };
    } finally {
      release();
    }
    return width ? resizeImage(served, width) : served;
  }

  private respond(
    type: string,
    body: Uint8Array<ArrayBuffer> | Blob,
    cache: "hit" | "miss",
  ): Response {
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=604800",
        "x-content-type-options": "nosniff",
        // An SVG opened on its own must not run scripts on the server's origin.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
        "x-lofu-cache": cache,
      },
    });
  }
}
