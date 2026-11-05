import type { Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/index.ts";
import { Fetcher } from "./extract/fetch.ts";
import { ExtractPool } from "./extract/pool.ts";
import { extractHandler } from "./jobs/extract.ts";
import { JobRunner } from "./jobs/runner.ts";
import { Indexer } from "./search/indexer.ts";
import { Meili } from "./search/meili.ts";
import { Searcher } from "./search/search.ts";
import { BookmarkStore } from "./store/bookmarks.ts";
import { CollectionStore } from "./store/collections.ts";
import { HighlightStore } from "./store/highlights.ts";
import type { Hooks } from "./store/hooks.ts";
import { JobStore } from "./store/jobs.ts";
import { TokenStore } from "./store/tokens.ts";

/** Builds every long-lived component. Shared by main.ts and the tests. */
export function wire(config: Config) {
  const db = openDb(config.dbPath);

  // Late-bound so stores can be built before the runner/indexer exist.
  let runner: JobRunner | null = null;
  let indexer: Indexer | null = null;
  const hooks: Hooks = {
    changed: () => indexer?.kick(),
    jobEnqueued: () => runner?.kick(),
  };

  const jobs = new JobStore(db, hooks);
  const bookmarks = new BookmarkStore(db, jobs, hooks);
  const collections = new CollectionStore(db, hooks);
  const highlights = new HighlightStore(db, bookmarks, hooks);
  const tokens = new TokenStore(db);

  const pool = new ExtractPool(config.extractWorkers);
  const fetcher = new Fetcher({
    concurrency: config.fetchConcurrency,
    perHost: config.fetchPerHost,
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.fetchMaxBytes,
    http2: config.fetchHttp2,
  });
  runner = new JobRunner(
    jobs,
    { extract: extractHandler({ bookmarks, fetcher, pool }) },
    {
      // Fetching is I/O-bound, so allow more jobs in flight than extract workers.
      concurrency: config.fetchConcurrency + config.extractWorkers,
      leaseMs: 5 * 60_000,
    },
  );

  const meili = config.meiliUrl ? new Meili(config.meiliUrl, config.meiliKey) : null;
  if (meili) indexer = new Indexer(db, meili, config.meiliIndex);
  const searcher = meili
    ? new Searcher(meili, config.meiliIndex, bookmarks, config.meiliEmbedder)
    : null;

  const ctx: AppContext = {
    config,
    db,
    bookmarks,
    collections,
    highlights,
    tokens,
    searcher,
    meiliHealthy: () => meili?.health() ?? Promise.resolve(false),
  };

  return {
    ctx,
    runner,
    indexer,
    pool,
    async start() {
      if (indexer) {
        await indexer.setup();
        indexer.start();
      }
      runner?.start();
    },
    async stop() {
      // Drain in-flight work before closing the DB: jobs depend on the pool, so
      // stop the runner first.
      await Promise.all([runner?.stop(), indexer?.stop()]);
      await pool.close();
      db.run("PRAGMA optimize");
      db.close();
    },
  };
}
