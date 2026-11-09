import {
  cleanup,
  effect,
  keyboardFrame,
  List,
  platform,
  Scroll,
  safeAreaInsets,
  signal,
  Text,
  View,
  type ViewRef,
} from "nsh";
import { Menu } from "nsh/desktop";
import { hasQuery } from "../../../packages/shared/src/query";
import {
  BookmarkCard,
  BookmarkHeadline,
  BookmarkListRow,
  BookmarkRow,
  cardBody,
  cardCover,
  cardWidth,
  MoodboardTile,
} from "../components/BookmarkCard";
import {
  currentSort,
  currentView,
  SortButton,
  sortLabel,
  sortMenu,
  ViewButton,
  viewMenu,
} from "../components/ListControls";
import { useManualDrag } from "../components/ManualDrag";
import { nativeScrollEdges, ScrollEdge } from "../components/native";
import { useSearchBox } from "../components/SearchBox";
import { SearchField } from "../components/SearchField";
import { SwipeRow, swipeable } from "../components/SwipeRow";
import { BottomEdge, IconButton, RoundGlassButton, TopEdge } from "../components/ui";
import { setSearchFocus } from "../lib/actions";
import { api, type Bookmark, SEARCH_PAGE, type SearchHit } from "../lib/api";
import { look } from "../lib/look";
import {
  coverSize,
  prefs,
  type ShowField,
  shows,
  sortBookmarks,
  sortFor,
  viewFor,
} from "../lib/prefs";
import { tzOffset } from "../lib/search";
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
import { focusToolbarSearch, nativeToolbar, useToolbar } from "../lib/toolbar";

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
  /** Opens another source (a collection a search suggestion names). */
  onSource?: (s: Source) => void;
  /** Desktops draw their own toolbar; leading room for the sidebar toggle or traffic lights. */
  toolbarInset?: number;
}) {
  const hits = signal<SearchHit[] | null>(null);
  /** How many the server found (it counts them roughly). */
  const total = signal(0);
  cleanup(() => setSearchFocus(null));
  /** The Mac's window toolbar has the search, sync and + (`lib/toolbar.ts`). */
  const native = props.wide && nativeToolbar;
  let focusField = () => {};
  const box = useSearchBox({
    source: () => props.source,
    live: !props.wide,
    initial: props.initialQuery,
    results: () => hits()?.map((h) => h.bookmark) ?? null,
    onSource: props.onSource,
    focusField: () => focusField(),
    nativeField: native,
  });
  const query = box.query;
  const searching = () => hasQuery(box.applied());
  /** Where the Mac's toolbar field is, once it has had the keyboard. */
  let fieldFrame: { x: number; y: number; width: number; height: number } | null = null;
  const frameBounds = (f: { x: number; y: number; width: number; height: number }) => ({
    origin: { x: f.x, y: f.y },
    size: { width: f.width, height: f.height },
  });
  if (native) {
    focusField = focusToolbarSearch;
    setSearchFocus(focusToolbarSearch);
    useToolbar(() => [
      { kind: "flex" },
      // Sort and view, as Finder's: a symbol whose menu opens under it.
      ...(searching()
        ? []
        : [
            {
              kind: "button" as const,
              id: "sort",
              symbol: currentSort(props.source).symbol,
              label: `Sort by: ${sortLabel(props.source)}`,
              onPress: (at: { x: number; y: number }) =>
                void Menu.popup(sortMenu(props.source), at.x >= 0 ? at : undefined),
            },
          ]),
      {
        kind: "button",
        id: "view",
        symbol: currentView(props.source).symbol,
        label: `View: ${currentView(props.source).label}`,
        onPress: (at) => void Menu.popup(viewMenu(props.source), at.x >= 0 ? at : undefined),
      },
      { kind: "gap" },
      {
        kind: "button",
        id: "sync",
        symbol: "arrow.clockwise",
        label: "Sync now",
        disabled: syncing(),
        onPress: () => void sync(),
      },
      {
        kind: "button",
        id: "add",
        symbol: "plus",
        label: "Add bookmark",
        tint: look().stamp,
        prominent: true,
        onPress: () => props.onAdd?.(),
      },
      {
        kind: "button",
        id: "filters",
        symbol: "line.3.horizontal.decrease.circle",
        label: "Search settings / filters",
        onPress: (at) =>
          box.toggleNarrow(
            fieldFrame
              ? frameBounds(fieldFrame)
              : { origin: { x: at.x, y: at.y }, size: { width: 0, height: 0 } },
          ),
      },
      {
        kind: "search",
        id: "search",
        label: "Search",
        placeholder: "Search",
        value: query(),
        width: 260,
        onChange: (v) => box.onChange(v),
        onFocus: (f) => {
          fieldFrame = f;
          box.onFocus(frameBounds(f));
        },
        onBlur: () => box.onBlur(),
        onKey: (k) => box.key(k),
      },
    ]);
  }

  // Search as the user types, on the server (it knows the article text); a
  // later query cancels the display of an earlier one.
  let generation = 0;
  effect(() => {
    const q = box.applied().trim();
    const mine = ++generation;
    if (!hasQuery(q)) {
      hits.set(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const r = await api.search(q, { ...searchFilter(props.source), tz: tzOffset() });
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
    const q = box.applied().trim();
    if (!hasQuery(q) || !h || paging || h.length >= total() || h.length % SEARCH_PAGE !== 0) return;
    paging = true;
    const mine = generation;
    try {
      const r = await api.search(q, { ...searchFilter(props.source), tz: tzOffset() }, h.length);
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
    // A search keeps the server's order (the best match first).
    return sortBookmarks(bookmarksIn(props.source), sortFor(props.source)).map((b) => ({
      b,
      snippet: null,
    }));
  };
  const showCollection = props.source.kind !== "collection";

  // Columns follow the width the grid gets.
  const width = signal(0);
  const columnsOf = (min: number) =>
    Math.max(1, Math.floor((width() - PAD * 2 + GAP) / (min + GAP)));
  const view = () => viewFor(props.source);
  /** What the view shows of each bookmark (*Show in …*). */
  const show = (f: ShowField) => shows(view(), f);

  // Manual order: bookmarks are dragged into place (wide windows, no search).
  let content: ViewRef | undefined;
  const manual = useManualDrag({
    enabled: () => props.wide && !searching() && sortFor(props.source) === "manual",
    order: () => items().map((i) => i.b),
    axis: () => (view() === "cards" || view() === "moodboard" ? "x" : "y"),
    container: () => content,
  });

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
        style={{
          // With the window's toolbar, the title is centred on its row.
          height: native ? TOOLBAR : TOOLBAR + 8,
          paddingTop: native ? 0 : 8,
          paddingLeft: (props.toolbarInset ?? 0) + PAD,
        }}
      >
        <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text
            class="truncate"
            testID="library-title"
            style={{ color: look().ink, fontSize: 20, fontWeight: "700", flexShrink: 1 }}
          >
            {searching()
              ? hits()
                ? `${total()} ${total() === 1 ? "bookmark" : "bookmarks"} found`
                : "Searching…"
              : sourceTitle(props.source)}
          </Text>
          <Text
            class="truncate"
            style={{ color: look().inkFaint, fontSize: 13, fontVariant: ["tabular-nums"] }}
          >
            {searching()
              ? props.source.kind === "all"
                ? ""
                : `in ${sourceTitle(props.source)}`
              : countFor(props.source) || ""}
          </Text>
        </View>
        <If when={!native}>
          <View class="flex-row items-center gap-0.5">
            <If when={!searching()}>
              <SortButton source={props.source} />
            </If>
            <ViewButton source={props.source} />
          </View>
          <View style={{ width: 300 }}>
            <SearchField
              value={query}
              onChange={(v) => box.onChange(v)}
              onSubmit={() => box.key("enter")}
              placeholder="Search"
              inputRef={(r) => {
                focusField = () => r.focus();
                setSearchFocus(() => r.focus());
              }}
              boxRef={(r) => box.setAnchor(r)}
              onFocus={() => box.onFocus()}
              onBlur={() => box.onBlur()}
              trailing={
                <IconButton
                  name="sliders"
                  label="Search settings / filters"
                  testID="search-filters"
                  size={15}
                  active={box.open()}
                  onPress={() => box.toggleNarrow()}
                />
              }
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
        </If>
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
      {nativeScrollEdges && <ScrollEdge edge="bottom" />}
      <View class="flex-1">
        <SearchField
          value={query}
          onChange={(v) => box.onChange(v)}
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
        <View
          class="flex-1"
          ref={(r) => {
            content = r;
          }}
          onLayout={(e) => width.set(e.bounds.size.width)}
        >
          {() => {
            if (!width()) return null;
            const empty = <Empty searching={searching()} source={props.source} />;
            const top = TOOLBAR + 18;
            switch (view()) {
              case "list":
              case "headlines": {
                const headlines = view() === "headlines";
                return (
                  <List
                    each={items()}
                    keyExtractor={(i) => i.b.id}
                    estimatedItemSize={headlines ? 40 : 100}
                    testID="library-list"
                    class="flex-1"
                    contentStyle={{
                      paddingHorizontal: PAD - (headlines ? 12 : 16),
                      paddingTop: top - 8,
                      paddingBottom: PAD,
                    }}
                    empty={empty}
                    onLoadMore={() => void loadMore()}
                  >
                    {(i) => {
                      // Made once per cell (cells are recycled: it reads the item anew).
                      const drag = manual.cell(() => i().b);
                      return headlines ? (
                        <BookmarkHeadline
                          b={i().b}
                          drag={drag}
                          show={show}
                          snippet={i().snippet}
                          showCollection={showCollection}
                          onOpen={() => props.onOpen(i().b)}
                        />
                      ) : (
                        <BookmarkListRow
                          b={i().b}
                          drag={drag}
                          show={show}
                          coverLeft={prefs().coverPosition === "left"}
                          snippet={i().snippet}
                          showCollection={showCollection}
                          onOpen={() => props.onOpen(i().b)}
                        />
                      );
                    }}
                  </List>
                );
              }
              case "moodboard": {
                // Masonry: the items dealt to columns in turn, each column a
                // list of its own laid out in the one scroll view, so tiles
                // keep their covers' shapes and only those near the
                // viewport are made.
                const n = columnsOf(cardWidth(coverSize("moodboard")) - 20);
                const all = items();
                if (!all.length)
                  return (
                    <View class="flex-1" style={{ paddingTop: top }}>
                      {empty}
                    </View>
                  );
                const cols = Array.from({ length: n }, (_, c) => all.filter((_, k) => k % n === c));
                return (
                  <Scroll testID="library-list" class="flex-1">
                    <View
                      class="flex-row"
                      style={{
                        paddingHorizontal: PAD,
                        paddingTop: top,
                        paddingBottom: PAD,
                        gap: GAP,
                      }}
                    >
                      {cols.map((col) => (
                        <View class="min-w-0 flex-1">
                          <List
                            each={col}
                            viewport="parent"
                            keyExtractor={(i) => i.b.id}
                            estimatedItemSize={260}
                            contentStyle={{ rowGap: GAP }}
                            onLoadMore={() => void loadMore()}
                          >
                            {(i) => {
                              const drag = manual.cell(() => i().b);
                              return (
                                <MoodboardTile
                                  b={i().b}
                                  drag={drag}
                                  show={show}
                                  snippet={i().snippet}
                                  showCollection={showCollection}
                                  onOpen={() => props.onOpen(i().b)}
                                />
                              );
                            }}
                          </List>
                        </View>
                      ))}
                    </View>
                  </Scroll>
                );
              }
              default:
                return (
                  <List
                    each={items()}
                    keyExtractor={(i) => i.b.id}
                    numColumns={columnsOf(cardWidth(coverSize("cards")))}
                    estimatedItemSize={
                      (show("cover") ? cardCover(coverSize("cards")) : 0) + cardBody(show) + GAP
                    }
                    testID="library-list"
                    class="flex-1"
                    contentStyle={{
                      paddingHorizontal: PAD,
                      paddingTop: top,
                      paddingBottom: PAD,
                      rowGap: GAP,
                      columnGap: GAP,
                    }}
                    empty={empty}
                    onLoadMore={() => void loadMore()}
                  >
                    {(i) => {
                      const drag = manual.cell(() => i().b);
                      return (
                        <BookmarkCard
                          b={i().b}
                          drag={drag}
                          show={show}
                          coverHeight={cardCover(coverSize("cards"))}
                          snippet={i().snippet}
                          showCollection={showCollection}
                          onOpen={() => props.onOpen(i().b)}
                        />
                      );
                    }}
                  </List>
                );
            }
          }}
          {manual.overlay()}
          {toolbar()}
          {box.panel()}
        </View>
      </If>
    </View>
  );
}
