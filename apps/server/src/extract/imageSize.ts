/**
 * Pixel size of an image from the first bytes of its file: PNG, GIF, JPEG
 * (EXIF orientation applied, as browsers do), WebP, BMP, AVIF/HEIC and SVG.
 * Returns null when the bytes so far don't say (yet): callers read more and
 * try again, up to a cap.
 */
export interface ImageSize {
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...b.subarray(at, at + len));

export function imageSize(b: Uint8Array): ImageSize | null {
  if (b.length < 12) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null;

  // PNG: IHDR is always the first chunk.
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    return b.length >= 24 ? ok(v.getUint32(16), v.getUint32(20)) : null;
  }
  if (ascii(b, 0, 4) === "GIF8") return ok(v.getUint16(6, true), v.getUint16(8, true));
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b, v, ok);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webp(b, v, ok);
  if (ascii(b, 0, 2) === "BM" && b.length >= 26) {
    return ok(v.getInt32(18, true), Math.abs(v.getInt32(22, true)));
  }
  if (ascii(b, 4, 4) === "ftyp") return isobmff(b, v, ok);
  return svg(b);
}

type Ok = (w: number, h: number) => ImageSize | null;

function jpeg(b: Uint8Array, v: DataView, ok: Ok): ImageSize | null {
  let orientation = 1;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null; // lost sync: not a JPEG we understand
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    const len = v.getUint16(i + 2);
    if (marker === 0xe1 && ascii(b, i + 4, 4) === "Exif") {
      orientation = exifOrientation(b, v, i + 10, i + 2 + len) ?? orientation;
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = v.getUint16(i + 5);
      const w = v.getUint16(i + 7);
      // Orientations 5-8 rotate by 90 degrees: the picture shows on its side.
      return orientation >= 5 ? ok(h, w) : ok(w, h);
    }
    i += 2 + len;
  }
  return null;
}

function exifOrientation(b: Uint8Array, v: DataView, tiff: number, end: number): number | null {
  if (end > b.length || tiff + 8 > end) return null;
  const le = ascii(b, tiff, 2) === "II";
  const ifd = tiff + v.getUint32(tiff + 4, le);
  if (ifd + 2 > end) return null;
  const n = v.getUint16(ifd, le);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null;
    if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
  }
  return null;
}

function webp(b: Uint8Array, v: DataView, ok: Ok): ImageSize | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") return ok(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
  if (chunk === "VP8L") {
    const bits = v.getUint32(21, true);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return ok(w, h);
  }
  return null;
}

/** AVIF/HEIC: the `ispe` property of the primary image, rotated by `irot`. */
function isobmff(b: Uint8Array, v: DataView, ok: Ok): ImageSize | null {
  let size: ImageSize | null = null;
  let rotated = false;
  for (let i = 8; i + 20 <= b.length; i++) {
    if (!size && b[i] === 0x69 && ascii(b, i, 4) === "ispe") {
      size = ok(v.getUint32(i + 8), v.getUint32(i + 12));
    } else if (b[i] === 0x69 && ascii(b, i, 4) === "irot") {
      rotated = (b[i + 4]! & 0x3) % 2 === 1;
    } else if (b[i] === 0x6d && ascii(b, i, 4) === "mdat") break; // properties come before the pixels
  }
  return size && rotated ? { width: size.height, height: size.width } : size;
}

/** SVG: `width`/`height` in px (or unitless), else the `viewBox`. */
function svg(b: Uint8Array): ImageSize | null {
  const head = new TextDecoder().decode(b.subarray(0, 4096));
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return null;
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag)?.[1];
  const w = Number(attr("width"));
  const h = Number(attr("height"));
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (!box) return null;
  const bw = Number(box[1]);
  const bh = Number(box[2]);
  if (!(bw > 0 && bh > 0)) return null;
  // Only one dimension given: scale the viewBox to it.
  if (w > 0) return { width: Math.round(w), height: Math.round((w * bh) / bw) };
  if (h > 0) return { width: Math.round((h * bw) / bh), height: Math.round(h) };
  return { width: Math.round(bw), height: Math.round(bh) };
}
