import type { Fetcher, FetchResult, RequestOptions } from "../fetch.ts";

/**
 * The slice of the DOM a transform may use. Transforms get a linkedom
 * document in the worker; the server compiles without the DOM lib (it
 * clashes with the worker's), so this states the subset structurally.
 */
export interface SiteElement {
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): SiteElement | null;
  querySelectorAll(selector: string): Iterable<SiteElement>;
  append(...nodes: (SiteElement | string)[]): void;
  replaceChildren(...nodes: (SiteElement | string)[]): void;
}

export interface SiteDocument {
  body: SiteElement;
  createElement(tag: string): SiteElement;
  querySelector(selector: string): SiteElement | null;
  querySelectorAll(selector: string): Iterable<SiteElement>;
}

/** Metadata a site keeps outside the markup Defuddle reads (script variables, JSON state). */
export interface SiteMeta {
  title?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  excerpt?: string | null;
  coverUrl?: string | null;
}

export interface SiteTransform {
  /** Overrides Defuddle's metadata where set. */
  meta?: SiteMeta;
  /** The page is an error/login wall, not content (reported like a captcha). */
  blocked?: string;
}

export interface SiteContext {
  fetcher: Fetcher;
  /** Raises GitHub's API limit from 60 to 5,000 requests an hour. */
  githubToken: string | null;
}

/**
 * Extra steps for one site, around the generic fetch → Defuddle pipeline.
 * Every hook is optional; a site without a hook gets the generic behavior.
 *
 * The network hooks run on the main thread, `transform` in an extraction
 * worker (so it must not touch the DB or the network). `transform` sees HTML
 * from every source: our fetch, `fetch` below, the headless browser and the
 * browser extension, so fix pages there rather than in `fetch`.
 */
export interface SiteAdapter {
  /** Recorded as the extractor when `transform` applies. */
  name: string;
  /** Hostnames handled, subdomains included. */
  hosts: readonly string[];
  /** Options for the generic fetch of this site's pages. */
  request?: RequestOptions;
  /**
   * Fetches the page another way (an API, a raw file). Null falls back to the
   * generic fetch. Throwing a plain Error retries the job later.
   */
  fetch?(url: URL, ctx: SiteContext): Promise<FetchResult | null>;
  /**
   * Set when the headless browser never gets past this site's wall, to the
   * advice reported instead. Saves a render that always fails.
   */
  noBrowser?: string;
  /**
   * Edits the parsed page before Defuddle runs. Returns null when it does not
   * apply to this page (Defuddle then sees it untouched).
   */
  transform?(doc: SiteDocument, url: URL): SiteTransform | null;
}
