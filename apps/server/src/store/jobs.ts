import type { Db } from "../db/index.ts";
import type { Hooks } from "./hooks.ts";

export type JobKind = "extract" | "images";

/** Interactive work (a link the user just saved) always runs before bulk imports. */
export const Priority = { interactive: 0, bulk: 1 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export interface Job {
  id: number;
  kind: JobKind;
  bookmark_id: string;
  payload: string | null;
  run_at: number;
  attempts: number;
}

/** Durable job queue in SQLite. One pending job per (kind, bookmark). */
export class JobStore {
  constructor(
    private db: Db,
    private hooks: Hooks,
  ) {}

  /** Must be safe to call inside another store's transaction. */
  enqueue(
    kind: JobKind,
    bookmarkId: string,
    payload: string | null = null,
    priority: Priority = Priority.interactive,
    runAt = Date.now(),
  ) {
    this.db
      .query(
        `INSERT INTO jobs (kind, bookmark_id, payload, run_at, priority) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, bookmark_id) DO UPDATE SET
           payload = excluded.payload, run_at = excluded.run_at,
           priority = min(priority, excluded.priority),
           attempts = 0, locked_until = NULL, last_error = NULL`,
      )
      .run(kind, bookmarkId, payload, runAt, priority);
    this.hooks.jobEnqueued();
  }

  /** Queues `kind` for each of `bookmarkIds` that has no such job yet (a backfill). */
  enqueueMissing(kind: JobKind, bookmarkIds: string[], priority: Priority = Priority.bulk) {
    if (bookmarkIds.length === 0) return;
    this.db
      .query(
        `INSERT INTO jobs (kind, bookmark_id, payload, run_at, priority)
         SELECT ?, value, NULL, ?, ? FROM json_each(?) WHERE true
         ON CONFLICT (kind, bookmark_id) DO NOTHING`,
      )
      .run(kind, Date.now(), priority, JSON.stringify(bookmarkIds));
    this.hooks.jobEnqueued();
  }

  cancel(kind: JobKind, bookmarkId: string) {
    this.db.query("DELETE FROM jobs WHERE kind = ? AND bookmark_id = ?").run(kind, bookmarkId);
  }

  /**
   * Atomically leases up to `limit` due jobs. Expired leases are re-claimable.
   * Interactive jobs go first, in FIFO order. Bulk jobs are picked in random
   * order so an import dominated by one site (whose fetches are paced per
   * host) doesn't hold up every other host.
   */
  claim(limit: number, leaseMs: number): Job[] {
    const now = Date.now();
    return this.db
      .query<Job, [number, number, number, number]>(
        `UPDATE jobs SET locked_until = ?, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM jobs
           WHERE run_at <= ? AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY priority, CASE WHEN priority = 0 THEN run_at END, random()
           LIMIT ?)
         RETURNING id, kind, bookmark_id, payload, run_at, attempts`,
      )
      .all(now + leaseMs, now, now, limit);
  }

  /**
   * Clears every lease. Called at startup: this process is the only worker,
   * so any lease left in the table belongs to a previous, dead process and
   * would otherwise block its job until the lease expired.
   */
  releaseAll() {
    this.db.query("UPDATE jobs SET locked_until = NULL WHERE locked_until IS NOT NULL").run();
  }

  complete(id: number) {
    this.db.query("DELETE FROM jobs WHERE id = ?").run(id);
  }

  retry(id: number, error: string, delayMs: number) {
    this.db
      .query("UPDATE jobs SET locked_until = NULL, run_at = ?, last_error = ? WHERE id = ?")
      .run(Date.now() + delayMs, error, id);
  }

  /** Milliseconds until the next job is due, or null if the queue is empty. */
  nextDueIn(): number | null {
    const row = this.db
      .query<{ t: number | null }, []>(
        "SELECT min(max(run_at, coalesce(locked_until, 0))) AS t FROM jobs",
      )
      .get();
    return row?.t == null ? null : Math.max(0, row.t - Date.now());
  }
}
