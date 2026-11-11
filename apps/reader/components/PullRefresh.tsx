import { cleanup, signal, untracked } from "nsh";

/** Shown at least this long, so a quick sync doesn't flash it. */
const MIN_MS = 800;

/**
 * Pull-to-refresh on the platform's own control (on iOS `UIRefreshControl`,
 * above a large title), shown at least `MIN_MS`. Give a vertical scroll view
 * or list `refreshing()` and `onRefresh`.
 */
export function pullRefresh(run: () => Promise<unknown>) {
  const refreshing = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const onRefresh = () => {
    if (untracked(refreshing)) return;
    refreshing.set(true);
    const shown = new Promise((r) => setTimeout(r, MIN_MS));
    void Promise.allSettled([run(), shown]).then(() => {
      if (alive) refreshing.set(false);
    });
  };

  return { refreshing, onRefresh };
}
