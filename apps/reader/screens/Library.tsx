import {
  batch,
  cleanup,
  computed,
  effect,
  fontScale,
  type InputRef,
  keyboardFrame,
  List,
  platform,
  Scroll,
  type Signal,
  safeAreaInsets,
  signal,
  Text,
  untracked,
  View,
  type ViewRef,
} from "nsh";
import { Menu } from "nsh/desktop";
import { hasQuery, parseQuery } from "../../../packages/shared/src/query";
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
  applyListChoice,
  currentView,
  EntryMenu,
  FilterButton,
  filterMenu,
  filterSummary,
  type ListMenuOptions,
  listMenuEntries,
  phoneListMenu,
  SortButton,
  sortLabel,
  sortMenu,
  ViewButton,
  viewMenu,
} from "../components/ListControls";
import { useManualDrag } from "../components/ManualDrag";
import { nativeScrollEdges, ScrollEdge } from "../components/native";
import { pullRefresh } from "../components/PullRefresh";
import { useSearchBox } from "../components/SearchBox";
import { SearchField } from "../components/SearchField";
import { SwipeRow, swipeable } from "../components/SwipeRow";
import {
  BottomEdge,
  focusRing,
  Icon,
  IconButton,
  RoundGlassButton,
  TopEdge,
} from "../components/ui";
import { setSearchFocus, systemMenus } from "../lib/actions";
import { api, type Bookmark, SEARCH_PAGE, type SearchHit } from "../lib/api";
import {
  applyFilter,
  filterParts,
  isFiltered,
  type ListFilter,
  meets,
  NO_FILTER,
  searchTerms,
  without,
} from "../lib/filters";
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
import { narrowed, tzOffset } from "../lib/search";
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
import {
  contentLeft,
  type Frame,
  focusToolbarSearch,
  nativeToolbar,
  useToolbar,
} from "../lib/toolbar";

const GAP = 18;
const PAD = 24;
/** The desktop's toolbar, floating over the grid. */
const TOOLBAR = 52;
/**
 * The room the Mac's window toolbar takes at the title row's right end (view,
 * sort and filter, +, and the search field, about 480 points on macOS 26)
 * until the toolbar says where its items start (its `mark`): the title
 * truncates before them instead of running under their glass.
 */
const TOOLBAR_ITEMS = 480;
/**
 * The room the title keeps beside the window toolbar's items: they start no
 * nearer the sidebar than this (a `space`), so as the window narrows AppKit
 * narrows the search field, then folds it into a button, instead of laying
 * the items over the title.
 */
const TITLE_ROOM = 190;
/** The phone's search capsule, floating over the list. */
const SEARCH_H = 48;
/** The phone's grids: their margins and the room between cards. */
const PHONE_PAD = 16;
const PHONE_GAP = 12;
/** Moodboard tiles drawn at a time on Android, a batch more near the end. */
const MOODBOARD_BATCH = 40;
/**
 * The narrowest a phone's card or tile gets at each *Cover* size: on an
 * iPhone in portrait, three columns at the smallest, two at the default,
 * one from the middle size on (cards; the moodboard keeps two to Large).
 */
const PHONE_CARD_MIN = [104, 150, 220, 300, 420];
const PHONE_TILE_MIN = [96, 140, 160, 260, 420];

/** How long a search waits for the server before the device's own matches stand in. */
const SEARCH_WAIT = 15_000;
const withTimeout = <T,>(p: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The server didn't answer.")), SEARCH_WAIT);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/** Search filters that the server's search understands, for a source. */
const searchFilter = (s: Source) => ({
  // The Trash stays out of other searches.
  trashed: s.kind === "trash",
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

function Empty(props: {
  searching: boolean;
  source: Source;
  filtered?: boolean;
  /** A search on its way to the server. */
  pending?: boolean;
}) {
  const text = () => {
    if (!loaded()) return { title: "Loading your library…", body: "" };
    if (props.searching && props.pending) return { title: "Searching…", body: "" };
    if (syncError() && countFor({ kind: "all" }) === 0)
      return { title: "Can't reach your server", body: syncError() };
    if (props.searching) return { title: "No matches", body: "Try fewer or different words." };
    if (props.filtered)
      return { title: "Nothing matches the filter", body: "Clear it or pick another." };
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
      <Text class="text-ink-soft" style={{ fontSize: 16, fontWeight: "600" }}>
        {text().title}
      </Text>
      <Text class="text-center text-ink-faint" style={{ fontSize: 13.5, lineHeight: 19 }}>
        {text().body}
      </Text>
    </View>
  );
}

/**
 * The bookmarks of a source, filtered by a search. A grid of cards on wide
 * windows, rows on phones. `source` may change while it's shown (the
 * desktop's sidebar): the search and the filter start again, and the list
 * is made again at its top, but the page, its toolbar and its search field
 * stay.
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
  /** Phones: the list's menu (View, Sort by, Filter), open or not; the system bar's ••• opens it on iOS. */
  menu?: Signal<boolean>;
}) {
  const hits = signal<SearchHit[] | null>(null);
  /** How many the server found (it counts them roughly). */
  const total = signal(0);
  /** Phones: what narrows the list, while the page is open (`lib/filters.ts`). */
  const filter = signal<ListFilter>(NO_FILTER);
  /** The query sent to the server: what's typed and the filter's conditions it knows. */
  const serverQuery = (q: string) => [q, searchTerms(filter())].filter(Boolean).join(" ");
  cleanup(() => setSearchFocus(null));
  /** The Mac's window toolbar has the search, sync and + (`lib/toolbar.ts`). */
  const native = props.wide && nativeToolbar;
  let focusField = () => {};
  /** The app's search field (wide windows without the Mac's toolbar). */
  let fieldRef: InputRef | undefined;
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
  const pull = pullRefresh(() => sync());
  const searching = () => hasQuery(box.applied());
  const frameBounds = (f: Frame) => ({
    origin: { x: f.x, y: f.y },
    size: { width: f.width, height: f.height },
  });
  /** How far the toolbar's items reach in from the window's right edge. */
  const toolbarItems = signal(TOOLBAR_ITEMS);
  if (native) {
    focusField = focusToolbarSearch;
    setSearchFocus(focusToolbarSearch);
    useToolbar(() => [
      { kind: "space", id: "title", x: contentLeft() + PAD + TITLE_ROOM },
      { kind: "flex" },
      { kind: "mark", id: "items", onPlace: (right) => toolbarItems.set(right) },
      // What shapes the list, in one capsule (AppKit groups the items side by
      // side): view, sort and filter. They're set once per source, so the bar
      // keeps them together and out of the way of *+* and search. Their
      // symbols stay put, and the choice shows in its menu, checked (a sort's
      // own symbol read as something else, By date's clock as history); the
      // view's is the view's, as Finder's.
      {
        kind: "button",
        id: "view",
        symbol: currentView(props.source).symbol,
        label: `View: ${currentView(props.source).label}`,
        onPress: (at) => void Menu.popup(viewMenu(props.source), at.x >= 0 ? at : undefined),
      },
      // A search keeps the server's order, best match first: the item stays,
      // greyed out, since a toolbar whose items change is built again, and its
      // search field loses the keyboard.
      {
        kind: "button",
        id: "sort",
        symbol: "arrow.up.arrow.down",
        label: searching() ? "Sort by: By relevance" : `Sort by: ${sortLabel(props.source)}`,
        disabled: searching(),
        onPress: (at) => void Menu.popup(sortMenu(props.source), at.x >= 0 ? at : undefined),
      },
      // Filled while a filter is on, as Mail's; the title says how many it leaves.
      {
        kind: "button",
        id: "filter",
        symbol: isFiltered(filter())
          ? "line.3.horizontal.decrease.circle.fill"
          : "line.3.horizontal.decrease.circle",
        label: `Filter: ${filterSummary(filter())}`,
        onPress: (at) => void Menu.popup(filterMenu(menuOptions()), at.x >= 0 ? at : undefined),
      },
      { kind: "gap" },
      // The one action that adds, and the bar's one color. Sync isn't here:
      // it runs by itself, and the sidebar's foot, which says how it's going,
      // starts it (and ⌘R).
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
        kind: "search",
        id: "search",
        label: "Search",
        placeholder: "Search",
        value: query(),
        width: 240,
        onChange: (v) => box.onChange(v),
        onFocus: (f) => box.onFocus(frameBounds(f)),
        onBlur: () => box.onBlur(),
        onKey: (k) => box.key(k),
      },
    ]);
  }

  /** A search is on its way to the server: the hits shown are an earlier query's, or none. */
  const pending = signal(false);
  /** The server couldn't be reached: the hits are the device's own matches (`localHits`). */
  const onDevice = signal(false);

  // Search as the user types, on the server (it knows the article text); a
  // later query cancels the display of an earlier one.
  let generation = 0;
  effect(() => {
    const q = box.applied().trim();
    const mine = ++generation;
    if (!hasQuery(q)) {
      batch(() => {
        hits.set(null);
        pending.set(false);
        onDevice.set(false);
      });
      return;
    }
    // Read here, so a change of the filter searches again.
    const sent = serverQuery(q);
    pending.set(true);
    const timer = setTimeout(async () => {
      try {
        const r = await withTimeout(
          api.search(sent, { ...searchFilter(props.source), tz: tzOffset() }),
        );
        if (mine === generation)
          batch(() => {
            hits.set(r.hits);
            total.set(r.estimatedTotal ?? r.hits.length);
            onDevice.set(false);
            pending.set(false);
          });
      } catch {
        // Offline, or no answer: what the device has that matches, rather
        // than "No matches" for a search that never ran.
        if (mine === generation) {
          const local = localHits(q);
          batch(() => {
            hits.set(local);
            total.set(local.length);
            onDevice.set(true);
            pending.set(false);
          });
        }
      }
    }, 180);
    cleanup(() => clearTimeout(timer));
  });

  /**
   * The source's bookmarks whose title, address, description, note or tags
   * hold every word of `q` (and that meet its conditions): search without
   * the server, which alone has the articles' text.
   */
  const localHits = (q: string): SearchHit[] => {
    const words = parseQuery(q)
      .text.toLocaleLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/^"|"$/g, ""))
      .filter((w) => w && !w.startsWith("-"));
    return narrowed(bookmarksIn(props.source), q)
      .filter((b) => {
        const text = [b.title, b.url, b.excerpt, b.note, ...b.tags]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        return words.every((w) => text.includes(w));
      })
      .map((bookmark) => ({ bookmark, snippet: null }));
  };

  /** The next page of hits, as the list nears its end. */
  let paging = false;
  const loadMore = async () => {
    const h = hits();
    const q = box.applied().trim();
    if (
      !hasQuery(q) ||
      !h ||
      onDevice() ||
      paging ||
      h.length >= total() ||
      h.length % SEARCH_PAGE !== 0
    )
      return;
    paging = true;
    const mine = generation;
    try {
      const r = await api.search(
        serverQuery(q),
        { ...searchFilter(props.source), tz: tzOffset() },
        h.length,
      );
      if (mine === generation) {
        const seen = new Set(h.map((x) => x.bookmark.id));
        batch(() => {
          hits.set([...h, ...r.hits.filter((x) => !seen.has(x.bookmark.id))]);
          if (!r.hits.length) total.set(h.length);
        });
      }
    } catch {
      // Offline, say: the hits so far stay.
    } finally {
      paging = false;
    }
  };

  type Item = { b: Bookmark; snippet: string | null };
  // Computed: the views, the moodboard's columns, the filter's count and the
  // manual drag all read it, and it's worked out once per change.
  const items = computed((): Item[] => {
    const h = hits();
    // The hits as the store has them now: a hit deleted, put back or moved
    // out of this source since the search leaves it.
    if (searching() && h)
      return h.flatMap((x) => {
        const b = bookmark(x.bookmark.id);
        return b && !b.deletedAt && matches(props.source, b) && meets(filter(), b)
          ? [{ b, snippet: x.snippet }]
          : [];
      });
    if (searching()) return [];
    // A search keeps the server's order (the best match first).
    return sortBookmarks(
      applyFilter(filter(), bookmarksIn(props.source)),
      sortFor(props.source),
    ).map((b) => ({
      b,
      snippet: null,
    }));
  });
  const showCollection = () => props.source.kind !== "collection";

  /**
   * The source as a key: it changes when another source is shown, not when
   * its bookmarks do. The lists are made again for it, at their top, and
   * what was searched or filtered in the last one goes.
   */
  const sourceKey = computed(() => JSON.stringify(props.source));
  let shownKey = untracked(sourceKey);
  effect(() => {
    const key = sourceKey();
    if (key === shownKey) return;
    shownKey = key;
    untracked(() =>
      batch(() => {
        box.clear();
        filter.set(NO_FILTER);
      }),
    );
    // The field lets go of the keyboard, as the last page's went with it.
    fieldRef?.blur();
  });

  // Columns follow the width the grid gets. The width changes on every frame
  // of a live resize; the views read only what's computed from it (whether
  // it's known, the column counts), so the grid is built again only when a
  // column comes or goes, not on every frame.
  const width = signal(0);
  const measured = computed(() => width() > 0);
  const columnsOf = (min: number) =>
    Math.max(1, Math.floor((width() - PAD * 2 + GAP) / (min + GAP)));
  const cardColumns = computed(() => columnsOf(cardWidth(coverSize("cards"))));
  const moodColumns = computed(() => columnsOf(cardWidth(coverSize("moodboard")) - 20));
  /** The moodboard's columns: the items dealt to them in turn. */
  const dealt = <T,>(all: T[], n: number) =>
    Array.from({ length: n }, (_, c) => all.filter((_, k) => k % n === c));
  const moodCols = computed(() => dealt(items(), moodColumns()));
  // Computed: the phone's list is built again when the view changes, and
  // only then; not on every change of the prefs it's kept in (the same view
  // picked again, a sort, *Show in …*), which left the new list under the bar.
  const view = computed(() => viewFor(props.source));
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
          // The window toolbar's items lie over the row's right end.
          ...(native ? { paddingRight: toolbarItems() + 12 } : {}),
        }}
      >
        <View
          class="flex-row items-baseline gap-2"
          // Its own width at most, sharing what's short with the search field
          // (an iPad in portrait has no room for both at full width).
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 60 }}
        >
          <Text
            testID="library-title"
            class="truncate text-ink"
            style={{ fontSize: 20, fontWeight: "700", flexShrink: 1 }}
          >
            {searching()
              ? hits()
                ? `${total()} ${total() === 1 ? "bookmark" : "bookmarks"} found`
                : "Searching…"
              : sourceTitle(props.source)}
          </Text>
          <Text
            class="truncate text-ink-faint"
            // Gives way first, then the title: the row ends before the toolbar.
            style={{
              fontSize: 13,
              fontVariant: ["tabular-nums"],
              flexShrink: 100,
            }}
          >
            {searching()
              ? props.source.kind === "all"
                ? ""
                : `in ${sourceTitle(props.source)}`
              : isFiltered(filter())
                ? `${items().length.toLocaleString()} of ${countFor(props.source).toLocaleString()}`
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
          <View style={{ width: 300, flexShrink: 3, minWidth: 150 }}>
            <SearchField
              value={query}
              onChange={(v) => box.onChange(v)}
              onSubmit={() => box.key("enter")}
              placeholder="Search"
              inputRef={(r) => {
                fieldRef = r;
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
      class="absolute right-0 left-0 flex-row items-center gap-2"
      style={{
        bottom: searchBottom(),
        // Clear of the Dynamic Island and the corners in landscape.
        paddingLeft: 16 + insets().left,
        paddingRight: 16 + insets().right,
        pointerEvents: "box-none",
      }}
    >
      {nativeScrollEdges &&
        (() => {
          // Made again with each layout, as `TopEdge`: the scroll view is another.
          edgeLayout();
          return <ScrollEdge edge="bottom" />;
        })}
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

  // Phones: the list's menu, from the bar's ••• (iOS: the system's; Android: `PanelMenu`).
  const menuOptions = (): ListMenuOptions => ({
    source: props.source,
    filter: filter(),
    setFilter: (f) => filter.set(f),
    list: bookmarksIn(props.source),
    searching: searching(),
  });
  const openMenu = () => phoneListMenu(menuOptions());
  effect(() => {
    const m = props.menu;
    if (!m?.() || !systemMenus) return;
    // Down at once, not when the menu's done: it's done a second or two
    // after it's gone (its fade, then a wait for a choice), and the next
    // tap would set nothing. A menu still fading makes way for the new one.
    untracked(() => {
      m.set(false);
      void openMenu();
    });
  });

  /** The filter, as chips over the list: each one's ✕ drops it. */
  const filterBar = () => (
    <If when={isFiltered(filter())}>
      <View
        class="flex-row flex-wrap items-center gap-2 pt-1 pb-2"
        testID="filter-bar"
        // The cards' list pads its header as its cards already.
        style={view() === "cards" ? undefined : gridSides()}
      >
        <Each of={filterParts(filter())} key={(p) => p.key}>
          {(p) => (
            <View
              role="button"
              accessibilityLabel={`Remove filter ${p().label}`}
              testID={`filter-chip-${p().key}`}
              onPress={() => filter.set(without(filter(), p().key))}
              // 44 points to the finger, 32 to the eye.
              hitSlop={{ top: 6, bottom: 6 }}
              class={`h-8 flex-row items-center gap-1.5 rounded-full bg-selected pr-2.5 pl-3 active:opacity-60 ${focusRing}`}
            >
              <Text class="text-ink" style={{ fontSize: 14, fontWeight: "500" }}>
                {p().label}
              </Text>
              <Icon name="close" size={12} />
            </View>
          )}
        </Each>
        <Text
          class="text-ink-faint"
          style={{ fontSize: 13, fontVariant: ["tabular-nums"] }}
          testID="filter-count"
        >
          {searching()
            ? ""
            : `${items().length.toLocaleString()} of ${countFor(props.source).toLocaleString()}`}
        </Text>
      </View>
    </If>
  );

  /** The web's phone layout: the controls over the list (iOS and Android: the bar's •••). */
  const controlsBar = () => (
    <If when={!systemMenus && platform.os !== "android"}>
      <View class="flex-row items-center gap-0.5 px-2 pb-1">
        <If when={!searching()}>
          <SortButton source={props.source} />
        </If>
        <ViewButton source={props.source} />
        <FilterButton
          source={props.source}
          filter={filter()}
          setFilter={(f) => filter.set(f)}
          list={bookmarksIn(props.source)}
        />
      </View>
    </If>
  );
  /**
   * Phones: how a search is going, under the title (wide windows put it in
   * the title): on its way (a slow network shows the last query's hits
   * meanwhile), what was found, or that the device searched on its own.
   */
  const searchStatus = () => (
    // Not over the empty list's own "Searching…".
    <If when={searching() && !(pending() && !items().length)}>
      <View
        class="flex-row items-center gap-1.5 pt-1 pb-2"
        style={view() === "cards" ? undefined : gridSides()}
        testID="search-status"
      >
        <If when={onDevice() && !pending()}>
          <Icon name="alert" size={13} class="tint-ink-faint" />
        </If>
        <Text class="flex-1 text-ink-faint" style={{ fontSize: 13, lineHeight: 18 }}>
          {pending()
            ? "Searching…"
            : onDevice()
              ? "Can't reach your server: matching titles, notes and tags on this device."
              : `${total().toLocaleString()} ${total() === 1 ? "bookmark" : "bookmarks"} found`}
        </Text>
      </View>
    </If>
  );
  const header = () => (
    <>
      {controlsBar()}
      {filterBar()}
      {searchStatus()}
    </>
  );
  const phoneEmpty = () => (
    <Empty
      searching={searching()}
      pending={pending()}
      source={props.source}
      filtered={isFiltered(filter())}
    />
  );
  /** Room under the list for the search capsule floating over its end. */
  const phoneBottom = SEARCH_H + 40;
  /**
   * The phone's content keeps out of the sides' safe area: in landscape the
   * Dynamic Island and the rounded corners are there.
   */
  const sideLeft = () => insets().left;
  const sideRight = () => insets().right;
  /** The grids' margins: their own, past the safe area. */
  const gridSides = () => ({
    paddingLeft: PHONE_PAD + sideLeft(),
    paddingRight: PHONE_PAD + sideRight(),
  });
  /** The width the grids lay their columns out in. */
  const gridWidth = () => width() - sideLeft() - sideRight() - PHONE_PAD * 2;
  /** A column's width when `n` share the phone's width. */
  const phoneColumn = (n: number) => (gridWidth() - PHONE_GAP * (n - 1)) / n;
  const phoneColumns = (min: number) =>
    Math.max(1, Math.floor((gridWidth() + PHONE_GAP) / (min + PHONE_GAP)));
  /** Larger text (Dynamic Type) makes the cards' bodies taller, and wider at first. */
  const textScale = () => Math.max(1, fontScale());
  const phoneCardColumns = computed(() =>
    phoneColumns((PHONE_CARD_MIN[coverSize("cards") - 1] ?? 150) * Math.min(textScale(), 2)),
  );
  const phoneTileColumns = computed(() =>
    phoneColumns(PHONE_TILE_MIN[coverSize("moodboard") - 1] ?? 140),
  );
  /** The phone's cards: covers about 5:3, whatever their width. */
  const phoneCover = computed(() => Math.round(phoneColumn(phoneCardColumns()) * 0.6));
  const open = (b: Bookmark) => props.onOpen(b);

  /**
   * The phone's layout, built again only when the view changes, or the
   * moodboard's columns: the cards' grid takes a column more or less
   * (turning the phone) in place, but a column list made in a scroll view
   * already laid out (`viewport="parent"`) left a tile out. Each view is a
   * scroll view of its own (lists laid out in a shared one left rows of
   * differing heights out). A scroll view
   * made after the page's first is handed to UIKit by `TopEdge`, made again
   * a frame after the layout (`edgeLayout`), so that it gets the bar's inset
   * and the large title's tracking (`src/edges.rs`).
   */
  const phoneLayout = computed(() =>
    !measured() ? "" : view() === "moodboard" ? `moodboard:${phoneTileColumns()}` : view(),
  );
  const edgeLayout = signal("");
  effect(() => {
    const layout = phoneLayout();
    const frame = requestAnimationFrame(() => edgeLayout.set(layout));
    cleanup(() => cancelAnimationFrame(frame));
  });
  const phoneList = () => {
    if (!phoneLayout()) return null;
    switch (view()) {
      case "list":
      case "headlines": {
        const headlines = view() === "headlines";
        return (
          <List
            testID="library-list"
            class="flex-1"
            refreshing={pull.refreshing()}
            onRefresh={pull.onRefresh}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            each={items()}
            keyExtractor={(i) => i.b.id}
            estimatedItemSize={headlines ? 48 : 110}
            contentStyle={{
              paddingTop: 4,
              paddingBottom: phoneBottom,
              paddingLeft: sideLeft() + (headlines ? 4 : 0),
              paddingRight: sideRight() + (headlines ? 4 : 0),
            }}
            header={header()}
            empty={phoneEmpty()}
            onLoadMore={() => void loadMore()}
          >
            {(i) =>
              swipeable ? (
                <SwipeRow
                  b={i().b}
                  snippet={i().snippet}
                  show={show}
                  coverLeft={prefs().coverPosition === "left"}
                  headline={headlines}
                  showCollection={showCollection()}
                  onOpen={() => open(i().b)}
                />
              ) : headlines ? (
                <BookmarkHeadline
                  b={i().b}
                  snippet={i().snippet}
                  show={show}
                  touch
                  showCollection={showCollection()}
                  onOpen={() => open(i().b)}
                />
              ) : (
                <BookmarkRow
                  b={i().b}
                  snippet={i().snippet}
                  show={show}
                  coverLeft={prefs().coverPosition === "left"}
                  showCollection={showCollection()}
                  onOpen={() => open(i().b)}
                />
              )
            }
          </List>
        );
      }
      case "moodboard": {
        // Masonry, as on wide windows: the items dealt to columns in turn,
        // each column a list laid out in the one scroll view.
        const n = phoneTileColumns();
        /**
         * Android: plain columns, a batch more as the end comes near. Its
         * lists laid out in the one scroll view (`viewport="parent"`) left
         * tiles, or a whole column, out (nsh 0.5.0).
         */
        const plain = platform.os === "android";
        const shown = signal(MOODBOARD_BATCH);
        const cols = computed(() => dealt(plain ? items().slice(0, shown()) : items(), n));
        const tile = (i: () => Item) => (
          <MoodboardTile
            b={i().b}
            show={show}
            touch
            snippet={i().snippet}
            showCollection={showCollection()}
            onOpen={() => open(i().b)}
          />
        );
        return (
          <Scroll
            testID="library-list"
            class="flex-1"
            refreshing={pull.refreshing()}
            onRefresh={pull.onRefresh}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onScroll={(e) => {
              if (!plain || e.offset.y + e.size.height * 3 < e.contentSize.height) return;
              if (shown() < items().length) shown.set(shown() + MOODBOARD_BATCH);
              else void loadMore();
            }}
          >
            {header()}
            <If when={items().length} else={phoneEmpty()}>
              <View
                class="flex-row"
                style={{
                  ...gridSides(),
                  paddingTop: 4,
                  paddingBottom: phoneBottom,
                  gap: PHONE_GAP,
                }}
              >
                {Array.from({ length: n }, (_, c) => (
                  <View class="min-w-0 flex-1" style={plain ? { rowGap: PHONE_GAP } : undefined}>
                    {plain ? (
                      <Each of={cols()[c] ?? []} key={(i) => i.b.id}>
                        {(i) => tile(i)}
                      </Each>
                    ) : (
                      <List
                        each={cols()[c] ?? []}
                        viewport="parent"
                        keyExtractor={(i) => i.b.id}
                        estimatedItemSize={220}
                        contentStyle={{ rowGap: PHONE_GAP }}
                        onLoadMore={() => void loadMore()}
                      >
                        {(i) => tile(i)}
                      </List>
                    )}
                  </View>
                ))}
              </View>
            </If>
          </Scroll>
        );
      }
      default:
        return (
          <List
            testID="library-list"
            class="flex-1"
            refreshing={pull.refreshing()}
            onRefresh={pull.onRefresh}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            each={items()}
            keyExtractor={(i) => i.b.id}
            numColumns={phoneCardColumns()}
            estimatedItemSize={
              (show("cover") ? phoneCover() : 0) + cardBody(show) * textScale() + PHONE_GAP
            }
            contentStyle={{
              ...gridSides(),
              paddingTop: 4,
              paddingBottom: phoneBottom,
              rowGap: PHONE_GAP,
              columnGap: PHONE_GAP,
            }}
            header={header()}
            empty={phoneEmpty()}
            onLoadMore={() => void loadMore()}
          >
            {(i) => (
              <BookmarkCard
                b={i().b}
                show={show}
                touch
                coverHeight={phoneCover()}
                bodyScale={textScale()}
                snippet={i().snippet}
                showCollection={showCollection()}
                onOpen={() => open(i().b)}
              />
            )}
          </List>
        );
    }
  };

  return (
    <View class="flex-1 bg-paper">
      <If
        when={props.wide}
        else={
          <>
            <View class="flex-1" onLayout={(e) => width.set(e.bounds.size.width)}>
              {phoneList}
            </View>
            <BottomEdge height={SEARCH_H + searchBottom() + 24} />
            {phoneSearch()}
            {/* Android: the bar's ••• opens it, as a sheet (iOS has the system's). */}
            <If when={props.menu && !systemMenus}>
              <EntryMenu
                testID="list-menu-panel"
                entries={() => listMenuEntries(menuOptions())}
                open={!!props.menu?.()}
                onOpenChange={(open) => props.menu?.set(open)}
                onPick={(id) => applyListChoice(menuOptions(), id)}
              />
            </If>
            <If when={platform.os === "ios"}>
              {/* Made again with each layout: it hands UIKit the new scroll view. */}
              {() => {
                edgeLayout();
                return <TopEdge largeTitle />;
              }}
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
            if (!measured()) return null;
            // Another source: its lists from the top (a bookmark edited
            // doesn't come here: the lists follow `items` in place).
            sourceKey();
            const empty = (
              <Empty
                searching={searching()}
                pending={pending()}
                source={props.source}
                filtered={isFiltered(filter())}
              />
            );
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
                          showCollection={showCollection()}
                          onOpen={() => props.onOpen(i().b)}
                        />
                      ) : (
                        <BookmarkListRow
                          b={i().b}
                          drag={drag}
                          show={show}
                          coverLeft={prefs().coverPosition === "left"}
                          snippet={i().snippet}
                          showCollection={showCollection()}
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
                // viewport are made. The grid is made again only when a
                // column comes or goes; an edited bookmark reaches its
                // column's list (`moodCols`), as in the other views.
                const n = moodColumns();
                return (
                  <If
                    when={items().length}
                    else={
                      <View class="flex-1" style={{ paddingTop: top }}>
                        {empty}
                      </View>
                    }
                  >
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
                        {Array.from({ length: n }, (_, c) => (
                          <View class="min-w-0 flex-1">
                            <List
                              each={moodCols()[c] ?? []}
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
                                    showCollection={showCollection()}
                                    onOpen={() => props.onOpen(i().b)}
                                  />
                                );
                              }}
                            </List>
                          </View>
                        ))}
                      </View>
                    </Scroll>
                  </If>
                );
              }
              default:
                return (
                  <List
                    each={items()}
                    keyExtractor={(i) => i.b.id}
                    numColumns={cardColumns()}
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
                          showCollection={showCollection()}
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
