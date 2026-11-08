import { type JSX, Text, View, type ViewRef } from "nsh";
import { Menu as DrawnMenu, MenuItem, MenuSeparator, Slider } from "nsh/base";
import { isAvailable, Menu } from "nsh/desktop";
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
import type { Source } from "../lib/store";
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
