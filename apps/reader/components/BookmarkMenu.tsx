import { Text } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator } from "nsh/base";
import type { JSX } from "nsh/jsx-runtime";
import { type BookmarkMenuOptions, bookmarkActions, hasBrowser, startsGroup } from "../lib/actions";
import type { Bookmark } from "../lib/api";
import { look } from "../lib/look";
import { Icon, type IconName } from "./ui";

/*
 * The bookmark's menu drawn by the app, for the web build: there's no native
 * menu there (`nsh/desktop` is unavailable), and the action sheet the phones
 * use is pinned to the bottom of the window. On a desktop browser a right
 * click opens it at the pointer; on a touch screen a held finger opens it as
 * a sheet.
 */

const iconFor: Record<string, (b: Bookmark) => IconName> = {
  "open-reader": () => "forward",
  // The globe opens the page in the app; the compass, in the system's browser
  // (where the original goes on the web build, which has no browser of its own).
  "open-app": () => (hasBrowser ? "globe" : "compass"),
  "open-browser": () => "compass",
  copy: () => "link",
  share: () => "share",
  favorite: (b) => (b.favorite ? "starFill" : "star"),
  "mark-read": () => "check",
  edit: () => "pencil",
  move: () => "folder",
  restore: () => "restore",
  refetch: () => "refresh",
  delete: () => "trash",
};

const popup = () => ({
  margin: 8,
  popupClass: "min-w-[208px] rounded-xl p-1.5 transition duration-100 ease-out",
  popupStyle: {
    backgroundColor: look().cardHover,
    borderWidth: 1,
    borderColor: look().rule,
    boxShadow: "0px 2px 6px rgb(0 0 0 / 0.12), 0px 12px 32px rgb(0 0 0 / 0.22)",
  },
  popupStartingClass: "opacity-0 scale-95",
  popupEndingClass: "opacity-0",
});

/** Made on each opening, so it reads the bookmark a recycled cell shows now. */
function items(b: Bookmark, o?: BookmarkMenuOptions) {
  const actions = bookmarkActions(b, o);
  return actions.flatMap((a, i) => [
    ...(startsGroup(actions, i)
      ? [<MenuSeparator class="mx-2 my-1 h-px" style={{ backgroundColor: look().rule }} />]
      : []),
    <MenuItem
      onSelect={a.run}
      class="flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5"
      hoverStyle={{ backgroundColor: look().selected }}
      focusStyle={{ backgroundColor: look().selected }}
    >
      <Icon
        name={iconFor[a.id]?.(b) ?? "chevron"}
        size={15}
        color={
          a.destructive
            ? look().stamp
            : a.id === "favorite" && b.favorite
              ? look().favorite
              : look().inkSoft
        }
      />
      <Text
        style={{ color: a.destructive ? look().stamp : look().ink, fontSize: 13.5, lineHeight: 18 }}
      >
        {a.id === "move" ? `${a.label}…` : a.label}
      </Text>
    </MenuItem>,
  ]);
}

/** A card's or row's menu: right click or a held finger on `trigger`. */
export function BookmarkContextMenu(props: { b: Bookmark; trigger: JSX.Element }) {
  return (
    <ContextMenu trigger={props.trigger} offset={2} {...popup()}>
      <>{items(props.b)}</>
    </ContextMenu>
  );
}

/** A toolbar button's menu, under the button at its right edge. */
export function BookmarkDropdown(props: {
  b: Bookmark;
  trigger: JSX.Element;
  options?: BookmarkMenuOptions;
}) {
  return (
    <Menu trigger={props.trigger} placement="bottom" align="end" offset={6} {...popup()}>
      <>{items(props.b, props.options)}</>
    </Menu>
  );
}
