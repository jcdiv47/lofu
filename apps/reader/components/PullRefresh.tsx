import { PullRefresh } from "lofu/native";
import { cleanup, platform, signal, untracked } from "nsh";

/** Shown at least this long, so a quick sync doesn't flash it. */
const MIN_MS = 800;
/** After the finger lifts, UIKit has started the control if it will. */
const CHECK_MS = 250;

/**
 * Pull-to-refresh on the platform's own control (on iOS `UIRefreshControl`,
 * above a large title).
 *
 * nsh 0.4.0 misses the pull on iOS 26: UIKit hosts the control in a
 * container of its own, and nsh sends the refresh to the node tagged on
 * the control's superview (the container's tag, 0). The control spins and
 * the app never hears of it, so it never stops. So after a drag the app
 * asks UIKit whether a control is spinning, and refreshes if so.
 *
 * Give a vertical scroll view or list `refreshing()`, `onRefresh` and
 * `onScrollDragEnd`.
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

  const onScrollDragEnd = () => {
    if (platform.os !== "ios" || untracked(refreshing)) return;
    setTimeout(async () => {
      if (alive && !untracked(refreshing) && (await PullRefresh.spinning())) onRefresh();
    }, CHECK_MS);
  };

  return { refreshing, onRefresh, onScrollDragEnd };
}
