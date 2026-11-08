import type { Bookmark } from "./api";
import { manualKey, slotBetween } from "./prefs";
import { updateBookmark } from "./store";

/** The least room between two places, below which a stretch is spaced out again. */
const ROOM = 1e-3;

/**
 * Puts a bookmark at `index` of `order` (its source's manual order, without
 * it), as a drop does: one change, its `sort` the midpoint of its new
 * neighbours. Should they be too close for a number between them (bookmarks
 * imported in the same millisecond start with the same place), the smallest
 * stretch around it with room is spaced out evenly: a change for each there.
 */
export async function dropBookmark(b: Bookmark, order: readonly Bookmark[], index: number) {
  for (const { id, sort } of placesFor(b, order, index)) await updateBookmark(id, { sort });
}

/** The new places a drop gives (`dropBookmark`): those that change. */
export function placesFor(
  b: Bookmark,
  order: readonly Bookmark[],
  index: number,
): { id: string; sort: number }[] {
  const at = Math.max(0, Math.min(order.length, index));
  const sort = slotBetween(order[at - 1], order[at]);
  if (sort !== null) return sort === manualKey(b) ? [] : [{ id: b.id, sort }];
  const list = [...order];
  list.splice(at, 0, b);
  const keys = list.map(manualKey);
  // Widen [lo, hi] around the drop until the places either side leave room.
  let lo = at;
  let hi = at;
  const fits = () => {
    const below = lo > 0 ? keys[lo - 1] : null;
    const above = hi < list.length - 1 ? keys[hi + 1] : null;
    if (below === null || above === null) return true;
    return (above - below) / (hi - lo + 2) > ROOM;
  };
  while (!fits()) {
    if (lo > 0) lo--;
    if (!fits() && hi < list.length - 1) hi++;
  }
  const below = lo > 0 ? keys[lo - 1] : null;
  const above = hi < list.length - 1 ? keys[hi + 1] : null;
  const n = hi - lo + 1;
  const step = below !== null && above !== null ? (above - below) / (n + 1) : 1024;
  const first = below !== null ? below + step : above !== null ? above - n * step : 0;
  return list
    .slice(lo, hi + 1)
    .map((x, k) => ({ id: x.id, sort: first + k * step }))
    .filter((p, k) => manualKey(list[lo + k]) !== p.sort);
}
