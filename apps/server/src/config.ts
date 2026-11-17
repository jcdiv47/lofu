import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${v}`);
  return n;
}

const dataDir = resolve(process.env.LOFU_DATA_DIR ?? "./data");

export const config = {
  /** The git commit this build came from, baked into the image (docker/server.Dockerfile). */
  commit: process.env.LOFU_COMMIT || "dev",
  port: int("LOFU_PORT", 8787),
  host: process.env.LOFU_HOST ?? "127.0.0.1",
  dataDir,
  dbPath: process.env.LOFU_DB_PATH ?? join(dataDir, "lofu.db"),
  /** The image proxy's files (derived; empty: none kept). */
  imageCacheDir: process.env.LOFU_IMAGE_CACHE_DIR ?? join(dataDir, "images"),
  /** The most they take, in MB; the least recently used go first. */
  imageCacheMb: int("LOFU_IMAGE_CACHE_MB", 2048),
  /** Extraction is CPU-bound (~0.5s for a large page), so it runs on worker threads. */
  extractWorkers: int("LOFU_EXTRACT_WORKERS", Math.max(1, Math.min(4, availableParallelism() - 1))),
  fetchConcurrency: int("LOFU_FETCH_CONCURRENCY", 8),
  fetchPerHost: int("LOFU_FETCH_PER_HOST", 2),
  fetchHostIntervalMs: int("LOFU_FETCH_HOST_INTERVAL_MS", 1000),
  /**
   * Jobs in flight. Jobs waiting on per-host limits are just parked promises,
   * so this is set well above the fetch concurrency to keep other hosts busy.
   */
  jobConcurrency: int("LOFU_JOB_CONCURRENCY", 64),
  fetchTimeoutMs: int("LOFU_FETCH_TIMEOUT_MS", 20_000),
  fetchMaxBytes: int("LOFU_FETCH_MAX_BYTES", 15 * 1024 * 1024),
  /** Try HTTP/2 first for https pages (Bun's experimental h2 client). */
  fetchHttp2: process.env.LOFU_FETCH_HTTP2 !== "0",
  /**
   * Headless-Chromium fallback: "auto" (launch a local Chromium on demand if
   * one is found), "off", or a CDP endpoint URL such as http://browser:9222.
   */
  browser: process.env.LOFU_BROWSER ?? "auto",
  chromePath: process.env.LOFU_CHROME_PATH ?? "",
  /** Extra Chromium flags, space-separated (e.g. "--no-sandbox" in containers). */
  chromeArgs: (process.env.LOFU_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
  browserConcurrency: int("LOFU_BROWSER_CONCURRENCY", 2),
  browserTimeoutMs: int("LOFU_BROWSER_TIMEOUT_MS", 25_000),
  /** Shut the launched browser down after this long without renders. */
  browserIdleMs: int("LOFU_BROWSER_IDLE_MS", 5 * 60_000),
  /** GitHub API token for README fetches; raises the limit from 60 to 5,000 an hour. */
  githubToken: process.env.LOFU_GITHUB_TOKEN || null,
  /**
   * Let fetches reach private and loopback addresses (netguard.ts). Off, a
   * saved page can't make the server request anything on its own network.
   * Turn on to bookmark pages on your LAN.
   */
  fetchPrivate: process.env.LOFU_FETCH_PRIVATE === "1",
  meiliUrl: process.env.MEILI_URL ?? "",
  meiliKey: process.env.MEILI_MASTER_KEY ?? "",
  meiliIndex: process.env.MEILI_INDEX ?? "bookmarks",
  /** Name of a Meilisearch embedder to enable hybrid search (configured in Meilisearch). */
  meiliEmbedder: process.env.MEILI_EMBEDDER ?? "",
  /**
   * Extra origins allowed to call the API from a browser (comma-separated),
   * e.g. the nsh web app's dev server. Extension origins are always allowed.
   */
  corsOrigins: (process.env.LOFU_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
  /** Disable auth entirely. Only for tests and local experiments; refused unless bound to loopback. */
  authDisabled: process.env.LOFU_AUTH_DISABLED === "1",
};

export type Config = typeof config;
