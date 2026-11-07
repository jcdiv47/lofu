import { Scroll, Text, View } from "nsh";
import { Icon, type IconName } from "../components/ui";
import { showSourceMenu } from "../lib/actions";
import { fonts, look } from "../lib/look";
import { sortedCollections, sortedTags } from "../lib/prefs";
import {
  countFor,
  offline,
  outbox,
  type Source,
  sameSource,
  syncError,
  syncing,
} from "../lib/store";

/** The sync line under the sources: phones' Library page says the same. */
export const syncStatus = () => {
  const waiting = outbox().length;
  const pending = waiting ? ` · ${waiting} change${waiting === 1 ? "" : "s"} waiting` : "";
  if (offline()) return `Offline${pending}`;
  if (syncError()) return syncError();
  if (syncing()) return "Syncing…";
  return waiting ? `Sending${pending}` : "Up to date";
};

/**
 * Where the library can be looked at from, in the desktop's sidebar: the
 * fixed views, collections and tags, and the Trash at the foot (phones have
 * `Home`).
 */
export function Sources(props: {
  selected: () => Source | null;
  onSelect: (s: Source) => void;
  onSettings: () => void;
}) {
  // On glass, selection and hover darken what's behind instead of covering it.
  const selectedBg = () => `${look().ink}17`;
  const hoverBg = () => `${look().ink}0c`;
  const row = (source: Source, icon: IconName, label: string, testID?: string) => {
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
        class="h-8 flex-row items-center gap-2.5 rounded-lg px-2.5"
        style={{ backgroundColor: active() ? selectedBg() : undefined }}
        hoverStyle={{ backgroundColor: active() ? selectedBg() : hoverBg() }}
        activeStyle={{ backgroundColor: selectedBg() }}
      >
        <Icon name={icon} size={15} color={active() ? look().stamp : look().inkSoft} />
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

  const heading = (label: string) => (
    <Text
      class="px-2.5 pt-5 pb-1.5"
      style={{ color: look().inkFaint, fontSize: 11, fontWeight: "600", letterSpacing: 0.6 }}
    >
      {label.toUpperCase()}
    </Text>
  );

  return (
    <View class="flex-1">
      <Scroll class="flex-1" contentClass="pb-4">
        <View class="gap-px px-2">
          {row({ kind: "all" }, "all", "All bookmarks", "source-all")}
          {row({ kind: "unsorted" }, "inbox", "Unsorted", "source-unsorted")}
          {row({ kind: "favorites" }, "star", "Favorites", "source-favorites")}
          {row({ kind: "highlights" }, "highlighter", "Highlights", "source-highlights")}
        </View>
        <If when={sortedCollections().length}>
          {heading("Collections")}
          <View class="gap-px px-2">
            <Each of={sortedCollections()} key={(c) => c.id}>
              {(c) => row({ kind: "collection", id: c().id }, "folder", c().name)}
            </Each>
          </View>
        </If>
        <If when={sortedTags().length}>
          {heading("Tags")}
          <View class="gap-px px-2">
            <Each of={sortedTags()} key={(t) => t.name}>
              {(t) => row({ kind: "tag", name: t().name }, "hash", t().name)}
            </Each>
          </View>
        </If>
      </Scroll>
      {/* The Trash, at the foot of the sources where it's always in reach. */}
      <View class="px-2 pb-1">{row({ kind: "trash" }, "trash", "Trash", "source-trash")}</View>
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
