import { type JSX, Text, View, type ViewRef } from "nsh";
import { Menu as DrawnMenu, MenuItem, MenuSeparator, Slider, Submenu } from "nsh/base";
import { isAvailable, Menu } from "nsh/desktop";
import { type MenuEntry, systemMenu } from "../lib/actions";
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
import { focusRing, Icon, type IconName, popupSurface } from "./ui";

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
  ...popupSurface(),
  popupClass: `min-w-[200px] ${popupSurface().popupClass}`,
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
      class={`h-8 flex-row items-center gap-1.5 rounded-lg px-2.5 hover:bg-selected active:opacity-70 ${focusRing}`}
    >
      <Icon name={props.icon} size={16} />
      <Text class="text-ink-soft" style={{ fontSize: 13.5, fontWeight: "600" }}>
        {props.label}
      </Text>
    </View>
  );
}

/** The menu's heading: *Sort by*, *View*. */
const Heading = (props: { text: string }) => (
  <Text class="px-2.5 pt-1 pb-1.5 text-ink-faint" style={{ fontSize: 12 }}>
    {props.text}
  </Text>
);

/** A drawn menu's rule between groups. */
const Rule = () => <MenuSeparator class="mx-2 my-1 h-px bg-rule" />;

/** The rows of the drawn menus: lit under the pointer and with the keyboard. */
const itemClass = "rounded-md px-2.5 py-1.5 hover:bg-selected focus:bg-selected";

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
      class={`flex-row items-center gap-2.5 ${itemClass}`}
    >
      <View
        class={`items-center justify-center rounded-full ${
          props.checked ? "bg-stamp" : "border-[1.5px] border-ink-faint"
        }`}
        style={{ width: 15, height: 15 }}
      >
        <If when={props.checked}>
          <View class="rounded-full bg-on-fill" style={{ width: 6, height: 6 }} />
        </If>
      </View>
      <If when={props.icon}>
        <Icon name={props.icon ?? "check"} size={15} />
      </If>
      <Text class="text-ink" style={{ fontSize: 13.5, lineHeight: 18 }}>
        {props.label}
      </Text>
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
      class={`flex-row items-center gap-2.5 ${itemClass}`}
    >
      <View
        class={`items-center justify-center rounded ${
          props.checked ? "bg-stamp" : "border-[1.5px] border-ink-faint"
        }`}
        style={{ width: 15, height: 15 }}
      >
        <If when={props.checked}>
          <Icon name="check" size={11} class="tint-on-fill" />
        </If>
      </View>
      <Text class="text-ink" style={{ fontSize: 13.5, lineHeight: 18 }}>
        {props.label}
      </Text>
    </MenuItem>
  );
}

/** *Show in …*, then the cover's size (cards, moodboard) or place (list), in the drawn menu. */
function ViewOptions(props: { view: Choice<BookmarkView> }) {
  const v = () => props.view.value;
  return (
    <>
      <Rule />
      <Heading text={`Show in ${props.view.label}`} />
      <Each of={showFields} key={([f]) => f}>
        {(field) => (
          <CheckItem
            checked={shows(v(), field()[0])}
            label={field()[1]}
            testID={`show-${field()[0]}`}
            onSelect={() => toggleShow(v(), field()[0])}
          />
        )}
      </Each>
      <If when={sizedViews.includes(v())}>
        <Rule />
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
            trackClass="h-1 rounded-sm bg-rule"
            rangeClass="rounded-sm bg-stamp"
            thumbClass={`size-4 rounded-full border border-rule bg-card ${focusRing}`}
            thumbStyle={{ boxShadow: look().shadow }}
          />
        </View>
      </If>
      <If when={v() === "list"}>
        <Rule />
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
function ChoiceButton(props: {
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
    <ChoiceButton
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
    <ChoiceButton
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
          <Rule />
          <MenuItem
            testID="view-apply-all"
            onSelect={() => applyViewToAll(now().value)}
            class={`items-center ${itemClass}`}
          >
            <Text class="text-ink" style={{ fontSize: 13.5, lineHeight: 18 }}>
              Apply to all
            </Text>
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

/** The phone list's menu as entries: the system's menu (iOS) or `EntryMenu` (Android, the web) draws them. */
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
        <Rule />
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
 * The system's menu (`MenuEntry`), drawn by nsh's `Menu` where there is none
 * (Android, the web): a sheet at the bottom on phones, a popup at `trigger`
 * elsewhere; a submenu takes the sheet's place with a way back (`Submenu`),
 * and the system's back button and a press outside close it. A pick closes
 * it (`onPick`). Without a trigger it opens as `open` says (a button of the
 * navigation bar's, outside it).
 */
export function EntryMenu(props: {
  entries: () => MenuEntry[];
  onPick: (id: string) => void;
  trigger?: JSX.Element;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testID?: string;
}) {
  const text = (e: { title: string; subtitle?: string }) => (
    <View class="min-w-0 flex-1">
      <Text class="text-ink" style={{ fontSize: 16, lineHeight: 21 }}>
        {e.title}
      </Text>
      <If when={e.subtitle}>
        <Text class="text-ink-soft" style={{ fontSize: 13, lineHeight: 17 }}>
          {e.subtitle}
        </Text>
      </If>
    </View>
  );
  const icon = (symbol?: string) => {
    const name = symbol ? symbolIcons[symbol] : undefined;
    return name ? <Icon name={name} size={18} /> : null;
  };
  const rowClass =
    "min-h-12 flex-row items-center gap-3 rounded-2xl py-2 pr-4 pl-3 hover:bg-selected focus:bg-selected active:bg-selected";
  const testIDOf = (e: MenuEntry) =>
    "separator" in e
      ? undefined
      : "children" in e
        ? `menu-${e.title.toLowerCase().replace(/\W+/g, "-")}`
        : `menu-${e.id}`;
  const rows = (entries: MenuEntry[]): JSX.Element =>
    entries.map((e) => {
      if ("separator" in e) return <MenuSeparator class="mx-4 my-1 h-px bg-rule" />;
      if ("children" in e)
        return (
          <Submenu
            trigger={
              <View
                testID={testIDOf(e)}
                accessibilityLabel={e.subtitle ? `${e.title}, ${e.subtitle}` : e.title}
                class={rowClass}
              >
                <View class="w-5" />
                {text(e)}
                <Icon name="chevron" size={14} />
              </View>
            }
            back={
              <View
                testID="menu-back"
                accessibilityLabel={`Back from ${e.title}`}
                class="h-12 flex-row items-center gap-2 rounded-2xl px-3 active:bg-selected"
              >
                <Icon name="back" size={17} />
                <Text class="text-ink" style={{ fontSize: 16, fontWeight: "600" }}>
                  {e.title}
                </Text>
              </View>
            }
          >
            {rows(e.children)}
          </Submenu>
        );
      return (
        <MenuItem
          testID={testIDOf(e)}
          role={e.checked === undefined ? "menuitem" : "menuitemradio"}
          checked={e.checked}
          accessibilityLabel={e.subtitle ? `${e.title}, ${e.subtitle}` : e.title}
          onSelect={() => props.onPick(e.id)}
          class={rowClass}
        >
          <View class="w-5 items-center">
            <If when={e.checked}>
              <Icon name="check" size={17} class="tint-stamp" />
            </If>
          </View>
          {text(e)}
          {icon(e.symbol)}
        </MenuItem>
      );
    });
  return (
    <DrawnMenu
      testID={props.testID}
      trigger={props.trigger}
      open={props.open}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
      placement="bottom"
      align="end"
      offset={8}
      margin={8}
      popupClass="min-w-[260px] rounded-[26px] border border-rule bg-card p-1.5 transition duration-150 ease-out motion-reduce:transition-none"
      popupStyle={{ boxShadow: look().menuShadow }}
      popupStartingClass="opacity-0 scale-90"
      popupEndingClass="opacity-0"
      backdropClass="bg-black/15"
    >
      {rows(props.entries())}
    </DrawnMenu>
  );
}
