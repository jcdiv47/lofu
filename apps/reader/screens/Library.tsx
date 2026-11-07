import {
  cleanup,
  effect,
  keyboardFrame,
  List,
  platform,
  safeAreaInsets,
  signal,
  Text,
  View,
} from "nsh";
import { BookmarkCard, BookmarkRow, CARD_COVER } from "../components/BookmarkCard";
import { SearchField } from "../components/SearchField";
import { SwipeRow, swipeable } from "../components/SwipeRow";
import { BottomEdge, RoundGlassButton, TopEdge } from "../components/ui";
import { setSearchFocus } from "../lib/actions";
import { api, type Bookmark, SEARCH_PAGE, type SearchHit } from "../lib/api";
import { look } from "../lib/look";
import {
  bookmark,
  bookmarksIn,
  countFor,
  loaded,
  matches,
  type Source,
  sourceTitle,
  sync,
  syncError,
  syncing,
} from "../lib/store";

const CARD_MIN = 236;
const GAP = 18;
const PAD = 24;
/** The desktop's toolbar, floating over the grid. */
const TOOLBAR = 52;
/** The phone's search capsule, floating over the list. */
const SEARCH_H = 48;

/** Search filters that the server's search understands, for a source. */
const searchFilter = (s: Source) => ({
  // The Trash is what the server calls archived; it stays out of other searches.
  archived: s.kind === "trash",
  ...sourceFilter(s),
});
const sourceFilter = (s: Source) =>
  s.kind === "collection"
    ? { collectionId: s.id }
    : s.kind === "unsorted"
      ? { collectionId: "unsorted" }
      : s.kind === "tag"
        ? { tags: s.name }
        : s.kind === "favorites"
          ? { favorite: true }
          : s.kind === "type"
            ? { type: s.type }
            : {};

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
      case "trash":
        return {
          title: "Trash is empty",
          body: "Deleted bookmarks wait here. Delete them again to remove them for good.",
        };
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
  /** A search to start with (typed on the phone's Library page). */
  initialQuery?: string;
  /** Desktops draw their own toolbar; leading room for the sidebar toggle or traffic lights. */
  toolbarInset?: number;
}) {
  const query = signal(props.initialQuery ?? "");
  const hits = signal<SearchHit[] | null>(null);
  /** How many the server found (it counts them roughly). */
  const total = signal(0);
  cleanup(() => setSearchFocus(null));
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
        if (mine === generation) {
          hits.set(r.hits);
          total.set(r.estimatedTotal ?? r.hits.length);
        }
      } catch {
        if (mine === generation) {
          hits.set([]);
          total.set(0);
        }
      }
    }, 180);
    cleanup(() => clearTimeout(timer));
  });

  /** The next page of hits, as the list nears its end. */
  let paging = false;
  const loadMore = async () => {
    const h = hits();
    const q = query().trim();
    if (!q || !h || paging || h.length >= total() || h.length % SEARCH_PAGE !== 0) return;
    paging = true;
    const mine = generation;
    try {
      const r = await api.search(q, searchFilter(props.source), h.length);
      if (mine === generation) {
        const seen = new Set(h.map((x) => x.bookmark.id));
        hits.set([...h, ...r.hits.filter((x) => !seen.has(x.bookmark.id))]);
        if (!r.hits.length) total.set(h.length);
      }
    } catch {
      // Offline, say: the hits so far stay.
    } finally {
      paging = false;
    }
  };

  type Item = { b: Bookmark; snippet: string | null };
  const items = (): Item[] => {
    const h = hits();
    // The hits as the store has them now: a hit deleted, put back or moved
    // out of this source since the search leaves it.
    if (searching() && h)
      return h.flatMap((x) => {
        const b = bookmark(x.bookmark.id);
        return b && !b.deletedAt && matches(props.source, b) ? [{ b, snippet: x.snippet }] : [];
      });
    if (searching()) return [];
    return bookmarksIn(props.source).map((b) => ({ b, snippet: null }));
  };
  const showCollection = props.source.kind !== "collection";

  // Columns follow the width the grid gets.
  const width = signal(0);
  const columns = () => Math.max(1, Math.floor((width() - PAD * 2 + GAP) / (CARD_MIN + GAP)));

  // The toolbar floats over the grid: the cards scroll under its glass, and
  // the page fades out beneath it (the scroll edge) so the title stays legible.
  const toolbar = () => (
    <>
      <View
        class="absolute top-0 right-0 left-0"
        style={{ height: TOOLBAR + 28, backgroundImage: look().edgeFade, pointerEvents: "none" }}
      />
      <View
        desktop={{ windowDrag: true }}
        class="absolute top-0 right-0 left-0 flex-row items-center gap-2.5 pr-4"
        style={{ height: TOOLBAR + 8, paddingTop: 8, paddingLeft: (props.toolbarInset ?? 0) + PAD }}
      >
        <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text
            class="truncate"
            style={{ color: look().ink, fontSize: 20, fontWeight: "700", flexShrink: 1 }}
          >
            {sourceTitle(props.source)}
          </Text>
          <Text style={{ color: look().inkFaint, fontSize: 13, fontVariant: ["tabular-nums"] }}>
            {searching() ? (hits() ? `${total()} found` : "") : countFor(props.source) || ""}
          </Text>
        </View>
        <View style={{ width: 280 }}>
          <SearchField
            value={query}
            onChange={(v) => query.set(v)}
            placeholder="Search titles and text"
            inputRef={(r) => setSearchFocus(() => r.focus())}
          />
        </View>
        <RoundGlassButton
          name="refresh"
          label="Sync now"
          testID="sync"
          onPress={() => void sync()}
          color={syncing() ? look().inkFaint : look().inkSoft}
        />
        <RoundGlassButton
          name="plus"
          label="Add bookmark"
          testID="add"
          color={look().stamp}
          prominent
          onPress={() => props.onAdd?.()}
        />
      </View>
    </>
  );

  // Phones: search sits at the bottom, in reach of the thumb, as in iOS 26,
  // and rides up with the keyboard. The keyboard's height already covers the
  // home-indicator inset, and this view runs to the screen's bottom edge, so
  // nothing is subtracted (that put the field on the keyboard's top edge).
  const insets = safeAreaInsets();
  const searchBottom = () => {
    const kb = keyboardFrame().height;
    return kb > 0 ? kb + 10 : Math.max(insets().bottom, 12) + 4;
  };
  const phoneSearch = () => (
    <View
      class="absolute right-0 left-0 flex-row items-center gap-2 px-4"
      style={{
        bottom: searchBottom(),
        pointerEvents: "box-none",
      }}
    >
      <View class="flex-1">
        <SearchField
          value={query}
          onChange={(v) => query.set(v)}
          placeholder="Search"
          height={SEARCH_H}
        />
      </View>
      <If when={props.onAdd}>
        <RoundGlassButton
          name="plus"
          label="Add bookmark"
          testID="add"
          diameter={SEARCH_H}
          size={24}
          color={look().stamp}
          prominent
          onPress={() => props.onAdd?.()}
        />
      </If>
    </View>
  );

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <If
        when={props.wide}
        else={
          <>
            <List
              each={items()}
              keyExtractor={(i) => i.b.id}
              estimatedItemSize={110}
              testID="library-list"
              class="flex-1"
              refreshing={syncing()}
              onRefresh={() => void sync()}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              contentStyle={{ paddingTop: 4, paddingBottom: SEARCH_H + 40 }}
              empty={<Empty searching={searching()} source={props.source} />}
              onLoadMore={() => void loadMore()}
            >
              {(i) =>
                swipeable ? (
                  <SwipeRow
                    b={i().b}
                    snippet={i().snippet}
                    showCollection={showCollection}
                    onOpen={() => props.onOpen(i().b)}
                  />
                ) : (
                  <BookmarkRow
                    b={i().b}
                    snippet={i().snippet}
                    showCollection={showCollection}
                    onOpen={() => props.onOpen(i().b)}
                  />
                )
              }
            </List>
            <BottomEdge height={SEARCH_H + searchBottom() + 24} />
            {phoneSearch()}
            <If when={platform.os === "ios"}>
              <TopEdge largeTitle />
            </If>
          </>
        }
      >
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
                testID="library-list"
                class="flex-1"
                contentStyle={{
                  paddingHorizontal: PAD,
                  paddingTop: TOOLBAR + 18,
                  paddingBottom: PAD,
                  rowGap: GAP,
                  columnGap: GAP,
                }}
                empty={<Empty searching={searching()} source={props.source} />}
                onLoadMore={() => void loadMore()}
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
          {toolbar()}
        </View>
      </If>
    </View>
  );
}
