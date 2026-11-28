import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { ImageProxy } from "./extract/images.ts";
import type { MathPictures } from "./extract/mathPictures.ts";
import type { Searcher } from "./search/search.ts";
import type { BookmarkStore } from "./store/bookmarks.ts";
import type { CollectionStore } from "./store/collections.ts";
import type { HighlightStore } from "./store/highlights.ts";
import type { SettingsStore } from "./store/settings.ts";
import type { TokenStore } from "./store/tokens.ts";

export interface AppContext {
  config: Config;
  db: Db;
  bookmarks: BookmarkStore;
  collections: CollectionStore;
  highlights: HighlightStore;
  tokens: TokenStore;
  /** Settings every client shares (the sites not read). */
  settings: SettingsStore;
  /** Signs and serves article images (extract/images.ts). */
  images: ImageProxy;
  /** Draws and serves formulas as pictures (extract/mathPictures.ts). */
  math: MathPictures;
  /** Meilisearch when configured, else the database (search/search.ts). */
  searcher: Searcher;
  /** What the extractors can do here (GET /v1/capabilities). */
  features: { browser: boolean; pdf: boolean };
  meiliHealthy(): Promise<boolean>;
}
