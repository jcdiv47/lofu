import { type JSX, Scroll, signal, Text, View, type ViewRef } from "nsh";
import { Menu as DrawnMenu, MenuItem, MenuSeparator, Slider } from "nsh/base";
import { isAvailable, Menu } from "nsh/desktop";
import { type MenuEntry, systemMenu } from "../lib/actions";
import { onAndroidBack } from "../lib/android";
import type { Bookmark } from "../lib/api";
import {
  filterCounts,
  filterParts,
  isFiltered,
  type ListFilter,
  NO_FILTER,
  offersType,
  type Toggle,
  toggled,
  togglesFor,
  typeChoices,
} from "../lib/filters";
import { look } from "../lib/look";
import {
  applyViewToAll,
  type BookmarkSort,
  type BookmarkView,
  COVER_SIZES,
  type CoverPosition,
  coverSize,
  hasManualOrder,
  prefs,
  type ShowField,
  setCoverPosition,
  setCoverSize,
  setSortFor,
  setViewFor,
  showFields,
  shows,
  sizedViews,
  sortFor,
  toggleShow,
  viewFor,
} from "../lib/prefs";
import { type BookmarkType, type Source, typeTitles } from "../lib/store";
import { Icon, type IconName } from "./ui";

/*
 * The library's *Sort by* and *View* buttons, beside its title, as
 * Raindrop's: the icon and name of the current choice, and a menu of the
 * choices under the button. The desktop apps open the system's menu there,
 * checked; the web draws one, with a radio mark and an icon per choice. The
 * Mac's are its window toolbar's (`screens/Library.tsx`): the title row lies
 * under that toolbar, which takes its clicks.
 */

type Choice<T> = {
  value: T;
  label: string;
  icon: IconName;
  /** The Mac toolbar's SF Symbol for it. */
  symbol: string;
  /** What the button says, when shorter than the menu's item. */
  short?: string;
};

export const sortChoices: Choice<BookmarkSort>[] = [
  {
    value: "manual",
    label: "Manual (Drag'n'drop)",
    short: "Manual",
    icon: "sort",
    symbol: "arrow.up.arrow.down",
  },
  { value: "date-asc", label: "By date ↑", icon: "clock", symbol: "clock" },
  { value: "date-desc", label: "By date ↓", icon: "clock", symbol: "clock" },
  { value: "name-asc", label: "By name (A-Z)", icon: "sortAz", symbol: "textformat" },
  { value: "name-desc", label: "By name (Z-A)", icon: "sortZa", symbol: "textformat" },
  { value: "site-asc", label: "Sites (A-Z)", icon: "window", symbol: "macwindow" },
  { value: "site-desc", label: "Sites (Z-A)", icon: "window", symbol: "macwindow" },
];

export const viewChoices: Choice<BookmarkView>[] = [
  { value: "list", label: "List", icon: "list", symbol: "list.bullet" },
  { value: "cards", label: "Cards", icon: "grid", symbol: "square.grid.2x2" },
  { value: "headlines", label: "Headlines", icon: "headlines", symbol: "text.justify.left" },
  { value: "moodboard", label: "Moodboard", icon: "moodboard", symbol: "rectangle.3.group" },
];

/** The sorts a source offers: Manual only where there's a manual order. */
export const sortsFor = (s: Source) =>
  sortChoices.filter((c) => c.value !== "manual" || hasManualOrder(s));
export const currentSort = (s: Source) =>
  sortChoices.find((c) => c.value === sortFor(s)) ?? sortChoices[2];
/** What the sort button says: Manual's short name. */
export const sortLabel = (s: Source) => currentSort(s).short ?? currentSort(s).label;
export const currentView = (s: Source) =>
  viewChoices.find((c) => c.value === viewFor(s)) ?? viewChoices[1];

type NativeItems = Parameters<typeof Menu.popup>[0];

/** *Sort by* as the system's menu (desktop apps), the current one checked. */
export const sortMenu = (s: Source): NativeItems => [
  { label: "Sort by", disabled: true },
  ...sortsFor(s).map((c) => ({
    label: c.label,
    checked: c.value === currentSort(s).value,
    onSelect: () => setSortFor(s, c.value),
  })),
];

/** *View* as the system's menu (desktop apps), then *Apply to All*. */
export const viewMenu = (s: Source): NativeItems => [
  { label: "View", disabled: true },
  ...viewChoices.map((c) => ({
    label: c.label,
    checked: c.value === currentView(s).value,
    onSelect: () => setViewFor(s, c.value),
  })),
  { type: "separator" },
  { label: "Apply to All", onSelect: () => applyViewToAll(currentView(s).value) },
  ...viewOptionsMenu(currentView(s)),
];

const sizeNames = ["Smallest", "Small", "Medium", "Large", "Largest"];
const positions: [CoverPosition, string][] = [
  ["left", "Left"],
  ["right", "Right"],
];

/** *Show in …*, and the covers' size or place, as items of the system's menu. */
function viewOptionsMenu(v: Choice<BookmarkView>): NativeItems {
  return [
    { type: "separator" },
    { label: `Show in ${v.label}`, disabled: true },
    ...showFields.map(([f, label]) => ({
      label,
      checked: shows(v.value, f),
      onSelect: () => toggleShow(v.value, f),
    })),
    ...(sizedViews.includes(v.value)
      ? [
          { type: "separator" as const },
          {
            label: "Cover",
            submenu: sizeNames.map((name, k) => ({
              label: name,
              checked: coverSize(v.value) === k + 1,
              onSelect: () => setCoverSize(v.value, k + 1),
            })),
          },
        ]
      : []),
    ...(v.value === "list"
      ? [
          { type: "separator" as const },
          { label: "Cover position", disabled: true },
          ...positions.map(([p, label]) => ({
            label,
            checked: prefs().coverPosition === p,
            onSelect: () => setCoverPosition(p),
          })),
        ]
      : []),
  ];
}

const popup = () => ({
  placement: "bottom" as const,
  align: "start" as const,
  offset: 6,
  margin: 8,
  popupClass: "min-w-[200px] rounded-xl p-1.5 transition duration-100 ease-out",
  popupStyle: {
    backgroundColor: look().cardHover,
    borderWidth: 1,
    borderColor: look().rule,
    boxShadow: "0px 2px 6px rgb(0 0 0 / 0.12), 0px 12px 32px rgb(0 0 0 / 0.22)",
  },
  popupStartingClass: "opacity-0 scale-95",
  popupEndingClass: "opacity-0",
});

/** The button: the current choice's icon and name; lit while its menu is open. */
function Trigger(props: {
  icon: IconName;
  label: string;
  accessibilityLabel: string;
  testID: string;
  onPress?: () => void;
  ref?: (r: ViewRef) => void;
}) {
  return (
    <View
      ref={props.ref}
      role="button"
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      onPress={props.onPress}
      class="h-8 flex-row items-center gap-1.5 rounded-lg px-2.5 active:opacity-70"
      hoverStyle={{ backgroundColor: look().selected }}
    >
      <Icon name={props.icon} size={16} color={look().inkSoft} />
      <Text style={{ color: look().inkSoft, fontSize: 13.5, fontWeight: "600" }}>
        {props.label}
      </Text>
    </View>
  );
}

/** The menu's heading: *Sort by*, *View*. */
const Heading = (props: { text: string }) => (
  <Text class="px-2.5 pt-1 pb-1.5" style={{ color: look().inkFaint, fontSize: 12 }}>
    {props.text}
  </Text>
);

/** A choice of the drawn menu: a radio mark, the choice's icon, its name. */
function RadioItem(props: {
  checked: boolean;
  icon?: IconName;
  label: string;
  testID: string;
  closeOnSelect?: boolean;
  onSelect: () => void;
}) {
  return (
    <MenuItem
      role="menuitemradio"
      checked={props.checked}
      closeOnSelect={props.closeOnSelect}
      testID={props.testID}
      onSelect={props.onSelect}
      class="flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5"
      hoverStyle={{ backgroundColor: look().selected }}
      focusStyle={{ backgroundColor: look().selected }}
    >
      <View
        class="items-center justify-center rounded-full"
        style={{
          width: 15,
          height: 15,
          borderWidth: props.checked ? 0 : 1.5,
          borderColor: look().inkFaint,
          backgroundColor: props.checked ? look().stamp : undefined,
        }}
      >
        <If when={props.checked}>
          <View class="rounded-full" style={{ width: 6, height: 6, backgroundColor: "#fff" }} />
        </If>
      </View>
      <If when={props.icon}>
        <Icon name={props.icon ?? "check"} size={15} color={look().inkSoft} />
      </If>
      <Text style={{ color: look().ink, fontSize: 13.5, lineHeight: 18 }}>{props.label}</Text>
    </MenuItem>
  );
}

/** A setting of the drawn menu: a check box and its name; the menu stays open. */
function CheckItem(props: {
  checked: boolean;
  label: string;
  testID: string;
  onSelect: () => void;
}) {
  return (
    <MenuItem
      checked={props.checked}
      closeOnSelect={false}
      testID={props.testID}
      onSelect={props.onSelect}
      class="flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5"
      hoverStyle={{ backgroundColor: look().selected }}
      focusStyle={{ backgroundColor: look().selected }}
    >
      <View
        class="items-center justify-center rounded"
        style={{
          width: 15,
          height: 15,
          borderWidth: props.checked ? 0 : 1.5,
          borderColor: look().inkFaint,
          backgroundColor: props.checked ? look().stamp : undefined,
        }}
      >
        <If when={props.checked}>
          <Icon name="check" size={11} color="#fff" />
        </If>
      </View>
      <Text style={{ color: look().ink, fontSize: 13.5, lineHeight: 18 }}>{props.label}</Text>
    </MenuItem>
  );
}

/** *Show in …*, then the cover's size (cards, moodboard) or place (list), in the drawn menu. */
function ViewOptions(props: { view: Choice<BookmarkView> }) {
  const v = () => props.view.value;
  return (
    <>
      <MenuSeparator class="mx-2 my-1 h-px" style={{ backgroundColor: look().rule }} />
      <Heading text={`Show in ${props.view.label}`} />
      {showFields.map(([f, label]) => (
        <CheckItem
          checked={shows(v(), f)}
          label={label}
          testID={`show-${f}`}
          onSelect={() => toggleShow(v(), f)}
        />
      ))}
      <If when={sizedViews.includes(v())}>
        <MenuSeparator class="mx-2 my-1 h-px" style={{ backgroundColor: look().rule }} />
        <Heading text="Cover" />
        <View class="px-3 pt-1 pb-2.5">
          <Slider
            testID="cover-size"
            accessibilityLabel="Cover size"
            min={1}
            max={COVER_SIZES}
            step={1}
            value={coverSize(v())}
            onChange={(e) => setCoverSize(v(), e.value as number)}
            class="h-5"
            trackStyle={{ height: 4, borderRadius: 2, backgroundColor: look().rule }}
            rangeStyle={{ backgroundColor: look().stamp, borderRadius: 2 }}
            thumbStyle={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: look().card,
              borderWidth: 1,
              borderColor: look().rule,
              boxShadow: look().shadow,
            }}
          />
        </View>
      </If>
      <If when={v() === "list"}>
        <MenuSeparator class="mx-2 my-1 h-px" style={{ backgroundColor: look().rule }} />
        <Heading text="Cover position" />
        {positions.map(([p, label]) => (
          <RadioItem
            checked={prefs().coverPosition === p}
            label={label}
            testID={`cover-${p}`}
            closeOnSelect={false}
            onSelect={() => setCoverPosition(p)}
          />
        ))}
      </If>
    </>
  );
}

/**
 * A button whose menu opens under it: the system's on the desktop apps
 * (at the button's bottom left), the app's on the web.
 */
function MenuButton(props: {
  icon: IconName;
  label: string;
  accessibilityLabel: string;
  testID: string;
  /** The system's menu (desktop apps). */
  native: () => NativeItems;
  /** The drawn menu's items (web). */
  drawn: () => JSX.Element;
}) {
  if (isAvailable) {
    let ref: ViewRef | undefined;
    return (
      <Trigger
        {...props}
        ref={(r) => {
          ref = r;
        }}
        onPress={async () => {
          const m = await ref?.measure();
          await Menu.popup(
            props.native(),
            m ? { x: m.pagePosition.x, y: m.pagePosition.y + m.bounds.size.height + 4 } : undefined,
          );
        }}
      />
    );
  }
  return (
    <DrawnMenu trigger={<Trigger {...props} />} {...popup()}>
      {props.drawn()}
    </DrawnMenu>
  );
}

/** *Sort by*: date, name or site, each either way; the source keeps its own. */
export function SortButton(props: { source: Source }) {
  const now = () => currentSort(props.source);
  return (
    <MenuButton
      icon={now().icon}
      label={sortLabel(props.source)}
      accessibilityLabel={`Sort by: ${sortLabel(props.source)}`}
      testID="sort-button"
      native={() => sortMenu(props.source)}
      drawn={() => (
        <>
          <Heading text="Sort by" />
          {sortsFor(props.source).map((c) => (
            <RadioItem
              checked={c.value === now().value}
              icon={c.icon}
              label={c.label}
              testID={`sort-${c.value}`}
              onSelect={() => setSortFor(props.source, c.value)}
            />
          ))}
        </>
      )}
    />
  );
}

/** *View*: list, cards, headlines or moodboard for this source, or *Apply to all*. */
export function ViewButton(props: { source: Source }) {
  const now = () => currentView(props.source);
  return (
    <MenuButton
      icon={now().icon}
      label={now().label}
      accessibilityLabel={`View: ${now().label}`}
      testID="view-button"
      native={() => viewMenu(props.source)}
      drawn={() => (
        <>
          <Heading text="View" />
          {viewChoices.map((c) => (
            <RadioItem
              checked={c.value === now().value}
              icon={c.icon}
              label={c.label}
              testID={`view-${c.value}`}
              onSelect={() => setViewFor(props.source, c.value)}
            />
          ))}
          <MenuSeparator class="mx-2 my-1 h-px" style={{ backgroundColor: look().rule }} />
          <MenuItem
            testID="view-apply-all"
            onSelect={() => applyViewToAll(now().value)}
            class="items-center rounded-md px-2.5 py-1.5"
            hoverStyle={{ backgroundColor: look().selected }}
            focusStyle={{ backgroundColor: look().selected }}
          >
            <Text style={{ color: look().ink, fontSize: 13.5, lineHeight: 18 }}>Apply to all</Text>
          </MenuItem>
          <ViewOptions view={now()} />
        </>
      )}
    />
  );
}

/*
 * Phones: the bar's ••• opens one menu of the list's View, Sort by, Filter
 * and Show in …, as Files' and Mail's do: the system's (iOS, `UIMenu`), the
 * views inline at the top with the current one checked, the rest as
 * submenus that name their current choice under them. Each pick closes it.
 */

/** How a filter reads under *Filter*: its parts, or *Off*. */
const filterSummary = (f: ListFilter) => {
  const parts = filterParts(f).map((p) => p.label);
  return parts.length ? parts.join(", ") : "Off";
};

export type ListMenuOptions = {
  source: Source;
  filter: ListFilter;
  setFilter: (f: ListFilter) => void;
  /** The bookmarks the filter's counts are of: the source's. */
  list: Bookmark[];
  /** A search keeps the server's order: no *Sort by*. */
  searching: boolean;
};

/** The phone list's menu (iOS): what's picked is applied here, the filter through `setFilter`. */
export async function phoneListMenu(o: ListMenuOptions) {
  applyListChoice(o, await systemMenu("", listMenuEntries(o)));
}

/** The phone list's menu as entries: the system's menu (iOS) or `PanelMenu` (Android, the web) draws them. */
export function listMenuEntries(o: ListMenuOptions): MenuEntry[] {
  const s = o.source;
  const view = currentView(s);
  const f = o.filter;
  const n = filterCounts(f, o.list);
  const count = (k: number | undefined) => (k ? k.toLocaleString() : "None");
  const sorted: MenuEntry[] = o.searching
    ? []
    : [
        {
          title: "Sort by",
          subtitle: currentSort(s).label,
          symbol: "arrow.up.arrow.down",
          children: sortsFor(s).map((c) => ({
            id: `sort:${c.value}`,
            title: c.label,
            symbol: c.symbol,
            checked: c.value === currentSort(s).value,
          })),
        },
      ];
  const types = typeChoices.filter((t) => (n.types.get(t.value) ?? 0) > 0 || f.type === t.value);
  const filterMenu: MenuEntry = {
    title: "Filter",
    subtitle: filterSummary(f),
    symbol: isFiltered(f)
      ? "line.3.horizontal.decrease.circle.fill"
      : "line.3.horizontal.decrease.circle",
    children: [
      ...togglesFor(s).map((c) => ({
        id: `filter:${c.value}`,
        title: c.label,
        subtitle: count(n.toggles.get(c.value)),
        symbol: c.symbol,
        checked: f.toggles.includes(c.value),
      })),
      ...(offersType(s) && types.length > 1
        ? [
            { separator: true as const },
            {
              title: "Type",
              subtitle: f.type ? typeTitles[f.type] : "Any",
              symbol: "square.stack",
              children: [
                { id: "type:", title: "Any type", checked: f.type === null },
                { separator: true as const },
                ...types.map((t) => ({
                  id: `type:${t.value}`,
                  title: typeTitles[t.value],
                  subtitle: count(n.types.get(t.value)),
                  symbol: t.symbol,
                  checked: f.type === t.value,
                })),
              ],
            },
          ]
        : []),
      ...(isFiltered(f)
        ? [
            { separator: true as const },
            { id: "clear", title: "Clear filter", symbol: "xmark.circle" },
          ]
        : []),
    ],
  };
  const sizeMenu: MenuEntry[] = sizedViews.includes(view.value)
    ? [
        {
          title: "Cover size",
          subtitle: sizeNames[coverSize(view.value) - 1],
          symbol: "photo",
          children: sizeNames.map((name, k) => ({
            id: `size:${k + 1}`,
            title: name,
            checked: coverSize(view.value) === k + 1,
          })),
        },
      ]
    : view.value === "list"
      ? [
          {
            title: "Cover position",
            subtitle: prefs().coverPosition === "left" ? "Left" : "Right",
            symbol: "photo",
            children: positions.map(([p, label]) => ({
              id: `position:${p}`,
              title: label,
              checked: prefs().coverPosition === p,
            })),
          },
        ]
      : [];
  return [
    ...viewChoices.map((c) => ({
      id: `view:${c.value}`,
      title: c.label,
      symbol: c.symbol,
      checked: c.value === view.value,
    })),
    { separator: true },
    ...sorted,
    filterMenu,
    {
      title: `Show in ${view.label}`,
      symbol: "eye",
      children: showFields.map(([field, label]) => ({
        id: `show:${field}`,
        title: label,
        checked: shows(view.value, field),
      })),
    },
    ...sizeMenu,
    { separator: true },
    // Short, as a menu's titles must be on a small phone; the subtitle wraps.
    {
      id: "apply-all",
      title: "Apply to All",
      subtitle: `${view.label} in every list`,
      symbol: "square.on.square",
    },
  ];
}

/** Applies what was picked from the phone list's menu (an entry's id), if anything. */
export function applyListChoice(o: ListMenuOptions, id: string | null) {
  if (!id) return;
  const s = o.source;
  const view = currentView(s);
  const f = o.filter;
  const [kind, value = ""] = id.split(/:(.*)/s);
  switch (kind) {
    case "view":
      return setViewFor(s, value as BookmarkView);
    case "sort":
      return setSortFor(s, value as BookmarkSort);
    case "filter":
      return o.setFilter(toggled(f, value as Toggle));
    case "type":
      return o.setFilter({ ...f, type: (value || null) as BookmarkType | null });
    case "clear":
      return o.setFilter(NO_FILTER);
    case "show":
      return toggleShow(view.value, value as ShowField);
    case "size":
      return setCoverSize(view.value, Number(value));
    case "position":
      return setCoverPosition(value as CoverPosition);
    case "apply-all":
      return applyViewToAll(view.value);
  }
}

/** *Filter* as the app's own menu (phone-sized windows without the system's: the web, Android). */
export function FilterButton(props: {
  source: Source;
  filter: ListFilter;
  setFilter: (f: ListFilter) => void;
  list: Bookmark[];
}) {
  const f = () => props.filter;
  const n = () => filterCounts(f(), props.list);
  const types = () =>
    typeChoices.filter((t) => (n().types.get(t.value) ?? 0) > 0 || f().type === t.value);
  const trigger = (
    <Trigger
      icon="filter"
      label={isFiltered(f()) ? `Filter (${filterParts(f()).length})` : "Filter"}
      accessibilityLabel={`Filter: ${filterSummary(f())}`}
      testID="filter-button"
    />
  );
  return (
    <DrawnMenu trigger={trigger} {...popup()}>
      <Heading text="Filter" />
      {togglesFor(props.source).map((c) => (
        <CheckItem
          checked={f().toggles.includes(c.value)}
          label={`${c.label}  ${n().toggles.get(c.value) ?? 0}`}
          testID={`filter-${c.value}`}
          onSelect={() => props.setFilter(toggled(f(), c.value))}
        />
      ))}
      <If when={offersType(props.source) && types().length > 1}>
        <MenuSeparator class="mx-2 my-1 h-px" style={{ backgroundColor: look().rule }} />
        <Heading text="Type" />
        <RadioItem
          checked={f().type === null}
          label="Any type"
          testID="filter-type-any"
          closeOnSelect={false}
          onSelect={() => props.setFilter({ ...f(), type: null })}
        />
        {types().map((t) => (
          <RadioItem
            checked={f().type === t.value}
            label={`${typeTitles[t.value]}  ${n().types.get(t.value) ?? 0}`}
            testID={`filter-type-${t.value}`}
            closeOnSelect={false}
            onSelect={() => props.setFilter({ ...f(), type: t.value })}
          />
        ))}
      </If>
    </DrawnMenu>
  );
}

/** The drawn menu's icons for the system menu's SF Symbols; the rest go without. */
const symbolIcons: Record<string, IconName> = {
  "list.bullet": "list",
  "square.grid.2x2": "grid",
  "text.justify.left": "headlines",
  "rectangle.3.group": "moodboard",
  "arrow.up.arrow.down": "sort",
  "line.3.horizontal.decrease.circle": "filter",
  "line.3.horizontal.decrease.circle.fill": "filter",
  clock: "clock",
  textformat: "sortAz",
  macwindow: "window",
  star: "star",
  highlighter: "highlighter",
  "note.text": "note",
  number: "hash",
  photo: "image",
  "play.rectangle": "video",
  link: "link",
  "xmark.circle": "close",
};

/**
 * The system's menu (`MenuEntry`), drawn where there is none (Android, the
 * web): a panel under the bar's •••, a submenu taking its place with a way
 * back, as `Home`'s menu. A pick closes it (`onPick`); a press outside it or
 * Android's back button closes it, or goes back from a submenu.
 */
export function PanelMenu(props: {
  items: () => MenuEntry[];
  top: number;
  right: number;
  /** The height it may take; longer menus scroll. */
  maxHeight: number;
  onPick: (id: string) => void;
  onClose: () => void;
  testID?: string;
}) {
  /** The submenus open, as indexes from the top level down. */
  const path = signal<number[]>([]);
  const shown = signal(false);
  setTimeout(() => shown.set(true), 0);
  const level = () => {
    let items = props.items();
    let title = "";
    for (const k of path()) {
      const e = items[k];
      if (!e || !("children" in e)) return { items: props.items(), title: "" };
      items = e.children;
      title = e.title;
    }
    return { items, title };
  };
  const back = () => path.set(path().slice(0, -1));
  onAndroidBack(() => (path().length ? back() : props.onClose()));
  const text = (e: { title: string; subtitle?: string }) => (
    <View class="min-w-0 flex-1">
      <Text style={{ color: look().ink, fontSize: 16, lineHeight: 21 }}>{e.title}</Text>
      <If when={e.subtitle}>
        <Text style={{ color: look().inkSoft, fontSize: 13, lineHeight: 17 }}>{e.subtitle}</Text>
      </If>
    </View>
  );
  const icon = (symbol?: string) => {
    const name = symbol ? symbolIcons[symbol] : undefined;
    return name ? <Icon name={name} size={18} color={look().inkSoft} /> : null;
  };
  const row = (e: MenuEntry, k: number) => {
    if ("separator" in e)
      return <View class="mx-4 my-1" style={{ height: 1, backgroundColor: look().rule }} />;
    const sub = "children" in e;
    const checked = !sub && e.checked;
    const testID = sub ? `menu-${e.title.toLowerCase().replace(/\W+/g, "-")}` : `menu-${e.id}`;
    return (
      <View
        role={sub ? "menuitem" : e.checked === undefined ? "menuitem" : "menuitemradio"}
        accessibilityLabel={e.subtitle ? `${e.title}, ${e.subtitle}` : e.title}
        accessibilityState={!sub && e.checked !== undefined ? { checked: !!e.checked } : undefined}
        testID={testID}
        onPress={() => (sub ? path.set([...path(), k]) : props.onPick(e.id))}
        class="min-h-12 flex-row items-center gap-3 rounded-2xl py-2 pr-4 pl-3"
        activeStyle={{ backgroundColor: look().selected }}
      >
        <View class="w-5 items-center">
          <If when={checked}>
            <Icon name="check" size={17} color={look().stamp} />
          </If>
        </View>
        {text(e)}
        {sub ? <Icon name="chevron" size={14} color={look().inkSoft} /> : icon(e.symbol)}
      </View>
    );
  };
  return (
    <>
      <View
        class="absolute inset-0"
        accessibilityLabel="Close menu"
        onPress={props.onClose}
        style={{ backgroundColor: "#00000024" }}
      />
      <View
        testID={props.testID}
        class="absolute overflow-hidden rounded-[26px]"
        style={{
          top: props.top,
          right: props.right,
          width: 290,
          maxHeight: props.maxHeight,
          backgroundColor: look().card,
          borderWidth: 1,
          borderColor: look().rule,
          boxShadow: "0px 4px 12px rgb(0 0 0 / 0.14), 0px 16px 40px rgb(0 0 0 / 0.24)",
          opacity: shown() ? 1 : 0,
          transform: shown() ? "scale(1)" : "scale(0.9)",
          transformOrigin: "top right",
          transitionProperty: "opacity, transform",
          transitionDuration: 160,
          transitionTimingFunction: "ease-out",
        }}
      >
        <Scroll style={{ maxHeight: props.maxHeight }} contentStyle={{ padding: 6 }}>
          {() => {
            const { items, title } = level();
            return (
              <>
                <If when={path().length}>
                  <View
                    role="button"
                    accessibilityLabel={`Back from ${title}`}
                    testID="menu-back"
                    onPress={back}
                    class="h-12 flex-row items-center gap-2 rounded-2xl px-3"
                    activeStyle={{ backgroundColor: look().selected }}
                  >
                    <Icon name="back" size={17} color={look().inkSoft} />
                    <Text style={{ color: look().ink, fontSize: 16, fontWeight: "600" }}>
                      {title}
                    </Text>
                  </View>
                  <View class="mx-4 my-1" style={{ height: 1, backgroundColor: look().rule }} />
                </If>
                {items.map(row)}
              </>
            );
          }}
        </Scroll>
      </View>
    </>
  );
}
