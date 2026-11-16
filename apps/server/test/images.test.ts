import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageCache } from "../src/extract/imageCache.ts";
import { imageSize } from "../src/extract/imageSize.ts";
import {
  ARTICLE_IMAGE_WIDTH,
  gifFrames,
  markdownImages,
  measureImage,
  resizeImage,
} from "../src/extract/images.ts";
import { JobStore } from "../src/store/jobs.ts";
import { pngHeader, served } from "./fixtures.ts";
import { setupServer } from "./harness.ts";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p)] : p)));
const u16be = (n: number) => [n >> 8, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, n >> 16];

/** SOI, an EXIF segment with an orientation, then a baseline frame header. */
function jpeg(width: number, height: number, orientation: number) {
  const tiff = [..."MM".split("").map((c) => c.charCodeAt(0)), 0, 42, 0, 0, 0, 8];
  const ifd = [0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const exif = [...Buffer.from("Exif\0\0"), ...tiff, ...ifd];
  const sof = [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe1, ...u16be(exif.length + 2), ...exif],
    [0xff, 0xc0, ...u16be(sof.length + 2), ...sof],
    [0xff, 0xd9],
  );
}

describe("imageSize", () => {
  test("reads PNG, GIF, WebP and BMP headers", () => {
    expect(imageSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(bytes("GIF89a", [0x5e, 0x02, 0x6c, 0x00], new Array(8).fill(0)))).toEqual({
      width: 606,
      height: 108,
    });
    const vp8x = bytes(
      "RIFF",
      [0, 0, 0, 0],
      "WEBPVP8X",
      new Array(8).fill(0),
      u24le(1919),
      u24le(1079),
    );
    expect(imageSize(vp8x)).toEqual({ width: 1920, height: 1080 });
    const bmp = bytes("BM", new Array(16).fill(0), [0x20, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff]);
    expect(imageSize(bmp)).toEqual({ width: 32, height: 16 });
  });

  test("JPEG: the frame size, turned when EXIF says the picture is on its side", () => {
    expect(imageSize(jpeg(4032, 3024, 1))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpeg(4032, 3024, 6))).toEqual({ width: 3024, height: 4032 });
  });

  test("SVG: width and height, else the viewBox", () => {
    const svg = (attrs: string) =>
      bytes(`<?xml version="1.0"?>\n<svg xmlns="x" ${attrs}><g/></svg>`);
    expect(imageSize(svg('width="120" height="40px"'))).toEqual({ width: 120, height: 40 });
    expect(imageSize(svg('viewBox="0 0 300 150"'))).toEqual({ width: 300, height: 150 });
    expect(imageSize(svg('width="60" viewBox="0 0 300 150"'))).toEqual({ width: 60, height: 30 });
    expect(imageSize(svg('width="100%" height="100%"'))).toBeNull();
  });

  test("unknown or truncated bytes say nothing", () => {
    expect(imageSize(bytes("<html><body>Forbidden</body></html>"))).toBeNull();
    expect(imageSize(pngHeader(640, 480).subarray(0, 20))).toBeNull();
    expect(imageSize(jpeg(10, 10, 1).subarray(0, 30))).toBeNull();
  });
});

test("data: URLs are measured in place", async () => {
  const png = Buffer.from(pngHeader(3, 2)).toString("base64");
  expect(await measureImage(`data:image/png;base64,${png}`)).toEqual({ width: 3, height: 2 });
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"/>');
  expect(await measureImage(`data:image/svg+xml,${svg}`)).toEqual({ width: 8, height: 4 });
  expect(await measureImage("data:text/html,<svg width='8' height='4'>")).toBeNull();
});

test("markdownImages: each image URL once, in order", () => {
  const md = [
    '![a](https://x.test/1.png) text ![b \\] c](<https://x.test/2.png> "title")',
    "[![linked](https://x.test/3.png)](https://x.test/page)",
    "![again](https://x.test/1.png) and a [link](https://x.test/not-an-image.png)",
  ].join("\n\n");
  expect(markdownImages(md)).toEqual([
    "https://x.test/1.png",
    "https://x.test/2.png",
    "https://x.test/3.png",
  ]);
});

describe("article images", () => {
  const { sys, app, api, base } = setupServer();
  let id: string;
  type Image = { src: string; width: number | null; height: number | null; proxy: string | null };
  const images = async () =>
    (await api("GET", `/v1/bookmarks/${id}?content=markdown`)).data.images as Image[];

  test("are measured after extraction and listed with the Markdown, sized for reading", async () => {
    id = (await api("POST", "/v1/bookmarks", { url: `${base}/pictures` })).data.id;
    await sys.runner.idle();
    const list = await images();
    expect(list.map((i) => [i.src.replace(base, ""), i.width, i.height])).toEqual([
      ["/photo.png", 640, 480],
      ["/hotlinked.png", 1200, 300], // without a Referer: the real picture
      ["/missing.png", null, null],
    ]);
    expect((await api("GET", `/v1/bookmarks/${id}?content=html`)).data.images).toBeNull();
    expect(list[0]!.proxy).toBe(sys.ctx.images.path(list[0]!.src, ARTICLE_IMAGE_WIDTH));
    expect(list[0]!.proxy).toEndWith(`&w=${ARTICLE_IMAGE_WIDTH}&v=2`);
  });

  test("a wide picture comes resized as WebP, fetched from its site once", async () => {
    const proxy = sys.ctx.images.path(`${base}/wide.png`, ARTICLE_IMAGE_WIDTH)!;
    const before = served.get("/wide.png") ?? 0;
    // Asked for twice at once (a reader asks for all of an article's at once).
    const [first, twin] = await Promise.all([app.request(proxy), app.request(proxy)]);
    expect([first.status, twin.status]).toEqual([200, 200]);
    expect(first.headers.get("content-type")).toBe("image/webp");
    expect(first.headers.get("x-lofu-cache")).toBe("miss");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(await new Bun.Image(bytes).metadata()).toEqual({
      width: ARTICLE_IMAGE_WIDTH,
      height: 170,
      format: "webp",
    });
    expect((await twin.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    // From the disk afterwards.
    const again = await app.request(proxy);
    expect(again.headers.get("x-lofu-cache")).toBe("hit");
    expect(again.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    expect(served.get("/wide.png")).toBe(before + 1);

    // Without a width, the original (kept on its own).
    const original = await app.request(sys.ctx.images.path(`${base}/wide.png`)!);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect((await new Bun.Image(await original.arrayBuffer()).metadata()).width).toBe(2720);
  });

  test("a narrow picture is left as it is; other widths are refused", async () => {
    const res = await app.request(sys.ctx.images.path(`${base}/narrow.png`, ARTICLE_IMAGE_WIDTH)!);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await new Bun.Image(await res.arrayBuffer()).metadata()).width).toBe(400);
    const odd = sys.ctx.images.path(`${base}/narrow.png`)!.concat("&w=123");
    expect((await app.request(odd)).status).toBe(400);
  });

  test("load through the signed proxy, without a token or a Referer", async () => {
    const hotlinked = (await images())[1]!;
    const res = await app.request(hotlinked.proxy!, {
      headers: { referer: "https://reader.test/" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(imageSize(new Uint8Array(await res.arrayBuffer()))).toEqual({
      width: 1200,
      height: 300,
    });

    // The signature covers the URL: no fetching anything else through it.
    const other = hotlinked.proxy!.replace(
      /\?u=.*/,
      `?u=${encodeURIComponent(`${base}/photo.png`)}`,
    );
    expect((await app.request(other)).status).toBe(403);
    expect((await app.request(`/img/forged?u=${encodeURIComponent(hotlinked.src)}`)).status).toBe(
      403,
    );
    // Upstream errors and non-images don't pass through as such, and aren't cached.
    const missing = await app.request((await images())[2]!.proxy!);
    expect([missing.status, missing.headers.get("cache-control")]).toEqual([502, "no-store"]);
  });

  test("covers load through the proxy too, relative ones resolved against the page", async () => {
    // A hotlink-protected cover (WeChat, CSDN), stored relative as old rows may be.
    const b = await api("PATCH", `/v1/bookmarks/${id}`, { coverUrl: "/hotlinked.png" });
    expect(b.data.coverProxy).toBe(sys.ctx.images.path(`${base}/hotlinked.png`));
    // The reader's page sends its own Referer; the proxy doesn't pass it on.
    const res = await app.request(b.data.coverProxy, {
      headers: { referer: "https://reader.test/" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(imageSize(new Uint8Array(await res.arrayBuffer()))).toEqual({
      width: 1200,
      height: 300,
    });
    const listed = (await api("GET", "/v1/bookmarks")).data.items;
    expect(listed.find((x: { id: string }) => x.id === id).coverProxy).toBe(b.data.coverProxy);
  });

  test("content saved before sizes existed is measured by a backfill", async () => {
    sys.ctx.db.query("UPDATE contents SET images = NULL").run();
    expect((await images())[0]!.width).toBeNull();
    const jobs = new JobStore(sys.ctx.db, { changed() {}, jobEnqueued: () => sys.runner.kick() });
    jobs.enqueueMissing("images", sys.ctx.bookmarks.unmeasuredImages());
    await sys.runner.idle();
    expect((await images())[0]!.width).toBe(640);
  });

  test("a re-extraction measures again; a stale measurement isn't saved over it", async () => {
    const before = sys.ctx.bookmarks.markdownForImages(id)!;
    sys.ctx.bookmarks.saveImageSizes(id, before.extractedAt - 1, {});
    expect((await images())[0]!.width).toBe(640);
    await api("POST", `/v1/bookmarks/${id}/refetch`);
    await sys.runner.idle();
    expect((await images())[0]!.width).toBe(640);
  });
});

test("the image cache keeps the most recently used within its size, across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lofu-cache-test-"));
  try {
    const kb = new Uint8Array(1000);
    const cache = new ImageCache(dir, 2500);
    await cache.put("a", "image/png", kb);
    await cache.put("b", "image/webp", kb);
    cache.get("a"); // used: "b" is now the oldest
    await cache.put("c", "image/jpeg", kb);
    expect([cache.get("a")?.type, cache.get("b"), cache.get("c")?.type]).toEqual([
      "image/png",
      null,
      "image/jpeg",
    ]);
    expect(cache.size).toBe(2000);
    expect(readdirSync(dir).sort()).toEqual(["a.png", "c.jpg"]);
    // Types it can't name aren't kept; a write cut short is cleared on opening.
    await cache.put("d", "image/x-unknown", kb);
    writeFileSync(join(dir, "e.png.123.tmp"), kb);
    const reopened = new ImageCache(dir, 2500);
    expect(reopened.size).toBe(2000);
    expect(reopened.get("c")?.path).toBe(join(dir, "c.jpg"));
    expect(readdirSync(dir).sort()).toEqual(["a.png", "c.jpg"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * An animated GIF: a first frame covering the canvas, then 1×1 frames.
 * Its LZW is uncompressed: 7-bit literals with a clear code every 126, so
 * every code is one byte.
 */
function animatedGif(w: number, h: number, frames: number): Uint8Array<ArrayBuffer> {
  const palette = Array.from({ length: 128 }, (_, i) => [i * 2, 255 - i * 2, 128]).flat();
  const b = [...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0xf6, 0, 0, ...palette];
  const frame = (fw: number, fh: number) => {
    b.push(0x2c, 0, 0, 0, 0, fw & 255, fw >> 8, fh & 255, fh >> 8, 0, 7);
    const codes: number[] = [];
    for (let i = 0; i < fw * fh; i++) {
      if (i % 126 === 0) codes.push(128);
      codes.push(i % 128);
    }
    codes.push(129);
    for (let i = 0; i < codes.length; i += 255) {
      const block = codes.slice(i, i + 255);
      b.push(block.length, ...block);
    }
    b.push(0);
  };
  frame(w, h);
  for (let i = 1; i < frames; i++) frame(1, 1);
  b.push(0x3b);
  return new Uint8Array(b);
}

describe("animated GIFs", () => {
  test("frames are counted, up to what's asked", () => {
    expect(gifFrames(animatedGif(10, 10, 5))).toBe(5);
    expect(gifFrames(animatedGif(10, 10, 5), 2)).toBe(2);
    expect(gifFrames(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("one too heavy to play comes as a still of its first frame; a light one plays", async () => {
    // 12 frames of 1360 × 700: 46 MB decoded, past what apps decode.
    const heavy = await resizeImage({ type: "image/gif", bytes: animatedGif(1360, 700, 12) }, 1360);
    expect(heavy.type).toBe("image/webp");
    expect(await new Bun.Image(heavy.bytes).metadata()).toEqual({
      width: 1360,
      height: 700,
      format: "webp",
    });
    const light = animatedGif(100, 100, 12);
    expect(await resizeImage({ type: "image/gif", bytes: light }, 1360)).toEqual({
      type: "image/gif",
      bytes: light,
    });
  });
});
