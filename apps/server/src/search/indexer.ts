import type { Db } from "../db/index.ts";
import type { BookmarkRow } from "../store/rows.ts";
import type { Meili } from "./meili.ts";

/** Bump when settings change; triggers a settings update (and a reindex by Meilisearch). */
const SETTINGS_VERSION = "1";
const SETTINGS = {
  searchableAttributes: [
    "title",
    "tags",
    "note",
    "highlights",
    "excerpt",
    "domain",
    "url",
    "content",
  ],
  filterableAttributes: [
    "tags",
    "collectionId",
    "domain",
    "type",
    "favorite",
    "archived",
    "createdAt",
  ],
  sortableAttributes: ["createdAt"],
  pagination: { maxTotalHits: 5000 },
};

const BATCH_ROWS = 250;
/** Meilisearch only indexes the first 65,535 positions of an attribute anyway. */
const MAX_CONTENT_CHARS = 200_000;
const SAFETY_INTERVAL_MS = 60_000;

export interface SearchDoc {
  id: string;
  url: string;
  title: string;
  excerpt: string | null;
  note: string | null;
  domain: string;
  type: string;
  tags: string[];
  collectionId: string | null;
  favorite: boolean;
  archived: boolean;
  createdAt: number;
  highlights: string[];
  content: string;
}

const dec = new TextDecoder();

/**
 * Incremental indexer driven by the global seq (see db/index.ts): it pushes
 * every bookmark with seq > cursor in batches, then advances the cursor
 * stored in `meta`. Writes call `kick()`; bursts coalesce into one pass. The
 * cursor only advances after Meilisearch reports success, so a crash or a
 * Meilisearch outage just resumes later; nothing is lost.
 */
export class Indexer {
  private running = false;
  private stopped = false;
  private dirty = false;
  private timer: Timer | null = null;
  private interval: Timer | null = null;
  private failures = 0;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private db: Db,
    private meili: Meili,
    readonly index: string,
  ) {}

  async setup(): Promise<void> {
    const key = `meili:${this.index}:settings`;
    const applied = this.db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    try {
      await this.meili.request("GET", `/indexes/${this.index}`);
    } catch {
      const t = await this.meili.request<{ taskUid: number }>("POST", "/indexes", {
        uid: this.index,
        primaryKey: "id",
      });
      await this.meili.waitForTask(t.taskUid);
    }
    if (applied?.value !== SETTINGS_VERSION) {
      const t = await this.meili.request<{ taskUid: number }>(
        "PATCH",
        `/indexes/${this.index}/settings`,
        SETTINGS,
      );
      await this.meili.waitForTask(t.taskUid, 600_000);
      this.setMeta(key, SETTINGS_VERSION);
    }
  }

  start() {
    this.interval = setInterval(() => this.kick(), SAFETY_INTERVAL_MS);
    this.kick();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) await Bun.sleep(20);
  }

  kick(delayMs = 50) {
    if (this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  /** Resolves once everything committed so far is indexed (for tests). */
  async flush(): Promise<void> {
    if (!this.running && !this.timer && this.cursor() >= this.maxSeq()) return;
    const done = new Promise<void>((r) => this.idleResolvers.push(r));
    this.kick(0);
    await done;
  }

  /** Forces a full rebuild on the next pass. */
  resetCursor() {
    this.setMeta(this.cursorKey, "0");
  }

  private get cursorKey() {
    return `meili:${this.index}:cursor`;
  }

  private cursor(): number {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(this.cursorKey);
    return row ? Number(row.value) : 0;
  }

  private maxSeq(): number {
    return (
      this.db.query<{ s: number | null }, []>("SELECT max(seq) AS s FROM bookmarks").get()?.s ?? 0
    );
  }

  private setMeta(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  private async run(): Promise<void> {
    this.running = true;
    this.dirty = false;
    try {
      while (!this.stopped) {
        const cursor = this.cursor();
        const rows = this.db
          .query<BookmarkRow, [number, number]>(
            "SELECT * FROM bookmarks WHERE seq > ? ORDER BY seq LIMIT ?",
          )
          .all(cursor, BATCH_ROWS);
        if (rows.length === 0) break;
        await this.push(rows);
        this.setMeta(this.cursorKey, String(rows.at(-1)!.seq));
      }
      this.failures = 0;
    } catch (e) {
      this.failures++;
      const backoff = Math.min(1000 * 2 ** this.failures, 60_000);
      console.error(`indexer: ${(e as Error).message}; retrying in ${backoff} ms`);
      this.running = false;
      this.kick(backoff);
      return;
    }
    this.running = false;
    if (this.dirty) this.kick(0);
    else for (const r of this.idleResolvers.splice(0)) r();
  }

  private async push(rows: BookmarkRow[]): Promise<void> {
    const live = rows.filter((r) => r.deleted_at === null);
    const deleted = rows.filter((r) => r.deleted_at !== null).map((r) => r.id);
    const tasks: number[] = [];

    if (live.length) {
      const ids = JSON.stringify(live.map((r) => r.id));
      const texts = new Map(
        this.db
          .query<{ id: string; text: Uint8Array }, [string]>(
            "SELECT bookmark_id AS id, text FROM contents WHERE bookmark_id IN (SELECT value FROM json_each(?))",
          )
          .all(ids)
          .map((r) => [
            r.id,
            dec.decode(Bun.zstdDecompressSync(r.text)).slice(0, MAX_CONTENT_CHARS),
          ]),
      );
      const highlights = new Map<string, string[]>();
      for (const h of this.db
        .query<{ bookmark_id: string; quote: string; note: string | null }, [string]>(
          `SELECT bookmark_id, quote, note FROM highlights
           WHERE deleted_at IS NULL AND bookmark_id IN (SELECT value FROM json_each(?))`,
        )
        .all(ids)) {
        const list = highlights.get(h.bookmark_id) ?? [];
        list.push(h.note ? `${h.quote}\n${h.note}` : h.quote);
        highlights.set(h.bookmark_id, list);
      }
      const docs: SearchDoc[] = live.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        excerpt: r.excerpt,
        note: r.note,
        domain: r.domain,
        type: r.type,
        tags: JSON.parse(r.tags),
        collectionId: r.collection_id,
        favorite: r.favorite === 1,
        archived: r.archived === 1,
        createdAt: r.created_at,
        highlights: highlights.get(r.id) ?? [],
        content: texts.get(r.id) ?? "",
      }));
      const t = await this.meili.request<{ taskUid: number }>(
        "POST",
        `/indexes/${this.index}/documents`,
        docs,
      );
      tasks.push(t.taskUid);
    }
    if (deleted.length) {
      const t = await this.meili.request<{ taskUid: number }>(
        "POST",
        `/indexes/${this.index}/documents/delete-batch`,
        deleted,
      );
      tasks.push(t.taskUid);
    }
    // Meilisearch auto-batches consecutive tasks, so waiting on them together is cheap.
    for (const uid of tasks) await this.meili.waitForTask(uid);
  }
}
