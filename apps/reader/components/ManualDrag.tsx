import {
  type Bounds,
  type JSX,
  PanResponder,
  signal,
  type TouchProps,
  View,
  type ViewRef,
  type ViewStyle,
} from "nsh";
import type { Bookmark } from "../lib/api";
import { dropBookmark } from "../lib/manual";

/** A cell on screen: its bookmark and its frame in the root view. */
type Cell = { id: string; x: number; y: number; w: number; h: number };

/** What a draggable cell spreads on its root view. */
export interface DragProps {
  handlers: TouchProps;
  style: () => ViewStyle | undefined;
  ref: (r: ViewRef) => void;
}

/**
 * Raindrop's *Manual (Drag'n'drop)*: a bookmark is dragged to its place in
 * the list, in any view. The cell follows the pointer, faded; a line in the
 * accent colour marks where it lands, before or after the cell under the
 * pointer (beside it in a grid, above or below it in a list); the rest stay
 * put until it's dropped. The cells are measured as the drag starts (the
 * lists recycle their cells, so only those on screen are known): it drops
 * among the ones in view. A click still opens the bookmark.
 */
export function useManualDrag(opts: {
  /** Manual order, a wide window, no search. */
  enabled: () => boolean;
  /** The source's bookmarks as shown (its manual order). */
  order: () => Bookmark[];
  /** Neighbours side by side (cards, moodboard) or one above another (list, headlines). */
  axis: () => "x" | "y";
  /** Where the overlay is drawn: the library's content, whose frame it measures. */
  container: () => ViewRef | undefined;
}) {
  /** The mounted cells: a recycled cell's ref keeps its place and reads its bookmark anew. */
  const cells = new Map<ViewRef, () => string>();
  const drag = signal<{
    id: string;
    dx: number;
    dy: number;
    /** The cells measured at the grant, and the container's corner. */
    frames: Cell[];
    origin: { x: number; y: number };
    /** Where it lands: before or after this cell. */
    target: { id: string; after: boolean } | null;
  } | null>(null);

  const measureAll = async () => {
    const frames: Cell[] = [];
    await Promise.all(
      [...cells].map(async ([ref, id]) => {
        const m = await ref.measure();
        if (m)
          frames.push({
            id: id(),
            x: m.pagePosition.x,
            y: m.pagePosition.y,
            w: m.bounds.size.width,
            h: m.bounds.size.height,
          });
      }),
    );
    const c = await opts.container()?.measure();
    return { frames, origin: c ? c.pagePosition : { x: 0, y: 0 } };
  };

  /** The cell under the pointer (else the nearest), and which side of it. */
  const targetAt = (frames: Cell[], px: number, py: number, id: string) => {
    let best: Cell | null = null;
    let dist = Number.POSITIVE_INFINITY;
    for (const f of frames) {
      if (f.id === id) continue;
      const cx = Math.max(f.x, Math.min(px, f.x + f.w));
      const cy = Math.max(f.y, Math.min(py, f.y + f.h));
      const d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < dist) {
        dist = d;
        best = f;
      }
    }
    if (!best) return null;
    const after = opts.axis() === "x" ? px > best.x + best.w / 2 : py > best.y + best.h / 2;
    return { id: best.id, after };
  };

  const drop = (id: string, target: { id: string; after: boolean }) => {
    const all = opts.order();
    const b = all.find((x) => x.id === id);
    const rest = all.filter((x) => x.id !== id);
    const i = rest.findIndex((x) => x.id === target.id);
    if (!b || i < 0) return;
    void dropBookmark(b, rest, target.after ? i + 1 : i).catch(() => {});
  };

  /** The props of a cell showing `b` (read anew as the cell is recycled). */
  const cell = (b: () => Bookmark): DragProps => {
    let mine: ViewRef | null = null;
    /** The pointer's last place, for a release that reports none. */
    let last = { x: 0, y: 0 };
    const handlers = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => opts.enabled() && Math.hypot(g.dx, g.dy) > 5,
      onPanResponderGrant: () => {
        const id = b().id;
        drag.set({ id, dx: 0, dy: 0, frames: [], origin: { x: 0, y: 0 }, target: null });
        void measureAll().then(({ frames, origin }) => {
          const d = drag();
          if (d?.id === id) drag.set({ ...d, frames, origin });
        });
      },
      onPanResponderMove: (_, g) => {
        const d = drag();
        if (!d) return;
        last = { x: g.moveX, y: g.moveY };
        drag.set({ ...d, dx: g.dx, dy: g.dy, target: targetAt(d.frames, g.moveX, g.moveY, d.id) });
      },
      onPanResponderRelease: (_, g) => {
        const d = drag();
        drag.set(null);
        if (!d) return;
        const at = { x: g.moveX || last.x, y: g.moveY || last.y };
        // A quick drag can end before the cells were measured: measure, then drop.
        if (d.frames.length) {
          const t = targetAt(d.frames, at.x, at.y, d.id);
          if (t) drop(d.id, t);
        } else
          void measureAll().then(({ frames }) => {
            const t = targetAt(frames, at.x, at.y, d.id);
            if (t) drop(d.id, t);
          });
      },
      onPanResponderTerminate: () => drag.set(null),
    }).panHandlers;
    return {
      handlers,
      ref: (r) => {
        if (mine) cells.delete(mine);
        mine = r;
        cells.set(r, () => b().id);
      },
      style: () => {
        const d = drag();
        if (d?.id !== b().id) return undefined;
        return {
          transform: `translate(${d.dx}px, ${d.dy}px)`,
          opacity: 0.6,
          zIndex: 10,
          cursor: "grabbing",
        };
      },
    };
  };

  /** The line where the dragged bookmark lands, over the content. */
  const overlay = (): JSX.Element => {
    const line = () => {
      const d = drag();
      const t = d?.target;
      const f = t && d.frames.find((x) => x.id === t.id);
      if (!d || !t || !f) return null;
      const x = f.x - d.origin.x;
      const y = f.y - d.origin.y;
      const bounds: Bounds =
        opts.axis() === "x"
          ? {
              origin: { x: (t.after ? x + f.w + 9 : x - 9) - 1.5, y },
              size: { width: 3, height: f.h },
            }
          : { origin: { x, y: (t.after ? y + f.h : y) - 1.5 }, size: { width: f.w, height: 3 } };
      return bounds;
    };
    return (
      <If when={line()}>
        <View
          testID="drop-line"
          class="absolute bg-stamp"
          style={{
            pointerEvents: "none",
            left: line()?.origin.x ?? 0,
            top: line()?.origin.y ?? 0,
            width: line()?.size.width ?? 0,
            height: line()?.size.height ?? 0,
            borderRadius: 1.5,
            zIndex: 20,
          }}
        />
      </If>
    );
  };

  return { cell, overlay, dragging: () => drag()?.id ?? null };
}
