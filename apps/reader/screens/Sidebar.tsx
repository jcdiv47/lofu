import type { TouchProps, ViewStyle } from "nsh";
import { PanResponder, Scroll, signal, Text, View } from "nsh";
import { Icon, type IconName } from "../components/ui";
import { showSourceMenu } from "../lib/actions";
import { fonts, look } from "../lib/look";
import {
  isCollapsed,
  prefs,
  type Section,
  sortedCollections,
  sortedTags,
  toggleSection,
} from "../lib/prefs";
import {
  type BookmarkType,
  countFor,
  moveCollectionTo,
  offline,
  outbox,
  type Source,
  sameSource,
  syncError,
  syncing,
  typeTitles,
} from "../lib/store";

/** The colored glyphs of the filters, on the phone's Home and the desktop's sidebar. */
export const tint = {
  library: "#4f7fc9",
  folder: "#4f7fc9",
  favorites: "#e0a030",
  highlights: "#b8569e",
  trash: "#8d8577",
  tag: "#8d8577",
} as const;

const types: { type: BookmarkType; icon: IconName; color: string }[] = [
  { type: "article", icon: "article", color: "#e3843a" },
  { type: "video", icon: "video", color: "#a35bd6" },
  { type: "image", icon: "image", color: "#3e9e72" },
  { type: "audio", icon: "audio", color: "#d6566a" },
  { type: "document", icon: "document", color: "#33a39b" },
];

/** Favorites, Highlights and the kinds of bookmark there are any of. */
export const filters = () =>
  [
    { source: { kind: "favorites" } as Source, icon: "star" as IconName, color: tint.favorites },
    {
      source: { kind: "highlights" } as Source,
      icon: "highlighter" as IconName,
      color: tint.highlights,
    },
    ...types
      .filter((t) => countFor({ kind: "type", type: t.type }) > 0)
      .map((t) => ({
        source: { kind: "type", type: t.type } as Source,
        icon: t.icon,
        color: t.color,
      })),
  ].map((f) => ({
    ...f,
    label:
      f.source.kind === "type"
        ? typeTitles[f.source.type]
        : f.source.kind[0].toUpperCase() + f.source.kind.slice(1),
  }));

/** The sync line under the sources: phones' Library page says the same. */
export const syncStatus = () => {
  const waiting = outbox().length;
  const pending = waiting ? ` · ${waiting} change${waiting === 1 ? "" : "s"} waiting` : "";
  if (offline()) return `Offline${pending}`;
  if (syncError()) return syncError();
  if (syncing()) return "Syncing…";
  return waiting ? `Sending${pending}` : "Up to date";
};

/** A sidebar row's height and the gap under it: where a dragged collection lands. */
const ROW = 33;

/**
 * Where the library can be looked at from, in the desktop's sidebar: the
 * fixed views and the Trash, then collections, filters and tags under
 * headings that fold their section away when clicked (phones have `Home`).
 */
export function Sources(props: {
  selected: () => Source | null;
  onSelect: (s: Source) => void;
  onSettings: () => void;
}) {
  // On glass, selection and hover darken what's behind instead of covering it.
  const selectedBg = () => `${look().ink}17`;
  const hoverBg = () => `${look().ink}0c`;
  const row = (
    source: Source,
    icon: IconName,
    label: string,
    testID?: string,
    color?: string,
    /** A collection's row while it can be dragged: its touch handlers and how it's drawn mid-drag. */
    drag?: { handlers: TouchProps; style: () => ViewStyle | undefined },
  ) => {
    const active = () => {
      const s = props.selected();
      return !!s && sameSource(s, source);
    };
    return (
      <View
        role="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active() }}
        testID={testID}
        onPress={() => props.onSelect(source)}
        onContextMenu={
          source.kind === "collection" || source.kind === "tag"
            ? (e) =>
                void showSourceMenu(source, e.pagePosition, () => {
                  if (active()) props.onSelect({ kind: "all" });
                })
            : undefined
        }
        {...(drag?.handlers ?? {})}
        class="h-8 flex-row items-center gap-2.5 rounded-lg px-2.5"
        style={{ backgroundColor: active() ? selectedBg() : undefined, ...drag?.style() }}
        hoverStyle={{ backgroundColor: active() ? selectedBg() : hoverBg() }}
        activeStyle={{ backgroundColor: selectedBg() }}
      >
        <Icon name={icon} size={15} color={color ?? (active() ? look().stamp : look().inkSoft)} />
        <Text
          class="flex-1 truncate"
          style={{ color: look().ink, fontSize: 13.5, fontWeight: active() ? "600" : "400" }}
        >
          {label}
        </Text>
        <Text style={{ color: look().inkFaint, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {countFor(source) || ""}
        </Text>
      </View>
    );
  };

  /** Clicking a section's name folds it away, as Raindrop's sidebar does. */
  const heading = (section: Section, label: string) => (
    <View
      role="button"
      accessibilityLabel={isCollapsed(section) ? `Show ${label}` : `Hide ${label}`}
      accessibilityState={{ expanded: !isCollapsed(section) }}
      testID={`section-${section}`}
      onPress={() => toggleSection(section)}
      class="mx-2 mt-4 mb-0.5 flex-row items-center rounded-lg px-2.5 py-1"
      hoverStyle={{ backgroundColor: hoverBg() }}
      activeStyle={{ backgroundColor: selectedBg() }}
    >
      <Text
        class="flex-1"
        style={{ color: look().inkFaint, fontSize: 11, fontWeight: "600", letterSpacing: 0.6 }}
      >
        {label.toUpperCase()}
      </Text>
    </View>
  );

  /**
   * Collections are put in order by dragging them, as in Raindrop: the row
   * follows the pointer, faded, a line in the accent color marks where it will
   * land, and the rest stay put until it's dropped. Only in manual order (the
   * other orders aren't the user's to set); a click still selects.
   */
  const dragging = signal<{ id: string; from: number; dy: number } | null>(null);
  /** Where the dragged row lands, the gap nearest its middle: before the collection at this index (the count: at the end). */
  const slot = () => {
    const d = dragging();
    if (!d) return -1;
    const n = sortedCollections().length;
    return Math.max(0, Math.min(n, Math.round(d.from + 0.5 + d.dy / ROW)));
  };
  const draggable = (id: string, index: () => number) => {
    const handlers = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        prefs().collectionSort === "manual" && Math.abs(g.dy) > 4,
      onPanResponderGrant: () => dragging.set({ id, from: index(), dy: 0 }),
      onPanResponderMove: (_, g) => dragging.set({ id, from: index(), dy: g.dy }),
      onPanResponderRelease: () => {
        const to = slot();
        const from = dragging()?.from ?? -1;
        dragging.set(null);
        if (from >= 0 && to >= 0) void moveCollectionTo(id, to > from ? to - 1 : to);
      },
      onPanResponderTerminate: () => dragging.set(null),
    }).panHandlers;
    const style = (): ViewStyle | undefined => {
      const d = dragging();
      if (d?.id !== id) return undefined;
      return {
        transform: `translateY(${d.dy}px)`,
        opacity: 0.6,
        zIndex: 2,
        backgroundColor: selectedBg(),
        cursor: "grabbing",
      };
    };
    return { handlers, style };
  };

  return (
    <View class="flex-1">
      <Scroll class="flex-1" contentClass="pb-4">
        <View class="gap-px px-2">
          {row({ kind: "all" }, "all", "All bookmarks", "source-all")}
          {row({ kind: "unsorted" }, "inbox", "Unsorted", "source-unsorted")}
          {row({ kind: "trash" }, "trash", "Trash", "source-trash")}
        </View>
        <If when={sortedCollections().length}>
          {heading("collections", "Collections")}
          <If when={!isCollapsed("collections")}>
            <View class="gap-px px-2" testID="collections">
              <Each of={sortedCollections()} key={(c) => c.id}>
                {(c, i) =>
                  row(
                    { kind: "collection", id: c().id },
                    "folder",
                    c().name,
                    `collection-${c().id}`,
                    undefined,
                    draggable(c().id, i),
                  )
                }
              </Each>
              <If when={slot() >= 0}>
                <View
                  testID="drop-line"
                  class="absolute right-2 left-2"
                  style={{
                    pointerEvents: "none",
                    zIndex: 1,
                    top: slot() * ROW - 1.5,
                    height: 2,
                    borderRadius: 1,
                    backgroundColor: look().stamp,
                  }}
                />
              </If>
            </View>
          </If>
        </If>
        {heading("filters", "Filters")}
        <If when={!isCollapsed("filters")}>
          <View class="gap-px px-2">
            <Each of={filters()} key={(f) => f.label}>
              {(f) =>
                row(f().source, f().icon, f().label, `source-${f().label.toLowerCase()}`, f().color)
              }
            </Each>
          </View>
        </If>
        <If when={sortedTags().length}>
          {heading("tags", `Tags (${sortedTags().length})`)}
          <If when={!isCollapsed("tags")}>
            <View class="gap-px px-2">
              <Each of={sortedTags()} key={(t) => t.name}>
                {(t) => row({ kind: "tag", name: t().name }, "hash", t().name)}
              </Each>
            </View>
          </If>
        </If>
      </Scroll>
      {/* Sync status and settings, at the foot of the sidebar. */}
      <View
        class="flex-row items-center gap-2 px-3 py-2.5"
        style={{ borderTopWidth: 1, borderColor: `${look().ink}12` }}
      >
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor:
              syncError() || offline()
                ? look().stamp
                : syncing() || outbox().length
                  ? look().favorite
                  : "#6f9b6a",
          }}
        />
        <Text class="flex-1 truncate" style={{ color: look().inkFaint, fontSize: 12 }}>
          {syncStatus()}
        </Text>
        <View
          role="button"
          accessibilityLabel="Settings"
          testID="settings"
          onPress={props.onSettings}
          class="h-7 w-7 items-center justify-center rounded-full active:opacity-60"
          hoverStyle={{ backgroundColor: hoverBg() }}
        >
          <Icon name="settings" size={16} color={look().inkSoft} />
        </View>
      </View>
    </View>
  );
}

/** The wordmark, as on the extension's card. */
export function Wordmark(props: { size?: number }) {
  return (
    <Text
      style={{
        color: look().ink,
        fontSize: props.size ?? 22,
        fontStyle: "italic",
        fontFamily: fonts.serif,
      }}
    >
      lofu
    </Text>
  );
}
