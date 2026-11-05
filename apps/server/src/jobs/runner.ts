import type { Job, JobKind, JobStore } from "../store/jobs.ts";

export class PermanentError extends Error {}

export interface JobHandler {
  run(job: Job): Promise<void>;
  /** Called once retries are exhausted or on a PermanentError. */
  giveUp(job: Job, error: Error): void;
}

const BACKOFF_MS = [30_000, 5 * 60_000, 60 * 60_000];
const MAX_IDLE_MS = 30_000;

/**
 * Event-driven job loop: `kick()` after enqueue runs due jobs immediately; a
 * timer covers delayed retries and expired leases. Never polls in a tight loop.
 */
export class JobRunner {
  private inFlight = 0;
  private timer: Timer | null = null;
  private scheduled = false;
  private stopped = true;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private jobs: JobStore,
    private handlers: Record<JobKind, JobHandler>,
    private opts: { concurrency: number; leaseMs: number } = {
      concurrency: 16,
      leaseMs: 5 * 60_000,
    },
  ) {}

  start() {
    this.stopped = false;
    this.kick();
  }

  /** Stops claiming new jobs and waits for in-flight ones (unfinished leases are retried on restart). */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) await Bun.sleep(20);
  }

  /** Coalesces bursts of enqueues (e.g. an import) into one claim pass. */
  kick() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  /** Resolves when no job is running or due now (for tests and shutdown). */
  idle(): Promise<void> {
    if (this.inFlight === 0 && this.jobs.nextDueIn() !== 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private tick() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const free = this.opts.concurrency - this.inFlight;
    const claimed = free > 0 ? this.jobs.claim(free, this.opts.leaseMs) : [];
    for (const job of claimed) void this.execute(job);

    if (this.inFlight === 0) {
      const due = this.jobs.nextDueIn();
      if (due === null || due > 0) for (const r of this.idleResolvers.splice(0)) r();
      this.timer = setTimeout(() => this.tick(), Math.min(due ?? MAX_IDLE_MS, MAX_IDLE_MS));
    }
  }

  private async execute(job: Job) {
    this.inFlight++;
    const handler = this.handlers[job.kind];
    try {
      await handler.run(job);
      this.jobs.complete(job.id);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const delay = BACKOFF_MS[job.attempts - 1];
      if (err instanceof PermanentError || delay === undefined) {
        this.jobs.complete(job.id);
        try {
          handler.giveUp(job, err);
        } catch (e2) {
          console.error(`job ${job.id} giveUp failed`, e2);
        }
      } else {
        this.jobs.retry(job.id, err.message, delay);
      }
    } finally {
      this.inFlight--;
      if (!this.stopped) this.tick();
    }
  }
}
