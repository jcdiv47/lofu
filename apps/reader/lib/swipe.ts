import { Swipe } from "lofu/native";
import { cleanup, platform } from "nsh";

/** Whether the Mac's two-finger swipe back can be heard here (`src/swipe.rs`). */
export const swipeBack = platform.os === "macos" && Swipe.available();

/**
 * Calls `back` when two fingers swipe right on the Mac's trackpad, as
 * Finder and Safari go back, while the calling component is mounted. Does
 * nothing elsewhere (phones have their navigation stack's own edge swipe).
 */
export function useSwipeBack(back: () => void) {
  if (!swipeBack) return;
  let live = true;
  cleanup(() => {
    live = false;
  });
  void (async () => {
    while (live) {
      // `false` is a second without a swipe: ask again, unless unmounted.
      if ((await Swipe.next()) && live) back();
    }
  })();
}
