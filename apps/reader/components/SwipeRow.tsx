import {
  createAnimatedValue,
  effect,
  type PressEvent,
  platform,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import {
  type At,
  canShare,
  chooseDestination,
  deleteBookmark,
  shareBookmark,
  showBookmarkMenu,
} from "../lib/actions";
import type { Bookmark } from "../lib/api";
import { look } from "../lib/look";
import { inTrash, restoreBookmark } from "../lib/store";
import { BookmarkHeadline, BookmarkRow, type Shows } from "./BookmarkCard";
import { Icon, type IconName } from "./ui";

/*
 * A phone row that swipes, as Mail's do: to the right for Move, to the left
 * for Share, Delete and More. The drag is the platform's own pan, bound to
 * an animated value on the UI thread; only the horizontal axis is bound, so
 * a vertical drag still scrolls the list. On a release the row settles open
 * or shut, by where it was heading.
 */

/** Phones swipe; desktops have the context menu, at the pointer. */
export const swipeable = platform.os === "ios" || platform.os === "android";

const BUTTON = 52;
const SLOT = 74;
/** How far each side opens. */
const LEAD = SLOT + 10;
const TRAIL_SLOTS = (n: number) => SLOT * n + 10;
/**
 * The screen's leading edge, where a drag goes back (the system's swipe
 * back) rather than opening the row: the row takes no touches there.
 */
const EDGE = 24;
/** How far a drag goes past an open side, as a rubber band. */
const STRETCH = 28;

/** The row that is open, if any: one at a time, as in Mail. */
let closeOpen: (() => void) | null = null;

/** What a drag to `x` shows, the ends stretched (the same curve as the binding). */
function shown(x: number, trail: number) {
  if (x > LEAD) return LEAD + (Math.min(x - LEAD, 120) / 120) * STRETCH;
  if (x < -trail) return -trail - (Math.min(-trail - x, 120) / 120) * STRETCH;
  return x;
}

function Action(props: {
  icon: IconName;
  label: string;
  color: string;
  /** With where it was pressed, which a menu it opens points from. */
  onPress: (e?: PressEvent) => void;
  testID?: string;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      class="items-center gap-1.5 active:opacity-60"
      style={{ width: SLOT }}
    >
      <View
        class="items-center justify-center rounded-full"
        style={{ width: BUTTON, height: BUTTON, backgroundColor: props.color }}
      >
        <Icon name={props.icon} size={23} color="#fff" />
      </View>
      <Text class="truncate" style={{ color: look().inkSoft, fontSize: 12 }}>
        {props.label}
      </Text>
    </View>
  );
}

export function SwipeRow(props: {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  snippet?: string | null;
  /** What the row shows (*Show in …*). */
  show?: Shows;
  coverLeft?: boolean;
  /** A headline (one line) rather than a row of the list. */
  headline?: boolean;
}) {
  const b = () => props.b;
  const trail = () => TRAIL_SLOTS(canShare ? 3 : 2);
  const x = createAnimatedValue(0);
  const width = signal(0);
  /** Which side is open; read in JS (the value itself lives on the UI thread). */
  const open = signal<"lead" | "trail" | null>(null);
  /** The buttons exist while a drag or an open side shows them, so a shut
   * row's are neither reached by VoiceOver nor laid out. */
  const revealed = signal(false);

  const settle = (to: number, velocity = 0) => {
    open.set(to > 0 ? "lead" : to < 0 ? "trail" : null);
    if (to === 0) {
      if (closeOpen === close) closeOpen = null;
    } else {
      if (closeOpen && closeOpen !== close) closeOpen();
      closeOpen = close;
    }
    void x.spring(to, { velocity, stiffness: 420, damping: 38 }).then(({ finished }) => {
      if (finished && open() === null) revealed.set(false);
    });
  };
  const close = () => settle(0);

  // Cells are recycled: a row scrolled in for another bookmark starts shut.
  effect(() => {
    b().id;
    untracked(() => {
      x.set(0);
      open.set(null);
      revealed.set(false);
      if (closeOpen === close) closeOpen = null;
    });
  });

  /** Runs an action from the buttons, shutting the row first. */
  const then = (run: (at?: At) => void) => (e?: PressEvent) => {
    close();
    run(e?.pagePosition);
  };

  const remove = async () => {
    const item = b();
    if (inTrash(item)) {
      // From the Trash it asks first; the row stays until it's gone.
      close();
      await deleteBookmark(item);
      return;
    }
    // Slide it out, then it leaves the list.
    open.set(null);
    if (closeOpen === close) closeOpen = null;
    await x.timing(-(width() || 400), { duration: 180 });
    await deleteBookmark(item);
  };

  const offset = x.interpolate({
    inputRange: [-trail() - 120, -trail(), LEAD, LEAD + 120],
    outputRange: [-trail() - STRETCH, -trail(), LEAD, LEAD + STRETCH],
    extrapolate: "clamp",
  });

  return (
    <View
      class="overflow-hidden"
      style={{ backgroundColor: look().paper }}
      onLayout={(e) => width.set(e.bounds.size.width)}
    >
      {/* Behind the row: Move on the leading side, the rest on the trailing. */}
      <If when={revealed()}>
        <View
          class="absolute top-0 bottom-0 left-0 flex-row items-center pl-2.5"
          style={{ width: LEAD }}
        >
          <If
            when={inTrash(b())}
            else={
              <Action
                icon="folder"
                label="Move"
                color="#0a84ff"
                testID="swipe-move"
                onPress={then((at) => void chooseDestination(b(), at))}
              />
            }
          >
            <Action
              icon="restore"
              label="Put back"
              color="#0a84ff"
              testID="swipe-restore"
              onPress={then(() => void restoreBookmark(b().id).catch(() => {}))}
            />
          </If>
        </View>
        <View
          class="absolute top-0 right-0 bottom-0 flex-row items-center justify-end pr-2.5"
          style={{ width: trail() }}
        >
          <If when={canShare}>
            <Action
              icon="share"
              label="Share…"
              color="#0a84ff"
              testID="swipe-share"
              onPress={then((at) => shareBookmark(b(), at))}
            />
          </If>
          <Action
            icon="trash"
            label="Delete"
            color="#ff453a"
            testID="swipe-delete"
            onPress={() => void remove()}
          />
          <Action
            icon="more"
            label="More"
            color="#636366"
            testID="swipe-more"
            onPress={then((at) => void showBookmarkMenu(b(), { at }))}
          />
        </View>
      </If>
      <View
        pan={{ x }}
        // Out of the edge's way; clipped, so its rows aren't hit there either.
        hitSlop={{ left: -EDGE }}
        class="overflow-hidden"
        onPanStart={() => {
          if (closeOpen && closeOpen !== close) closeOpen();
          revealed.set(true);
        }}
        onPanEnd={(e) => {
          const at = e.value?.x ?? 0;
          const heading = at + e.velocity.x * 0.2;
          const t = trail();
          // Pick up from where the row shows (a stretched end), not the finger.
          x.set(shown(at, t));
          if (e.cancelled) settle(open() === "lead" ? LEAD : open() === "trail" ? -t : 0);
          else if (heading > LEAD / 2 && open() !== "trail") settle(LEAD, e.velocity.x);
          else if (heading < -t / 2 && open() !== "lead") settle(-t, e.velocity.x);
          else settle(0, e.velocity.x);
        }}
        style={{ backgroundColor: look().paper, transform: [{ translateX: offset }] }}
      >
        <If
          when={props.headline}
          else={
            <BookmarkRow
              b={b()}
              snippet={props.snippet}
              show={props.show}
              coverLeft={props.coverLeft}
              showCollection={props.showCollection}
              // An open row shuts on a tap instead of opening the bookmark.
              onOpen={() => (open() ? close() : props.onOpen())}
            />
          }
        >
          <BookmarkHeadline
            b={b()}
            snippet={props.snippet}
            show={props.show}
            touch
            showCollection={props.showCollection}
            onOpen={() => (open() ? close() : props.onOpen())}
          />
        </If>
      </View>
    </View>
  );
}
