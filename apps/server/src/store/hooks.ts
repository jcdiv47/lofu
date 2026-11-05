/**
 * Side-effect signals raised by stores after a committed write. Wired to the
 * search indexer and job runner in main.ts; no-ops in tests unless overridden.
 */
export interface Hooks {
  /** Some bookmark/collection/highlight row got a new seq. */
  changed(): void;
  /** A job was enqueued and may be due now. */
  jobEnqueued(): void;
}

export const noopHooks: Hooks = { changed() {}, jobEnqueued() {} };
