import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The image proxy's files on disk: what upstream sent, or its copy resized
 * for reading, so a picture is fetched from its site once rather than on
 * every view. Derived data (delete the directory at will), capped in bytes:
 * the least recently used go first. A file is `<key>.<ext>`, its type read
 * back from the extension.
 */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
};
const TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([type, ext]) => [ext, type]),
);

export interface CachedImage {
  path: string;
  type: string;
  size: number;
}

export class ImageCache {
  /** Entries in least-recently-used order (a hit moves one to the end). */
  private entries = new Map<string, CachedImage>();
  private bytes = 0;

  /** Opens `dir`, creating it, and indexes what is there (oldest first). */
  constructor(
    private dir: string,
    private maxBytes: number,
  ) {
    mkdirSync(dir, { recursive: true });
    const found: { key: string; entry: CachedImage; mtime: number }[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const dot = name.lastIndexOf(".");
      const type = TYPE[name.slice(dot + 1)];
      if (dot <= 0 || !type) {
        // A write cut short (`.tmp`) or a stranger.
        if (name.endsWith(".tmp")) unlinkQuietly(path);
        continue;
      }
      const st = statSync(path);
      found.push({
        key: name.slice(0, dot),
        entry: { path, type, size: st.size },
        mtime: st.mtimeMs,
      });
    }
    found.sort((a, b) => a.mtime - b.mtime);
    for (const f of found) {
      this.entries.set(f.key, f.entry);
      this.bytes += f.entry.size;
    }
    this.evict();
  }

  /** Whether files of this type are kept. */
  static keeps(type: string): boolean {
    return type in EXT;
  }

  get(key: string): CachedImage | null {
    const e = this.entries.get(key);
    if (!e) return null;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  /** Keeps `bytes` (written aside, then renamed: a reader never sees half a file). */
  async put(key: string, type: string, bytes: Uint8Array): Promise<void> {
    const ext = EXT[type];
    if (!ext || bytes.byteLength > this.maxBytes) return;
    const path = join(this.dir, `${key}.${ext}`);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await Bun.write(tmp, bytes);
      renameSync(tmp, path);
    } catch {
      unlinkQuietly(tmp);
      return;
    }
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.size;
      this.entries.delete(key);
      if (old.path !== path) unlinkQuietly(old.path);
    }
    this.entries.set(key, { path, type, size: bytes.byteLength });
    this.bytes += bytes.byteLength;
    this.evict();
  }

  /** Bytes kept, for tests and the log. */
  get size(): number {
    return this.bytes;
  }

  private evict() {
    for (const [key, e] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.bytes -= e.size;
      unlinkQuietly(e.path);
    }
  }
}

function unlinkQuietly(path: string) {
  try {
    unlinkSync(path);
  } catch {}
}
