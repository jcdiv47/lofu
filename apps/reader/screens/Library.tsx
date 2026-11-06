import { cleanup, effect, List, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { BookmarkCard, BookmarkRow, CARD_COVER } from "../components/BookmarkCard";
import { Icon, IconButton } from "../components/ui";
import { api, type Bookmark, type SearchHit } from "../lib/api";
import { look } from "../lib/look";
import {
  bookmarksIn,
  countFor,
  loaded,
  type Source,
  sourceTitle,
  sync,
  syncError,
  syncing,
} from "../lib/store";

const CARD_MIN = 236;
const GAP = 18;
const PAD = 24;

/** Search filters that the server's search understands, for a source. */
const searchFilter = (s: Source) =>
  s.kind === "collection"
    ? { collectionId: s.id }
    : s.kind === "unsorted"
      ? { collectionId: "unsorted" }
      : s.kind === "tag"
        ? { tags: s.name }
        : s.kind === "favorites"
          ? { favorite: true }
          : {};

/** A search field in the app's colors. */
function SearchField(props: {
  value: () => string;
  onChange: (v: string) => void;
  placeholder: string;
  height?: number;
}) {
  return (
    <View
      class="flex-row items-center gap-2 rounded-lg px-2.5"
      style={{ backgroundColor: look().field, height: props.height ?? 30 }}
    >
      <Icon name="search" size={14} color={look().inkFaint} />
      <Input
        testID="search"
        value={props.value()}
        placeholder={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onChange={({ value }) => props.onChange(value)}
        class="flex-1"
        style={{
          color: look().ink,
          fontSize: props.height && props.height > 32 ? 16 : 13.5,
          placeholderColor: look().inkFaint,
        }}
      />
      <If when={props.value()}>
        <View
          role="button"
          accessibilityLabel="Clear search"
          onPress={() => props.onChange("")}
          class="h-5 w-5 items-center justify-center rounded-full active:opacity-60"
          style={{ backgroundColor: look().inkFaint }}
        >
          <Icon name="close" size={11} color={look().field} />
        </View>
      </If>
    </View>
  );
}

function Empty(props: { searching: boolean; source: Source }) {
  const text = () => {
    if (!loaded()) return { title: "Loading your library…", body: "" };
    if (syncError() && countFor({ kind: "all" }) === 0)
      return { title: "Can't reach your server", body: syncError() };
    if (props.searching) return { title: "No matches", body: "Try fewer or different words." };
    switch (props.source.kind) {
      case "favorites":
        return { title: "No favorites yet", body: "Star a bookmark to keep it here." };
      case "highlights":
        return { title: "No highlights yet", body: "Select text while reading to highlight it." };
      case "archive":
        return { title: "Nothing archived", body: "Archive what you've finished reading." };
      default:
        return {
          title: "Nothing here yet",
          body: "Save a page with +, the browser extension or `lofu add`.",
        };
    }
  };
  return (
    <View class="items-center gap-1.5 px-8 pt-24">
      <Text style={{ color: look().inkSoft, fontSize: 16, fontWeight: "600" }}>{text().title}</Text>
      <Text class="text-center" style={{ color: look().inkFaint, fontSize: 13.5, lineHeight: 19 }}>
        {text().body}
      </Text>
    </View>
  );
}

/**
 * The bookmarks of a source, filtered by a search. A grid of cards on wide
 * windows, rows on phones.
 */
export function Library(props: {
  source: Source;
  wide: boolean;
  onOpen: (b: Bookmark) => void;
  /** The "+" that opens the add form: the desktop's toolbar, and beside the
   * phone's search field on the web, which draws no navigation header. */
  onAdd?: () => void;
  /** Desktops draw their own toolbar; leading room for the sidebar toggle or traffic lights. */
  toolbarInset?: number;
}) {
  const query = signal("");
  const hits = signal<SearchHit[] | null>(null);
  const searching = () => query().trim().length > 0;

  // Search as the user types, on the server (it knows the article text); a
  // later query cancels the display of an earlier one.
  let generation = 0;
  effect(() => {
    const q = query().trim();
    const mine = ++generation;
    if (!q) {
      hits.set(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const r = await api.search(q, searchFilter(props.source));
        if (mine === generation) hits.set(r.hits);
      } catch {
        if (mine === generation) hits.set([]);
      }
    }, 180);
    cleanup(() => clearTimeout(timer));
  });

  type Item = { b: Bookmark; snippet: string | null };
  const items = (): Item[] => {
    const h = hits();
    if (searching() && h) return h.map((x) => ({ b: x.bookmark, snippet: x.snippet }));
    if (searching()) return [];
    return bookmarksIn(props.source).map((b) => ({ b, snippet: null }));
  };
  const showCollection = props.source.kind !== "collection";

  // Columns follow the width the grid gets.
  const width = signal(0);
  const columns = () => Math.max(1, Math.floor((width() - PAD * 2 + GAP) / (CARD_MIN + GAP)));

  const toolbar = () => (
    <View
      desktop={{ windowDrag: true }}
      class="flex-row items-center gap-3 pr-4"
      style={{ height: 52, paddingLeft: (props.toolbarInset ?? 0) + PAD }}
    >
      <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
        <Text
          class="truncate"
          style={{ color: look().ink, fontSize: 17, fontWeight: "700", flexShrink: 1 }}
        >
          {sourceTitle(props.source)}
        </Text>
        <Text style={{ color: look().inkFaint, fontSize: 13, fontVariant: ["tabular-nums"] }}>
          {searching() ? (hits() ? `${hits()?.length} found` : "") : countFor(props.source) || ""}
        </Text>
      </View>
      <View style={{ width: 260 }}>
        <SearchField
          value={query}
          onChange={(v) => query.set(v)}
          placeholder="Search titles and text"
        />
      </View>
      <IconButton name="plus" label="Add bookmark" testID="add" onPress={() => props.onAdd?.()} />
      <IconButton
        name="refresh"
        label="Sync now"
        testID="sync"
        onPress={() => void sync()}
        color={syncing() ? look().inkFaint : look().inkSoft}
      />
    </View>
  );

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <If
        when={props.wide}
        else={
          <List
            each={items()}
            keyExtractor={(i) => i.b.id}
            estimatedItemSize={110}
            class="flex-1"
            refreshing={syncing()}
            onRefresh={() => void sync()}
            keyboardDismissMode="on-drag"
            header={
              <View class="flex-row items-center gap-2 px-4 pt-1 pb-2">
                <View class="flex-1">
                  <SearchField
                    value={query}
                    onChange={(v) => query.set(v)}
                    placeholder="Search"
                    height={36}
                  />
                </View>
                <If when={platform.os === "web" && props.onAdd}>
                  <IconButton
                    name="plus"
                    label="Add bookmark"
                    size={20}
                    onPress={() => props.onAdd?.()}
                  />
                </If>
              </View>
            }
            empty={<Empty searching={searching()} source={props.source} />}
          >
            {(i) => (
              <BookmarkRow
                b={i().b}
                snippet={i().snippet}
                showCollection={showCollection}
                onOpen={() => props.onOpen(i().b)}
              />
            )}
          </List>
        }
      >
        {toolbar()}
        <View class="flex-1" onLayout={(e) => width.set(e.bounds.size.width)}>
          {() => {
            const n = columns();
            if (!width()) return null;
            return (
              <List
                each={items()}
                keyExtractor={(i) => i.b.id}
                numColumns={n}
                estimatedItemSize={CARD_COVER + 112 + GAP}
                class="flex-1"
                contentStyle={{
                  paddingHorizontal: PAD,
                  paddingTop: 4,
                  paddingBottom: PAD,
                  rowGap: GAP,
                  columnGap: GAP,
                }}
                empty={<Empty searching={searching()} source={props.source} />}
              >
                {(i) => (
                  <BookmarkCard
                    b={i().b}
                    snippet={i().snippet}
                    showCollection={showCollection}
                    onOpen={() => props.onOpen(i().b)}
                  />
                )}
              </List>
            );
          }}
        </View>
      </If>
    </View>
  );
}
