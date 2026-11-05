import type { Db } from "../db/index.ts";
import type { Hooks } from "./hooks.ts";

export type JobKind = "extract";

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
  enqueue(kind: JobKind, bookmarkId: string, payload: string | null = null, runAt = Date.now()) {
    this.db
      .query(
        `INSERT INTO jobs (kind, bookmark_id, payload, run_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, bookmark_id) DO UPDATE SET
           payload = excluded.payload, run_at = excluded.run_at,
           attempts = 0, locked_until = NULL, last_error = NULL`,
      )
      .run(kind, bookmarkId, payload, runAt);
    this.hooks.jobEnqueued();
  }

  cancel(kind: JobKind, bookmarkId: string) {
    this.db.query("DELETE FROM jobs WHERE kind = ? AND bookmark_id = ?").run(kind, bookmarkId);
  }

  /** Atomically leases up to `limit` due jobs. Expired leases are re-claimable. */
  claim(limit: number, leaseMs: number): Job[] {
    const now = Date.now();
    return this.db
      .query<Job, [number, number, number, number]>(
        `UPDATE jobs SET locked_until = ?, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM jobs
           WHERE run_at <= ? AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY run_at LIMIT ?)
         RETURNING id, kind, bookmark_id, payload, run_at, attempts`,
      )
      .all(now + leaseMs, now, now, limit);
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
