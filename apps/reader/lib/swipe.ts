import { Swipe } from "lofu/native";
import { cleanup, effect, platform } from "nsh";

/** Whether the Mac's two-finger swipe back works here (`src/swipe.rs`). */
export const swipeBack = platform.os === "macos" && Swipe.available();

/** The `testID` of the `NavStack` the swipe moves the pages of. */
export const SWIPE_STACK = "pages";

/**
 * Two fingers swiped right on the Mac's trackpad slide the top page of the
 * `NavStack` named `SWIPE_STACK` off to the right, following the fingers, as
 * in Safari (`src/swipe.rs` moves the views). When the swipe goes back, the
 * page is already out of sight and `back` pops it: the stack's pages have no
 * animation of nsh's on the desktop (`pageAnimation` in `App.tsx`). `can`
 * (reactive) says whether there's a page to go back to and nothing in the
 * way. Does nothing elsewhere (phones have their stack's own edge swipe).
 */
export function useSwipeBack(can: () => boolean, back: () => void) {
  if (!swipeBack) return;
  let live = true;
  effect(() => Swipe.enable(can()));
  cleanup(() => {
    live = false;
    Swipe.enable(false);
  });
  void (async () => {
    while (live) {
      // `false` is a second without a swipe: ask again, unless unmounted.
      if ((await Swipe.next()) && live) back();
    }
  })();
}
