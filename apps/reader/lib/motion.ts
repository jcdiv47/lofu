import { LayoutAnimation, reduceMotion } from "nsh";

/** Durations, in milliseconds. */
export const motion = {
  fast: 180,
  base: 240,
} as const;

/**
 * Animates the next update's layout. Call it just before a change that takes
 * a bookmark out of the list in view (deleted, restored, moved elsewhere).
 * The rows below glide up into the gap, and the row that leaves fades out a
 * little faster than they move, so the gap opens before they arrive. With
 * reduced motion the rows jump.
 */
export function glideNext() {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext({
    duration: motion.base,
    update: { type: "easeInEaseOut" },
    delete: { type: "easeIn", property: "opacity", duration: motion.fast },
  });
}
