import type { Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { openDb } from "./db/index.ts";
import { Browser, findChromium } from "./extract/browser.ts";
import { Fetcher } from "./extract/fetch.ts";
import { ImageProxy } from "./extract/images.ts";
import { MARKDOWN_VERSION, PLAIN_EXTRACTORS } from "./extract/markdown.ts";
import { PdfExtractor } from "./extract/pdf.ts";
import { ExtractPool } from "./extract/pool.ts";
import { extractHandler } from "./jobs/extract.ts";
import { imagesHandler } from "./jobs/images.ts";
import { markdownHandler } from "./jobs/markdown.ts";
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

  const images = ImageProxy.fromDb(db);
  const jobs = new JobStore(db, hooks);
  const bookmarks = new BookmarkStore(db, jobs, hooks, images);
  const collections = new CollectionStore(db, hooks);
  const highlights = new HighlightStore(db, bookmarks, hooks);
  const tokens = new TokenStore(db);

  const pool = new ExtractPool(config.extractWorkers);
  const pdf = new PdfExtractor(config.extractWorkers);
  if (!pdf.available)
    console.warn("poppler (pdftotext/pdfinfo) not found: PDFs will be saved without text");
  const fetcher = new Fetcher({
    concurrency: config.fetchConcurrency,
    perHost: config.fetchPerHost,
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.fetchMaxBytes,
    http2: config.fetchHttp2,
    hostIntervalMs: config.fetchHostIntervalMs,
  });
  let browser: Browser | null = null;
  const browserOpts = {
    concurrency: config.browserConcurrency,
    timeoutMs: config.browserTimeoutMs,
    idleMs: config.browserIdleMs,
  };
  if (/^https?:\/\//.test(config.browser)) {
    browser = new Browser({ kind: "connect", endpoint: config.browser }, browserOpts);
  } else if (config.browser === "auto") {
    const executable = findChromium(config.chromePath || undefined);
    if (executable) {
      browser = new Browser({ kind: "launch", executable, args: config.chromeArgs }, browserOpts);
    }
  }
  if (!browser && config.browser !== "off") {
    console.warn("no Chromium found: JavaScript-only pages won't get a browser fallback");
  }
  runner = new JobRunner(
    jobs,
    {
      extract: extractHandler({
        bookmarks,
        fetcher,
        pool,
        pdf,
        browser,
        githubToken: config.githubToken,
      }),
      images: imagesHandler({ bookmarks }),
      markdown: markdownHandler({ bookmarks, pool }),
    },
    {
      concurrency: config.jobConcurrency,
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
    images,
    searcher,
    meiliHealthy: () => meili?.health() ?? Promise.resolve(false),
  };

  return {
    ctx,
    browser,
    runner,
    indexer,
    pool,
    async start() {
      if (indexer) {
        await indexer.setup();
        indexer.start();
      }
      // Content saved before images were measured gets measured in the background.
      jobs.enqueueMissing("images", bookmarks.unmeasuredImages());
      // Articles converted by an older Markdown conversion are converted again.
      bookmarks.queueMarkdownUpgrade(MARKDOWN_VERSION, PLAIN_EXTRACTORS);
      runner?.start();
    },
    async stop() {
      // Drain in-flight work before closing the DB: jobs depend on the pool, so
      // stop the runner first.
      await Promise.all([runner?.stop(), indexer?.stop()]);
      await pool.close();
      browser?.shutdown();
      db.run("PRAGMA optimize");
      db.close();
    },
  };
}
