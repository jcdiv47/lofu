import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { Searcher } from "./search/search.ts";
import type { BookmarkStore } from "./store/bookmarks.ts";
import type { CollectionStore } from "./store/collections.ts";
import type { HighlightStore } from "./store/highlights.ts";
import type { TokenStore } from "./store/tokens.ts";

export interface AppContext {
  config: Config;
  db: Db;
  bookmarks: BookmarkStore;
  collections: CollectionStore;
  highlights: HighlightStore;
  tokens: TokenStore;
  /** null when Meilisearch is not configured. */
  searcher: Searcher | null;
  meiliHealthy(): Promise<boolean>;
}
