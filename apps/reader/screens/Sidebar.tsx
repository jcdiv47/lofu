import { pixelRatio, Scroll, Text, View } from "nsh";
import { Icon, type IconName } from "../components/ui";
import { fonts, look } from "../lib/look";
import {
  collections,
  countFor,
  type Source,
  sameSource,
  syncError,
  syncing,
  tags,
} from "../lib/store";

/**
 * Where the library can be looked at from: the fixed views, collections and
 * tags. The desktop's sidebar, and the phone's first page.
 */
export function Sources(props: {
  selected: () => Source | null;
  onSelect: (s: Source) => void;
  onSettings: () => void;
  /** Phones: bigger rows, a chevron, no selection. */
  compact?: boolean;
}) {
  const phone = !!props.compact;
  const row = (source: Source, icon: IconName, label: string, testID?: string) => {
    const active = () => {
      const s = props.selected();
      return !phone && !!s && sameSource(s, source);
    };
    return (
      <View
        role="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active() }}
        testID={testID}
        onPress={() => props.onSelect(source)}
        class={
          phone
            ? "flex-row items-center gap-3 px-4"
            : "flex-row items-center gap-2.5 rounded-md px-2.5"
        }
        style={{
          height: phone ? 46 : 30,
          backgroundColor: active() ? look().selected : undefined,
        }}
        hoverStyle={
          phone ? undefined : { backgroundColor: active() ? look().selected : look().ruleSoft }
        }
        activeStyle={{ backgroundColor: look().selected }}
      >
        <Icon name={icon} size={phone ? 19 : 15} color={active() ? look().stamp : look().inkSoft} />
        <Text
          class="flex-1 truncate"
          style={{
            color: look().ink,
            fontSize: phone ? 16 : 13.5,
            fontWeight: active() ? "600" : "400",
          }}
        >
          {label}
        </Text>
        <Text
          style={{
            color: look().inkFaint,
            fontSize: phone ? 15 : 12,
            fontVariant: ["tabular-nums"],
          }}
        >
          {countFor(source) || ""}
        </Text>
        <If when={phone}>
          <Icon name="chevron" size={14} color={look().inkFaint} />
          {/* iOS's inset separator, from the text's leading edge. */}
          <View
            class="absolute right-0 bottom-0"
            style={{ left: 50, height: 1 / pixelRatio(), backgroundColor: look().rule }}
          />
        </If>
      </View>
    );
  };

  const heading = (label: string) => (
    <Text
      class={phone ? "px-4 pt-6 pb-2" : "px-2.5 pt-5 pb-1.5"}
      style={{
        color: look().inkFaint,
        fontSize: phone ? 13 : 11,
        fontWeight: "600",
        letterSpacing: phone ? 0 : 0.6,
      }}
    >
      {phone ? label : label.toUpperCase()}
    </Text>
  );

  // Phones group rows into inset cards, as iOS's own lists do.
  const group = (children: unknown) =>
    phone ? (
      <View class="mx-4 overflow-hidden rounded-xl" style={{ backgroundColor: look().card }}>
        {children as never}
      </View>
    ) : (
      <View class="gap-px px-2">{children as never}</View>
    );

  return (
    <View class="flex-1">
      <Scroll class="flex-1" contentClass={phone ? "pb-10" : "pb-4"}>
        {group(
          <>
            {row({ kind: "all" }, "all", "All bookmarks", "source-all")}
            {row({ kind: "unsorted" }, "inbox", "Unsorted", "source-unsorted")}
            {row({ kind: "favorites" }, "star", "Favorites", "source-favorites")}
            {row({ kind: "highlights" }, "highlighter", "Highlights", "source-highlights")}
            {row({ kind: "archive" }, "archive", "Archive", "source-archive")}
          </>,
        )}
        <If when={collections().length}>
          {heading("Collections")}
          {group(
            <Each of={collections()} key={(c) => c.id}>
              {(c) => row({ kind: "collection", id: c().id }, "folder", c().name)}
            </Each>,
          )}
        </If>
        <If when={tags().length}>
          {heading("Tags")}
          {group(
            <Each of={tags()} key={(t) => t.name}>
              {(t) => row({ kind: "tag", name: t().name }, "hash", t().name)}
            </Each>,
          )}
        </If>
      </Scroll>
      <View
        class={
          phone
            ? "flex-row items-center gap-2 px-5 py-3"
            : "flex-row items-center gap-2 px-3 py-2.5"
        }
        style={{ borderTopWidth: 1, borderColor: look().ruleSoft }}
      >
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: syncError() ? look().stamp : syncing() ? look().favorite : "#6f9b6a",
          }}
        />
        <Text class="flex-1 truncate" style={{ color: look().inkFaint, fontSize: 12 }}>
          {syncError() ? syncError() : syncing() ? "Syncing…" : "Up to date"}
        </Text>
        <View
          role="button"
          accessibilityLabel="Settings"
          testID="settings"
          onPress={props.onSettings}
          class="h-7 w-7 items-center justify-center rounded-md active:opacity-60"
          hoverStyle={{ backgroundColor: look().ruleSoft }}
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
