import {
  effect,
  Keyboard,
  keyboardFrame,
  pixelRatio,
  Scroll,
  type Signal,
  safeArea,
  signal,
  Text,
  untracked,
  View,
} from "nsh";
import { Button } from "nsh/base";
import type { JSX } from "nsh/jsx-runtime";
import { EntryMenu } from "../components/ListControls";
import { nativeScrollEdges, ScrollEdge } from "../components/native";
import { SearchField } from "../components/SearchField";
import {
  BottomEdge,
  focusRing,
  Icon,
  type IconName,
  RoundGlassButton,
  SyncStatus,
  TopEdge,
} from "../components/ui";
import {
  type MenuEntry,
  newCollectionPrompt,
  showSourceMenu,
  systemMenu,
  systemMenus,
} from "../lib/actions";
import { look } from "../lib/look";
import {
  type CollectionSort,
  isCollapsed,
  prefs,
  type Section,
  setPrefs,
  sortedCollections,
  sortedTags,
  type TagSort,
  toggleSection,
} from "../lib/prefs";
import { countFor, type Source } from "../lib/store";
import { filters, type Live, read, tint } from "./Sidebar";

/** The top bar's height under the status bar: iOS 26's bar, or room for the app's round buttons. */
const BAR = 54;
const BUTTON = 46;

/** Names a new collection: the system's alert, with its text field. */
const newCollection = () => void newCollectionPrompt();

/**
 * The phone's first page: where the library can be looked at from, in inset
 * groups that fold away, under round glass buttons for settings and a menu,
 * with search and "add" on glass at the bottom (iOS 26's layout). Typing in
 * the search field narrows the page to the collections, filters and tags
 * whose names match, under a row that searches the bookmarks' text instead.
 */
export function Home(props: {
  /** The "…" menu, open or not (the system bar's button opens it on iOS). */
  menu: Signal<boolean>;
  /** iOS: the system bar shows Settings and the menu; elsewhere the page draws them. */
  systemBar: boolean;
  onSelect: (s: Source) => void;
  onSettings: () => void;
  /** Search the bookmarks (their text, on the server) for a query. */
  onSearch: (query: string) => void;
  onAdd: () => void;
}) {
  const menu = props.menu;
  // iOS: the system's menu (Liquid Glass) from the bar's •••.
  effect(() => {
    if (!systemMenus || !menu()) return;
    // Down at once, not when the menu's done (a second or two after it's
    // gone), so that the next tap opens it again (`Library`'s menu too).
    untracked(() => {
      menu.set(false);
      void systemMenu("", homeMenuEntries()).then(applyHomeChoice);
    });
  });
  const query = signal("");
  const top = () => safeArea().top;
  // The search field rides up with the keyboard.
  const bottom = () =>
    keyboardFrame().height > 0 ? keyboardFrame().height + 10 : Math.max(safeArea().bottom, 12) + 4;
  const needle = () => query().trim().toLocaleLowerCase();
  const searching = () => needle().length > 0;
  const matches = (name: string) => name.toLocaleLowerCase().includes(needle());
  const submit = () => {
    const q = query().trim();
    if (!q) return;
    Keyboard.dismiss();
    props.onSearch(q);
  };

  const row = (
    source: Source,
    icon: IconName,
    /** A data color: the glyph's (a collection's own, once it has one). */
    color: Live<string>,
    /** Reactive where it can change in place: a collection renamed. */
    label: Live<string>,
    /** Reactive: rows are kept while the list around them changes (sorting, filtering). */
    last: Live<boolean>,
    testID?: string,
  ) => (
    // A view, not a `Button`: a long press opens the row's menu where it was pressed.
    <View
      role="button"
      accessibilityLabel={read(label)}
      testID={testID}
      onPress={() => props.onSelect(source)}
      onLongPress={
        source.kind === "collection" || source.kind === "tag"
          ? (e) => void showSourceMenu(source, e.pagePosition)
          : undefined
      }
      onContextMenu={
        source.kind === "collection" || source.kind === "tag"
          ? (e) => void showSourceMenu(source, e.pagePosition)
          : undefined
      }
      class={`h-[52px] flex-row items-center gap-3.5 pr-5 pl-4 active:bg-selected ${focusRing}`}
    >
      <Icon name={icon} size={22} color={read(color)} />
      <Text class="flex-1 truncate text-ink" style={{ fontSize: 17 }}>
        {read(label)}
      </Text>
      <Text class="text-ink-faint" style={{ fontSize: 17, fontVariant: ["tabular-nums"] }}>
        {countFor(source) ? countFor(source).toLocaleString() : ""}
      </Text>
      <If when={!read(last)}>
        {/* iOS's inset separator, from the label's leading edge. */}
        <View
          class="absolute right-0 bottom-0 bg-rule"
          style={{ left: 52, height: 1 / pixelRatio() }}
        />
      </If>
    </View>
  );

  const group = (children: JSX.Element) => (
    <View class="mx-4 overflow-hidden rounded-[24px] bg-card" style={{ borderCurve: "continuous" }}>
      {children}
    </View>
  );

  /** A section's heading: its name folds it away, `action` sits at the other end. */
  const heading = (section: Section, label: string, action?: JSX.Element) => (
    <View class="flex-row items-center pt-7 pr-4 pb-2.5 pl-5">
      {/* A disclosure: screen readers hear whether it's open (`Button` has no `expanded`). */}
      <View
        role="button"
        accessibilityLabel={isCollapsed(section) ? `Show ${label}` : `Hide ${label}`}
        accessibilityState={{ expanded: !isCollapsed(section) }}
        testID={`section-${section}`}
        onPress={() => toggleSection(section)}
        class={`flex-row items-center gap-1.5 rounded-lg active:opacity-60 ${focusRing}`}
      >
        <Text class="text-ink-soft" style={{ fontSize: 17, fontWeight: "600" }}>
          {label}
        </Text>
        <View
          class={`transition-transform duration-200 ease-out motion-reduce:transition-none ${
            isCollapsed(section) ? "-rotate-90" : "rotate-0"
          }`}
        >
          <Icon name="chevronDown" size={16} />
        </View>
      </View>
      <View class="flex-1" />
      {action}
    </View>
  );

  /** A heading for search results: it doesn't fold. */
  const label = (text: string) => (
    <Text class="pt-7 pr-4 pb-2.5 pl-5 text-ink-soft" style={{ fontSize: 17, fontWeight: "600" }}>
      {text}
    </Text>
  );

  const libraryHits = () =>
    [
      {
        source: { kind: "all" } as Source,
        icon: "all" as IconName,
        color: tint.library,
        label: "All bookmarks",
      },
      {
        source: { kind: "unsorted" } as Source,
        icon: "inbox" as IconName,
        color: tint.library,
        label: "Unsorted",
      },
      ...filters(),
      {
        source: { kind: "trash" } as Source,
        icon: "trash" as IconName,
        color: tint.trash,
        label: "Trash",
      },
    ].filter((f) => matches(f.label));
  const collectionHits = () => sortedCollections().filter((c) => matches(c.name));
  const tagHits = () => sortedTags().filter((t) => matches(t.name));

  const results = () => (
    <>
      {group(
        <Button
          accessibilityLabel={`Search bookmarks for ${query().trim()}`}
          testID="search-bookmarks"
          onPress={submit}
          class={`h-[52px] flex-row items-center gap-3.5 pr-5 pl-4 active:bg-selected ${focusRing}`}
        >
          <Icon name="search" size={22} class="tint-stamp" />
          <Text class="flex-1 truncate text-ink" style={{ fontSize: 17 }}>
            {`Search bookmarks for “${query().trim()}”`}
          </Text>
          <Icon name="chevron" size={15} class="tint-ink-faint" />
        </Button>,
      )}
      <If when={libraryHits().length}>
        {label("Library")}
        {group(
          <Each of={libraryHits()} key={(f) => f.label}>
            {(f, i) =>
              row(
                f().source,
                f().icon,
                () => f().color,
                () => f().label,
                () => i() === libraryHits().length - 1,
              )
            }
          </Each>,
        )}
      </If>
      <If when={collectionHits().length}>
        {label("Collections")}
        {group(
          <Each of={collectionHits()} key={(c) => c.id}>
            {(c, i) =>
              row(
                { kind: "collection", id: c().id },
                "folder",
                () => c().color ?? tint.folder,
                () => c().name,
                () => i() === collectionHits().length - 1,
              )
            }
          </Each>,
        )}
      </If>
      <If when={tagHits().length}>
        {label("Tags")}
        {group(
          <Each of={tagHits()} key={(t) => t.name}>
            {(t, i) =>
              row(
                { kind: "tag", name: t().name },
                "hash",
                tint.tag,
                () => t().name,
                () => i() === tagHits().length - 1,
              )
            }
          </Each>,
        )}
      </If>
      <If when={!libraryHits().length && !collectionHits().length && !tagHits().length}>
        <Text class="px-6 pt-5 text-ink-faint" style={{ fontSize: 15 }}>
          No collections, filters or tags are called that.
        </Text>
      </If>
    </>
  );

  return (
    <View class="flex-1 bg-paper">
      <Scroll
        class="flex-1"
        keyboardDismissMode="on-drag"
        // A tap on a result opens it at once, instead of only hiding the keyboard.
        keyboardShouldPersistTaps="handled"
        contentStyle={{ paddingTop: top() + BAR + 4, paddingBottom: bottom() + 96 }}
      >
        <View class="gap-1 px-5 pb-4">
          <Text class="text-ink" style={{ fontSize: 34, fontWeight: "700", lineHeight: 41 }}>
            Library
          </Text>
          <SyncStatus size="regular" />
        </View>

        <If when={!searching()} else={results()}>
          {group(
            <>
              {row({ kind: "all" }, "all", tint.library, "All bookmarks", false, "source-all")}
              {row(
                { kind: "unsorted" },
                "inbox",
                tint.library,
                "Unsorted",
                true,
                "source-unsorted",
              )}
            </>,
          )}

          {heading(
            "collections",
            "Collections",
            <Button
              accessibilityLabel="New collection"
              testID="new-collection"
              onPress={newCollection}
              class={`h-9 w-9 items-center justify-center rounded-full active:opacity-60 ${focusRing}`}
            >
              <Icon name="plus" size={22} class="tint-stamp" />
            </Button>,
          )}
          <If when={!isCollapsed("collections")}>
            <If
              when={sortedCollections().length}
              else={
                <Text class="px-5 text-ink-faint" style={{ fontSize: 15 }}>
                  No collections yet.
                </Text>
              }
            >
              {group(
                <Each of={sortedCollections()} key={(c) => c.id}>
                  {(c, i) =>
                    // Kept by id: a rename or a new color shows in place.
                    row(
                      { kind: "collection", id: c().id },
                      "folder",
                      () => c().color ?? tint.folder,
                      () => c().name,
                      () => i() === sortedCollections().length - 1,
                    )
                  }
                </Each>,
              )}
            </If>
          </If>

          {heading("filters", "Filters")}
          <If when={!isCollapsed("filters")}>
            {group(
              <Each of={filters()} key={(f) => f.label}>
                {(f, i) =>
                  row(
                    f().source,
                    f().icon,
                    () => f().color,
                    () => f().label,
                    () => i() === filters().length - 1,
                    `source-${f().label.toLowerCase()}`,
                  )
                }
              </Each>,
            )}
          </If>

          <If when={sortedTags().length}>
            {heading("tags", "Tags")}
            <If when={!isCollapsed("tags")}>
              {group(
                <Each of={sortedTags()} key={(t) => t.name}>
                  {(t, i) =>
                    row(
                      { kind: "tag", name: t().name },
                      "hash",
                      tint.tag,
                      () => t().name,
                      () => i() === sortedTags().length - 1,
                    )
                  }
                </Each>,
              )}
            </If>
          </If>

          {/* The Trash, last: deleted bookmarks wait there until they're deleted again. */}
          <View class="pt-7">
            {group(row({ kind: "trash" }, "trash", tint.trash, "Trash", true, "source-trash"))}
          </View>
        </If>
      </Scroll>

      <TopEdge />

      {/* Round glass buttons over the scroll edge, where there is no system bar to hold them. */}
      <If when={!props.systemBar}>
        <View
          class="absolute right-0 left-0 flex-row justify-between px-4"
          style={{ top: top() + 6, pointerEvents: "box-none" }}
        >
          <RoundGlassButton
            name="settings"
            label="Settings"
            testID="settings"
            diameter={BUTTON}
            size={22}
            color={look().ink}
            onPress={props.onSettings}
          />
          {/* The menu opens from its trigger: a sheet on phones, a popup under it in a wide browser. */}
          <EntryMenu
            testID="home-menu-panel"
            entries={homeMenuEntries}
            onPick={applyHomeChoice}
            trigger={
              <RoundGlassButton
                name="more"
                label="More"
                testID="home-menu"
                diameter={BUTTON}
                size={22}
                color={look().ink}
              />
            }
          />
        </View>
      </If>

      {/* Search and add, on glass at the bottom, in reach of the thumb. */}
      {/* The bottom scroll edge: the rows blur out under the glass. */}
      <BottomEdge height={bottom() + 48 + 24} />
      <View
        class="absolute right-0 left-0 flex-row items-center gap-3 px-4"
        style={{ bottom: bottom(), pointerEvents: "box-none" }}
      >
        {nativeScrollEdges && <ScrollEdge edge="bottom" />}
        <View class="flex-1">
          <SearchField
            value={query}
            onChange={(v) => query.set(v)}
            onSubmit={submit}
            placeholder="Search"
            height={48}
            testID="home-search"
          />
        </View>
        <RoundGlassButton
          name="plus"
          label="Add bookmark"
          testID="add"
          diameter={48}
          size={24}
          color={look().stamp}
          prominent
          onPress={props.onAdd}
        />
      </View>
    </View>
  );
}

const collectionSorts: [CollectionSort, string][] = [
  ["manual", "Manual"],
  ["name", "By name"],
  ["count", "By count"],
];
const tagSorts: [TagSort, string][] = [
  ["count", "By count"],
  ["name", "By name"],
];
const allSections: Section[] = ["collections", "filters", "tags"];
const allCollapsed = () => allSections.every((s) => isCollapsed(s));

/**
 * The "…" menu: new collection, fold or unfold every section, and the sorts
 * as submenus, the current one checked and named under them. The system's
 * menu draws it on iOS (`UIMenu`), nsh's `Menu` elsewhere (`EntryMenu`).
 */
function homeMenuEntries(): MenuEntry[] {
  const sortEntries = (prefix: string, sorts: [string, string][], now: string): MenuEntry[] =>
    sorts.map(([v, title]) => ({ id: `${prefix}:${v}`, title, checked: v === now }));
  const label = (sorts: [string, string][], now: string) => sorts.find(([v]) => v === now)?.[1];
  const collapsed = allCollapsed();
  return [
    { id: "new", title: "New collection", symbol: "folder.badge.plus" },
    {
      id: "collapse",
      title: collapsed ? "Expand all" : "Collapse all",
      symbol: collapsed
        ? "arrow.up.and.down.text.horizontal"
        : "arrow.down.and.line.horizontal.and.arrow.up",
    },
    { separator: true },
    {
      title: "Sort collections",
      subtitle: label(collectionSorts, prefs().collectionSort),
      symbol: "arrow.up.arrow.down",
      children: sortEntries("collections", collectionSorts, prefs().collectionSort),
    },
    {
      title: "Sort tags",
      subtitle: label(tagSorts, prefs().tagSort),
      symbol: "number",
      children: sortEntries("tags", tagSorts, prefs().tagSort),
    },
  ];
}

/** Does what was picked from the "…" menu (an entry's id), if anything. */
function applyHomeChoice(id: string | null) {
  if (id === "new") newCollection();
  else if (id === "collapse") setPrefs({ collapsed: allCollapsed() ? [] : allSections });
  else if (id?.startsWith("collections:"))
    setPrefs({ collectionSort: id.slice(12) as CollectionSort });
  else if (id?.startsWith("tags:")) setPrefs({ tagSort: id.slice(5) as TagSort });
}
