import { onSite, type Settings, type UpdateSettings } from "@lofu/shared";
import type { Db } from "../db/index.ts";
import type { Hooks } from "./hooks.ts";
import { type JobStore, Priority } from "./jobs.ts";

const SKIP_DOMAINS = "settings.skip_domains";

/**
 * Bookmarks on one of the sites in `?` (a JSON array): its domain, or one
 * under it. One statement shape whatever the list's length.
 */
const ON_SITES = `EXISTS (SELECT 1 FROM json_each(?) s
  WHERE b.domain = s.value OR substr(b.domain, -length(s.value) - 1) = '.' || s.value)`;

/**
 * Settings every client shares, kept in `meta`. Read on each extract job,
 * so they're held in memory; this process is the only writer.
 */
export class SettingsStore {
  private skip: string[];

  constructor(
    private db: Db,
    private jobs: JobStore,
    private hooks: Hooks,
  ) {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(SKIP_DOMAINS);
    this.skip = row ? (JSON.parse(row.value) as string[]) : [];
  }

  get(): Settings {
    return { skipDomains: [...this.skip] };
  }

  /** Sites whose pages aren't read (`extract` marks their bookmarks `skipped`). */
  skipDomains(): readonly string[] {
    return this.skip;
  }

  /**
   * Saves the settings given. A site added stops being read: its bookmarks
   * that failed are `skipped` now, and no longer *Unreadable*. A site taken
   * off is read again: its bookmarks skipped without content are queued.
   */
  update(patch: UpdateSettings): Settings {
    if (patch.skipDomains) {
      const next = [...new Set(patch.skipDomains)].sort();
      const added = next.filter((d) => !this.skip.includes(d));
      const removed = this.skip.filter((d) => !next.includes(d));
      const changed = this.db.transaction(() => {
        this.db
          .query(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          )
          .run(SKIP_DOMAINS, JSON.stringify(next));
        const now = Date.now();
        let n = 0;
        if (added.length) {
          const failed = this.db
            .query<{ id: string }, [string]>(
              `SELECT id FROM bookmarks b WHERE deleted_at IS NULL AND content_status = 'failed'
                 AND ${ON_SITES} ORDER BY seq`,
            )
            .all(JSON.stringify(added));
          const skip = this.db.query(
            `UPDATE bookmarks SET content_status = 'skipped', content_error = NULL,
               updated_at = ?, seq = ? WHERE id = ?`,
          );
          for (const r of failed) {
            this.jobs.cancel("extract", r.id);
            skip.run(now, this.db.nextSeq(), r.id);
          }
          n += failed.length;
        }
        if (removed.length) {
          // Unless a site still on the list covers them (`x.com` off, `mobile.x.com` on).
          const again = this.db
            .query<{ id: string; domain: string }, [string]>(
              `SELECT id, domain FROM bookmarks b WHERE deleted_at IS NULL AND content_status = 'skipped'
                 AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.bookmark_id = b.id)
                 AND ${ON_SITES} ORDER BY seq`,
            )
            .all(JSON.stringify(removed));
          const pending = this.db.query(
            `UPDATE bookmarks SET content_status = 'pending', content_error = NULL,
               updated_at = ?, seq = ? WHERE id = ?`,
          );
          for (const r of again) {
            if (onSite(r.domain, next)) continue;
            pending.run(now, this.db.nextSeq(), r.id);
            this.jobs.enqueue("extract", r.id, null, Priority.bulk);
            n++;
          }
        }
        return n;
      })();
      this.skip = next;
      if (changed) this.hooks.changed();
    }
    return this.get();
  }
}
