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
  port: int("LOFU_PORT", 8787),
  host: process.env.LOFU_HOST ?? "127.0.0.1",
  dataDir,
  dbPath: process.env.LOFU_DB_PATH ?? join(dataDir, "lofu.db"),
  /** Extraction is CPU-bound (~0.5s for a large page), so it runs on worker threads. */
  extractWorkers: int("LOFU_EXTRACT_WORKERS", Math.max(1, Math.min(4, availableParallelism() - 1))),
  fetchConcurrency: int("LOFU_FETCH_CONCURRENCY", 8),
  fetchPerHost: int("LOFU_FETCH_PER_HOST", 2),
  fetchTimeoutMs: int("LOFU_FETCH_TIMEOUT_MS", 20_000),
  fetchMaxBytes: int("LOFU_FETCH_MAX_BYTES", 15 * 1024 * 1024),
  /** Try HTTP/2 first for https pages (Bun's experimental h2 client). */
  fetchHttp2: process.env.LOFU_FETCH_HTTP2 !== "0",
  meiliUrl: process.env.MEILI_URL ?? "",
  meiliKey: process.env.MEILI_MASTER_KEY ?? "",
  meiliIndex: process.env.MEILI_INDEX ?? "bookmarks",
  /** Name of a Meilisearch embedder to enable hybrid search (configured in Meilisearch). */
  meiliEmbedder: process.env.MEILI_EMBEDDER ?? "",
  /** Disable auth entirely. Only for tests and local experiments. */
  authDisabled: process.env.LOFU_AUTH_DISABLED === "1",
};

export type Config = typeof config;
