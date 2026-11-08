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
import { Input } from "nsh/base";
import type { JSX } from "nsh/jsx-runtime";
import { nativeScrollEdges, ScrollEdge } from "../components/native";
import { promptText, systemPrompt } from "../components/Prompt";
import { SearchField } from "../components/SearchField";
import {
  BottomEdge,
  GlassButton,
  GlassTint,
  Icon,
  type IconName,
  RoundGlassButton,
  TopEdge,
} from "../components/ui";
import { type MenuEntry, showSourceMenu, systemMenu, systemMenus } from "../lib/actions";
import { glass, look } from "../lib/look";
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
import {
  countFor,
  createCollection,
  offline,
  outbox,
  type Source,
  syncError,
  syncing,
} from "../lib/store";
import { filters, syncStatus, tint } from "./Sidebar";

/** The top bar's height under the status bar: iOS 26's bar, or room for the app's round buttons. */
const BAR = 54;
const BUTTON = 46;

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
  const naming = signal(false);
  /** Names a new collection: the system's alert on iOS, else the card below. */
  const newCollection = () => {
    if (systemPrompt)
      void promptText({
        title: "New collection",
        value: "",
        placeholder: "Name",
        confirm: "Create",
        run: async (name) => {
          await createCollection(name);
        },
      });
    else naming.set(true);
  };
  // iOS: the system's menu (Liquid Glass) from the bar's •••, instead of the
  // app's panel.
  effect(() => {
    if (!systemMenus || !menu()) return;
    untracked(() => void openSystemMenu(newCollection).finally(() => menu.set(false)));
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
    color: string,
    label: string,
    /** Reactive: rows are kept while the list around them changes (sorting, filtering). */
    last: boolean | (() => boolean),
    testID?: string,
  ) => (
    <View
      role="button"
      accessibilityLabel={label}
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
      class="h-[52px] flex-row items-center gap-3.5 pr-5 pl-4"
      activeStyle={{ backgroundColor: look().selected }}
    >
      <Icon name={icon} size={22} color={color} />
      <Text class="flex-1 truncate" style={{ color: look().ink, fontSize: 17 }}>
        {label}
      </Text>
      <Text style={{ color: look().inkFaint, fontSize: 17, fontVariant: ["tabular-nums"] }}>
        {countFor(source) ? countFor(source).toLocaleString() : ""}
      </Text>
      <If when={!(typeof last === "function" ? last() : last)}>
        {/* iOS's inset separator, from the label's leading edge. */}
        <View
          class="absolute right-0 bottom-0"
          style={{ left: 52, height: 1 / pixelRatio(), backgroundColor: look().rule }}
        />
      </If>
    </View>
  );

  const group = (children: JSX.Element) => (
    <View
      class="mx-4 overflow-hidden rounded-[24px]"
      style={{ backgroundColor: look().card, borderCurve: "continuous" }}
    >
      {children}
    </View>
  );

  /** A section's heading: its name folds it away, `action` sits at the other end. */
  const heading = (section: Section, label: string, action?: JSX.Element) => (
    <View class="flex-row items-center pt-7 pr-4 pb-2.5 pl-5">
      <View
        role="button"
        accessibilityLabel={isCollapsed(section) ? `Show ${label}` : `Hide ${label}`}
        accessibilityState={{ expanded: !isCollapsed(section) }}
        testID={`section-${section}`}
        onPress={() => toggleSection(section)}
        class="flex-row items-center gap-1.5 active:opacity-60"
      >
        <Text style={{ color: look().inkSoft, fontSize: 17, fontWeight: "600" }}>{label}</Text>
        <View
          style={{
            transform: isCollapsed(section) ? "rotate(-90deg)" : "rotate(0deg)",
            transitionProperty: "transform",
            transitionDuration: 200,
            transitionTimingFunction: "ease-out",
          }}
        >
          <Icon name="chevronDown" size={16} color={look().inkSoft} />
        </View>
      </View>
      <View class="flex-1" />
      {action}
    </View>
  );

  /** A heading for search results: it doesn't fold. */
  const label = (text: string) => (
    <Text
      class="pt-7 pr-4 pb-2.5 pl-5"
      style={{ color: look().inkSoft, fontSize: 17, fontWeight: "600" }}
    >
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
        <View
          role="button"
          accessibilityLabel={`Search bookmarks for ${query().trim()}`}
          testID="search-bookmarks"
          onPress={submit}
          class="h-[52px] flex-row items-center gap-3.5 pr-5 pl-4"
          activeStyle={{ backgroundColor: look().selected }}
        >
          <Icon name="search" size={22} color={look().stamp} />
          <Text class="flex-1 truncate" style={{ color: look().ink, fontSize: 17 }}>
            {`Search bookmarks for “${query().trim()}”`}
          </Text>
          <Icon name="chevron" size={15} color={look().inkFaint} />
        </View>,
      )}
      <If when={libraryHits().length}>
        {label("Library")}
        {group(
          <Each of={libraryHits()} key={(f) => f.label}>
            {(f, i) =>
              row(
                f().source,
                f().icon,
                f().color,
                f().label,
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
                c().color ?? tint.folder,
                c().name,
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
                t().name,
                () => i() === tagHits().length - 1,
              )
            }
          </Each>,
        )}
      </If>
      <If when={!libraryHits().length && !collectionHits().length && !tagHits().length}>
        <Text class="px-6 pt-5" style={{ color: look().inkFaint, fontSize: 15 }}>
          No collections, filters or tags are called that.
        </Text>
      </If>
    </>
  );

  const status = syncStatus;

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <Scroll
        class="flex-1"
        keyboardDismissMode="on-drag"
        // A tap on a result opens it at once, instead of only hiding the keyboard.
        keyboardShouldPersistTaps="handled"
        contentStyle={{ paddingTop: top() + BAR + 4, paddingBottom: bottom() + 96 }}
      >
        <View class="gap-1 px-5 pb-4">
          <Text style={{ color: look().ink, fontSize: 34, fontWeight: "700", lineHeight: 41 }}>
            Library
          </Text>
          <View class="flex-row items-center gap-1.5">
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
            <Text class="truncate" style={{ color: look().inkFaint, fontSize: 13 }}>
              {status()}
            </Text>
          </View>
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
            <View
              role="button"
              accessibilityLabel="New collection"
              testID="new-collection"
              onPress={newCollection}
              class="h-9 w-9 items-center justify-center rounded-full active:opacity-60"
            >
              <Icon name="plus" size={22} color={look().stamp} />
            </View>,
          )}
          <If when={!isCollapsed("collections")}>
            <If
              when={sortedCollections().length}
              else={
                <Text class="px-5" style={{ color: look().inkFaint, fontSize: 15 }}>
                  No collections yet.
                </Text>
              }
            >
              {group(
                <Each of={sortedCollections()} key={(c) => c.id}>
                  {(c, i) =>
                    row(
                      { kind: "collection", id: c().id },
                      "folder",
                      c().color ?? tint.folder,
                      c().name,
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
                    f().color,
                    f().label,
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
                      t().name,
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
          <RoundGlassButton
            name="more"
            label="More"
            testID="home-menu"
            diameter={BUTTON}
            size={22}
            color={look().ink}
            onPress={() => menu.set(true)}
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

      <If when={menu() && !systemMenus}>
        <HomeMenu
          top={props.systemBar ? top() + BAR + 4 : top() + 6 + BUTTON + 8}
          onClose={() => menu.set(false)}
          onNewCollection={() => {
            menu.set(false);
            newCollection();
          }}
        />
      </If>
      <If when={naming()}>
        <NewCollection top={top() + BAR + 40} onClose={() => naming.set(false)} />
      </If>
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
 * The "…" menu as the system's (iOS): `UIMenu` from the bar's button, the
 * sorts as submenus with the current one checked and named under them.
 */
async function openSystemMenu(onNewCollection: () => void) {
  const sortEntries = (prefix: string, sorts: [string, string][], now: string): MenuEntry[] =>
    sorts.map(([v, title]) => ({ id: `${prefix}:${v}`, title, checked: v === now }));
  const label = (sorts: [string, string][], now: string) => sorts.find(([v]) => v === now)?.[1];
  const collapsed = allCollapsed();
  const id = await systemMenu("", [
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
  ]);
  if (id === "new") onNewCollection();
  else if (id === "collapse") setPrefs({ collapsed: collapsed ? [] : allSections });
  else if (id?.startsWith("collections:"))
    setPrefs({ collectionSort: id.slice(12) as CollectionSort });
  else if (id?.startsWith("tags:")) setPrefs({ tagSort: id.slice(5) as TagSort });
}

/**
 * The "…" menu: a glass panel growing from its button, as iOS 26's pull-down
 * menus do; a submenu takes its place, with a way back.
 */
function HomeMenu(props: { top: number; onClose: () => void; onNewCollection: () => void }) {
  const page = signal<"root" | "collections" | "tags">("root");
  const shown = signal(false);
  setTimeout(() => shown.set(true), 0);
  const item = (
    label: string,
    icon: IconName | null,
    onPress: () => void,
    opts?: { submenu?: boolean; checked?: boolean; testID?: string },
  ) => (
    <View
      role={opts?.checked === undefined ? "menuitem" : "menuitemradio"}
      accessibilityLabel={label}
      accessibilityState={opts?.checked === undefined ? undefined : { checked: opts.checked }}
      testID={opts?.testID}
      onPress={onPress}
      class="h-12 flex-row items-center gap-3.5 rounded-2xl px-4"
      activeStyle={{ backgroundColor: `${look().ink}14` }}
    >
      <View class="w-5 items-center">
        <If when={opts?.checked !== undefined ? opts.checked : icon}>
          <Icon name={icon ?? "check"} size={19} color={look().ink} />
        </If>
      </View>
      <Text class="flex-1" style={{ color: look().ink, fontSize: 17 }}>
        {label}
      </Text>
      <If when={opts?.submenu}>
        <Icon name="chevron" size={15} color={look().inkSoft} />
      </If>
    </View>
  );
  const rule = () => (
    <View class="mx-4 my-1.5" style={{ height: 1, backgroundColor: `${look().ink}1f` }} />
  );

  const choose = (patch: Parameters<typeof setPrefs>[0]) => {
    setPrefs(patch);
    props.onClose();
  };
  return (
    <>
      <View
        class="absolute inset-0"
        accessibilityLabel="Close menu"
        onPress={props.onClose}
        style={{ backgroundColor: "#00000014" }}
      />
      <View
        testID="home-menu-panel"
        class="absolute right-4 overflow-hidden rounded-[30px] p-1.5"
        style={{
          ...glass(),
          borderCurve: "continuous",
          top: props.top,
          width: 286,
          opacity: shown() ? 1 : 0,
          transform: shown() ? "scale(1)" : "scale(0.6)",
          transformOrigin: "top right",
          transitionProperty: "opacity, transform",
          transitionDuration: 220,
          transitionTimingFunction: "cubic-bezier(0.2, 0.9, 0.3, 1.1)",
        }}
      >
        <GlassTint radius={30} />
        {() => {
          switch (page()) {
            case "root":
              return (
                <>
                  {item("New collection", "plus", props.onNewCollection, {
                    testID: "menu-new-collection",
                  })}
                  {item(
                    allCollapsed() ? "Expand all" : "Collapse all",
                    allCollapsed() ? "expand" : "collapse",
                    () =>
                      choose({
                        collapsed: allCollapsed() ? [] : allSections,
                      }),
                    { testID: "menu-collapse" },
                  )}
                  {item("Sort collections", "sort", () => page.set("collections"), {
                    submenu: true,
                    testID: "menu-sort-collections",
                  })}
                  {rule()}
                  {item("Sort tags", "sort", () => page.set("tags"), {
                    submenu: true,
                    testID: "menu-sort-tags",
                  })}
                </>
              );
            case "collections":
            case "tags": {
              const isTags = page() === "tags";
              return (
                <>
                  <View
                    role="button"
                    accessibilityLabel="Back"
                    onPress={() => page.set("root")}
                    class="h-12 flex-row items-center gap-2 px-4 active:opacity-60"
                  >
                    <Icon name="back" size={17} color={look().inkSoft} />
                    <Text style={{ color: look().ink, fontSize: 17, fontWeight: "600" }}>
                      {isTags ? "Sort tags" : "Sort collections"}
                    </Text>
                  </View>
                  {rule()}
                  {isTags
                    ? tagSorts.map(([v, label]) =>
                        item(label, null, () => choose({ tagSort: v }), {
                          checked: prefs().tagSort === v,
                        }),
                      )
                    : collectionSorts.map(([v, label]) =>
                        item(label, null, () => choose({ collectionSort: v }), {
                          checked: prefs().collectionSort === v,
                        }),
                      )}
                </>
              );
            }
          }
        }}
      </View>
    </>
  );
}

/** Names a new collection: a small glass card over the page, above the keyboard. */
function NewCollection(props: { top: number; onClose: () => void }) {
  const name = signal("");
  const busy = signal(false);
  const error = signal("");
  const create = async () => {
    if (!name().trim() || busy()) return;
    busy.set(true);
    error.set("");
    try {
      await createCollection(name());
      props.onClose();
    } catch (e) {
      error.set((e as Error).message);
      busy.set(false);
    }
  };
  return (
    <>
      <View
        class="absolute inset-0"
        onPress={props.onClose}
        style={{ backgroundColor: "#00000040" }}
      />
      <View
        testID="new-collection-card"
        class="absolute right-5 left-5 gap-4 overflow-hidden rounded-[30px] p-5"
        style={{ ...glass(), borderCurve: "continuous", top: props.top }}
      >
        <GlassTint radius={30} />
        <Text class="text-center" style={{ color: look().ink, fontSize: 17, fontWeight: "700" }}>
          New collection
        </Text>
        <View
          class="h-12 justify-center rounded-2xl px-4"
          style={{ backgroundColor: look().card, borderCurve: "continuous" }}
        >
          <Input
            testID="collection-name"
            value={name()}
            placeholder="Name"
            autoFocus
            returnKeyType="done"
            onChange={({ value }) => name.set(value)}
            onSubmit={() => void create()}
            style={{ color: look().ink, fontSize: 17, placeholderColor: look().inkFaint }}
          />
        </View>
        <If when={error()}>
          <Text style={{ color: look().stamp, fontSize: 13 }}>{error()}</Text>
        </If>
        <View class="flex-row gap-3">
          <View class="flex-1">
            <GlassButton label="Cancel" onPress={props.onClose} />
          </View>
          <View class="flex-1" style={{ opacity: name().trim() && !busy() ? 1 : 0.5 }}>
            <GlassButton
              label={busy() ? "Creating…" : "Create"}
              prominent
              testID="create-collection"
              onPress={() => void create()}
            />
          </View>
        </View>
      </View>
    </>
  );
}
