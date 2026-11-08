import { PopupMenu, Share } from "lofu/native";
import { Clipboard, openUrl, platform } from "nsh";
import { AlertDialog } from "nsh/base";
import { isAvailable, Menu } from "nsh/desktop";
import { promptText } from "../components/Prompt";
import { api, type Bookmark } from "./api";
import { type OpenIn, prefs, sortedCollections } from "./prefs";
import {
  collectionName,
  collections,
  countFor,
  deleteCollection,
  deleteForever,
  deleteTag,
  inTrash,
  moveBookmark,
  moveCollection,
  renameCollection,
  renameTag,
  restoreBookmark,
  type Source,
  setReadProgress,
  sync,
  trashBookmark,
  updateBookmark,
} from "./store";

/**
 * Where the app can show a page itself (`WebView` is WKWebView on Apple
 * platforms and Android's WebView). The web build would have to frame the
 * page, which most sites refuse, and the Linux app is deferred.
 */
export const hasBrowser =
  platform.os === "ios" || platform.os === "macos" || platform.os === "android";

let browse: ((b: Bookmark) => void) | null = null;
let read: ((b: Bookmark) => void) | null = null;

/** The app's stack registers how it shows a page in the app. */
export function setBrowser(show: ((b: Bookmark) => void) | null) {
  browse = show;
}

/** The app's stack registers how it opens a bookmark in the reader. */
export function setReader(show: ((b: Bookmark) => void) | null) {
  read = show;
}

let edit: ((b: Bookmark) => void) | null = null;

/** The app registers how it edits a bookmark: a dialog on desktops, a page on phones. */
export function setEditor(show: ((b: Bookmark) => void) | null) {
  edit = show;
}

let searchFocus: (() => void) | null = null;

/** The library registers its search field, for ⌘F. */
export function setSearchFocus(focus: (() => void) | null) {
  searchFocus = focus;
}
export const focusSearch = () => searchFocus?.();

/** A message with an OK. */
export const notice = (title: string, description: string) =>
  AlertDialog.show({
    title,
    description,
    actions: [{ id: "ok", label: "OK", role: "cancel" }],
  });

/** Edits a bookmark's title, tags and note. */
export const editBookmark = (b: Bookmark) => edit?.(b);

/** Outside the app: the system's browser. */
export const openInBrowser = (url: string) => void openUrl(url).catch(() => {});

/** The bookmark's page: in the app where it can, else in the system's browser. */
export function openOriginal(b: Bookmark) {
  if (hasBrowser && browse) browse(b);
  else openInBrowser(b.url);
}

/** The saved text, in the reader. */
export const openInReader = (b: Bookmark) => read?.(b);

/**
 * The ways a bookmark opens, in the order menus list them. Without a
 * browser of the app's own (the web build) there are two: the original
 * opens in the system's browser.
 */
export const openWays = (): { id: OpenIn; label: string; short: string; symbol: string }[] => [
  { id: "reader", label: "Open in Reader", short: "Reader", symbol: "doc.plaintext" },
  {
    id: "app",
    label: "Open Original",
    short: "Original",
    symbol: hasBrowser ? "globe" : "safari",
  },
  ...(hasBrowser
    ? [{ id: "browser" as const, label: "Open in Browser", short: "Browser", symbol: "safari" }]
    : []),
];

/** Opens a bookmark the way given, or the way a tap does (Settings › Open bookmarks in). */
export function openBookmark(b: Bookmark, how: OpenIn = prefs().openIn) {
  if (how === "browser" || (how === "app" && !hasBrowser)) openInBrowser(b.url);
  else if (how === "app") openOriginal(b);
  else openInReader(b);
}

/** A point in the window, where a menu or the share picker points from. */
export type At = { x: number; y: number };

/**
 * The system's share sheet (`src/lib.rs`): iOS and macOS. Elsewhere there is
 * none, and the menus offer *Copy link* only.
 */
export const canShare = (() => {
  try {
    return Share.available();
  } catch {
    return false;
  }
})();

/** Shares the bookmark's link with the system's share sheet. */
export function shareBookmark(b: Bookmark, at?: At) {
  if (!canShare || !Share.url(b.url, at?.x ?? -1, at?.y ?? -1)) {
    void Clipboard.writeText(b.url);
  }
}

/**
 * Where a bookmark can be moved: Unsorted and the collections, the one it's
 * in marked `here` (none for the Trash, out of which any of them moves it).
 */
export function destinations(b: Bookmark) {
  const at = inTrash(b) ? undefined : b.collectionId;
  return [
    { id: null as string | null, label: "Unsorted" },
    ...sortedCollections().map((c) => ({ id: c.id as string | null, label: c.name })),
  ].map((d) => ({ ...d, here: d.id === at }));
}

/** Whether the system's menu can open from a point (`src/lib.rs`): iOS 17.4 on. */
export const systemMenus = (() => {
  try {
    return PopupMenu.available();
  } catch {
    return false;
  }
})();

type SheetAction = { id: string; label: string; role?: "destructive" };

/** An item of the system's menu (`PopupMenu.show`); a separator starts a group. */
export type MenuEntry =
  | {
      id: string;
      title: string;
      subtitle?: string;
      /** An SF Symbol. */
      symbol?: string;
      destructive?: boolean;
      /** Drawn with a checkmark. */
      checked?: boolean;
    }
  | {
      title: string;
      subtitle?: string;
      symbol?: string;
      children: MenuEntry[];
      /**
       * Drawn in place rather than as a submenu, its items side by side as
       * tiles (`medium`: up to three, symbol over title; `small`: symbols).
       */
      row?: "small" | "medium";
    }
  | { separator: true };

/**
 * The system's menu (iOS), from `at` (the navigation bar's right-hand button
 * without one). Resolves with the chosen item's id, or null.
 */
export async function systemMenu(
  title: string,
  items: MenuEntry[],
  at?: At,
): Promise<string | null> {
  const id = await PopupMenu.show(title, JSON.stringify(items), at?.x ?? -1, at?.y ?? -1);
  return id || null;
}

/** An action sheet with a Cancel, where there's no menu to open (Android). */
async function actionSheet(title: string, actions: SheetAction[]): Promise<string | null> {
  const { action } = await AlertDialog.show({
    title,
    presentation: platform.os === "web" ? "alert" : "actionSheet",
    closeOnBackdropPress: true,
    closeOnEscape: true,
    actions: [...actions, { id: "cancel", label: "Cancel", role: "cancel" }],
  });
  return action == null || action === "cancel" ? null : action;
}

const move = (b: Bookmark, to: string | null) => {
  if (inTrash(b) || b.collectionId !== to) void moveBookmark(b.id, to).catch(() => {});
};

/** The places a bookmark can move to, as items of the desktop's menu, where it is checked. */
const moveItems = (b: Bookmark) =>
  destinations(b).map((d) => ({
    label: d.label,
    checked: d.here,
    disabled: d.here,
    onSelect: () => move(b, d.id),
  }));

/**
 * Asks where to move a bookmark: a menu at the pointer on the desktop and
 * from `at` on iOS, an action sheet on Android, a dialog on the web.
 */
export async function chooseDestination(b: Bookmark, at?: At) {
  if (isAvailable) {
    await Menu.popup(moveItems(b), at);
    return;
  }
  if (systemMenus) {
    const id = await systemMenu("Move to", moveEntries(b), at);
    if (id?.startsWith("to:")) move(b, id.slice(3) || null);
    return;
  }
  const action = await actionSheet(
    "Move to",
    destinations(b)
      .filter((d) => !d.here)
      .map((d) => ({ id: d.id ?? "", label: d.label })),
  );
  if (action == null) return;
  move(b, action || null);
}

/**
 * The places a bookmark can move to, as items of the system's menu with ids
 * `to:<collection>` (`to:` for Unsorted), where it is checked.
 */
const moveEntries = (b: Bookmark): MenuEntry[] =>
  destinations(b).map((d) => ({
    id: `to:${d.id ?? ""}`,
    title: d.label,
    symbol: d.id == null ? "tray" : "folder",
    checked: d.here,
  }));

/**
 * Deletes a bookmark: out of the library into the Trash, or, from the Trash,
 * for good once the user confirms. Resolves with whether it went.
 */
export async function deleteBookmark(b: Bookmark): Promise<boolean> {
  if (!inTrash(b)) {
    void trashBookmark(b.id).catch(() => {});
    return true;
  }
  const { action } = await AlertDialog.show({
    title: "Delete permanently?",
    description: `“${b.title || b.domain}” will be deleted from all your devices. This can't be undone.`,
    actions: [
      { id: "delete", label: "Delete", role: "destructive" },
      { id: "cancel", label: "Cancel", role: "cancel" },
    ],
  });
  if (action !== "delete") return false;
  void deleteForever(b.id).catch(() => {});
  return true;
}

/**
 * A menu's groups, drawn apart: how to open it, its link, the bookmark
 * itself, and Delete.
 */
export type ActionGroup = "open" | "link" | "bookmark" | "delete";

export interface BookmarkAction {
  id: string;
  label: string;
  /** Under its symbol, where the menu sets actions side by side (iOS). */
  short?: string;
  /** An SF Symbol, for the system's menu (iOS). */
  symbol: string;
  group: ActionGroup;
  run: () => void;
  /** Drawn in red. */
  destructive?: boolean;
}

export interface BookmarkMenuOptions {
  /** Where the menu opens from, and the share picker with it. */
  at?: At;
  /** The reader's own menu: no *Open in Reader*, nor *Mark as Read* (it keeps the place itself). */
  inReader?: boolean;
  /** Actions left out, which buttons beside the menu already do (the reader's toolbar). */
  omit?: readonly string[];
  /** Called once the bookmark is deleted, so a reader showing it can go back. */
  onGone?: () => void;
}

/** What the reader's toolbar does itself, left out of its ••• menu. */
export const toolbarActions = ["favorite", "share", "edit", "delete"] as const;

/** Read to the end. */
const isRead = (b: Bookmark) => b.readProgress >= 1;

/** What can be done to a bookmark from its card, its row or the reader, in the menus' order. */
export function bookmarkActions(b: Bookmark, o: BookmarkMenuOptions = {}): BookmarkAction[] {
  const trashed = inTrash(b);
  const actions: (BookmarkAction | false | undefined)[] = [
    ...openWays()
      .filter((w) => !(o.inReader && w.id === "reader"))
      .map(
        (w): BookmarkAction => ({
          id: `open-${w.id}`,
          label: w.label,
          short: w.short,
          symbol: w.symbol,
          group: "open",
          run: () => openBookmark(b, w.id),
        }),
      ),
    {
      id: "copy",
      label: "Copy Link",
      symbol: "link",
      group: "link",
      run: () => void Clipboard.writeText(b.url),
    },
    canShare && {
      id: "share",
      label: "Share…",
      symbol: "square.and.arrow.up",
      group: "link",
      run: () => shareBookmark(b, o.at),
    },
    !trashed && {
      id: "favorite",
      label: b.favorite ? "Remove from Favorites" : "Add to Favorites",
      symbol: b.favorite ? "star.slash" : "star",
      group: "bookmark",
      run: () => void updateBookmark(b.id, { favorite: !b.favorite }).catch(() => {}),
    },
    !trashed &&
      !o.inReader && {
        id: "mark-read",
        label: isRead(b) ? "Mark as Unread" : "Mark as Read",
        symbol: isRead(b) ? "circle" : "checkmark.circle",
        group: "bookmark",
        run: () => setReadProgress(b.id, isRead(b) ? 0 : 1),
      },
    !!edit && {
      id: "edit",
      label: "Edit Title, Tags and Note…",
      symbol: "pencil",
      group: "bookmark",
      run: () => editBookmark(b),
    },
    {
      id: "move",
      label: "Move to",
      symbol: "folder",
      group: "bookmark",
      run: () => void chooseDestination(b, o.at),
    },
    trashed && {
      id: "restore",
      label: "Put Back",
      symbol: "arrow.uturn.backward",
      group: "bookmark",
      run: () => void restoreBookmark(b.id).catch(() => {}),
    },
    b.contentStatus === "failed" && {
      id: "refetch",
      label: "Try Reading It Again",
      symbol: "arrow.clockwise",
      group: "bookmark",
      run: async () => {
        await api.refetch(b.id).catch(() => {});
        setTimeout(() => void sync(), 4000);
      },
    },
    {
      id: "delete",
      label: trashed ? "Delete Permanently…" : "Delete",
      symbol: "trash",
      group: "delete",
      destructive: true,
      run: () =>
        void deleteBookmark(b).then((gone) => {
          if (gone) o.onGone?.();
        }),
    },
  ];
  return actions.filter((a): a is BookmarkAction => !!a && !o.omit?.includes(a.id));
}

/** Whether a menu draws a line before `list[i]`: where a group starts. */
export const startsGroup = (list: readonly BookmarkAction[], i: number) =>
  i > 0 && list[i - 1].group !== list[i].group;

/**
 * Menus the platform draws: a context menu on the desktop apps, the
 * system's menu on iOS, an action sheet on Android. The web build has neither (its action sheet is pinned to
 * the bottom of the window), so its cards use the app's `ContextMenu`
 * (`components/BookmarkMenu.tsx`), which opens at the pointer.
 */
export const nativeMenus = platform.os !== "web";

/**
 * The bookmark's actions as the system's menu (iOS): the ways to open it as
 * a row of tiles at the top, then its link, the bookmark itself and Delete,
 * each a group. The collections are a submenu of *Move to*, the one it's in
 * checked. The edit item is short, with what it edits under it, since the
 * menu is narrow.
 */
function menuEntries(b: Bookmark, actions: BookmarkAction[]): MenuEntry[] {
  const entry = (a: BookmarkAction): MenuEntry =>
    a.id === "move"
      ? { title: a.label, symbol: a.symbol, children: moveEntries(b) }
      : a.id === "edit"
        ? { id: a.id, title: "Edit", subtitle: "Title, tags and note", symbol: a.symbol }
        : { id: a.id, title: a.label, symbol: a.symbol, destructive: a.destructive };
  const opens = actions.filter((a) => a.group === "open");
  const rest = actions.filter((a) => a.group !== "open");
  const row: MenuEntry[] =
    opens.length > 1
      ? [
          {
            // Untitled: an inline menu's title is drawn as a heading.
            title: "",
            row: "medium",
            children: opens.map((a) => ({ id: a.id, title: a.short ?? a.label, symbol: a.symbol })),
          },
        ]
      : opens.map(entry);
  return [
    ...row,
    ...rest.flatMap((a, i): MenuEntry[] => [
      ...((row.length > 0 && i === 0) || startsGroup(rest, i)
        ? [{ separator: true as const }]
        : []),
      entry(a),
    ]),
  ];
}

/**
 * A native context menu on the desktop, the system's menu from `at` on iOS
 * (from the navigation bar's ••• without it), an action sheet on Android.
 */
export async function showBookmarkMenu(b: Bookmark, o: BookmarkMenuOptions = {}) {
  const actions = bookmarkActions(b, o);
  if (isAvailable) {
    await Menu.popup(
      actions.flatMap((a, i) => [
        ...(startsGroup(actions, i) ? [{ type: "separator" as const }] : []),
        a.id === "move"
          ? { label: a.label, submenu: moveItems(b) }
          : { label: a.label, onSelect: a.run },
      ]),
      o.at,
    );
    return;
  }
  if (systemMenus) {
    // Untitled: the menu grows out of the row or the reader, which already say
    // which bookmark it is, and a long title took the top of the menu.
    const id = await systemMenu("", menuEntries(b, actions), o.at);
    if (id?.startsWith("to:")) move(b, id.slice(3) || null);
    else actions.find((a) => a.id === id)?.run();
    return;
  }
  const action = await actionSheet(
    b.title || b.domain,
    actions.map((a) => ({
      id: a.id,
      label: a.id === "move" ? `${a.label}…` : a.label,
      role: a.destructive ? ("destructive" as const) : undefined,
    })),
  );
  actions.find((a) => a.id === action)?.run();
}

/**
 * What can be done to a collection or a tag, from its row's menu: rename,
 * move up or down (collections, in their own order), delete. `onGone` runs
 * when it no longer exists (deleted, or renamed: a tag's name is its id).
 */
export async function showSourceMenu(s: Source, at?: At, onGone?: () => void) {
  if (s.kind !== "collection" && s.kind !== "tag") return;
  const actions: (SheetAction & { run: () => void; symbol: string })[] = [];
  if (s.kind === "collection") {
    const list = collections();
    const i = list.findIndex((c) => c.id === s.id);
    const manual = prefs().collectionSort === "manual";
    actions.push({
      id: "rename",
      label: "Rename…",
      symbol: "pencil",
      run: () => void renameCollectionPrompt(s.id),
    });
    if (manual && i > 0)
      actions.push({
        id: "up",
        label: "Move up",
        symbol: "arrow.up",
        run: () => void moveCollection(s.id, -1),
      });
    if (manual && i >= 0 && i < list.length - 1)
      actions.push({
        id: "down",
        label: "Move down",
        symbol: "arrow.down",
        run: () => void moveCollection(s.id, 1),
      });
    actions.push({
      id: "delete",
      label: "Delete collection…",
      role: "destructive",
      symbol: "trash",
      run: () => void confirmDeleteCollection(s.id, onGone),
    });
  } else {
    actions.push({
      id: "rename",
      label: "Rename or merge…",
      symbol: "pencil",
      run: () => void renameTagPrompt(s.name, onGone),
    });
    actions.push({
      id: "delete",
      label: "Delete tag…",
      role: "destructive",
      symbol: "trash",
      run: () => void confirmDeleteTag(s.name, onGone),
    });
  }
  if (isAvailable) {
    await Menu.popup(
      actions.flatMap((a) => [
        ...(a.role === "destructive" ? [{ type: "separator" as const }] : []),
        { label: a.label, onSelect: a.run },
      ]),
      at,
    );
    return;
  }
  const title = s.kind === "collection" ? collectionName(s.id) : `#${s.name}`;
  const chosen = systemMenus
    ? await systemMenu(
        title,
        actions.flatMap((a): MenuEntry[] => [
          ...(a.role === "destructive" ? [{ separator: true as const }] : []),
          { id: a.id, title: a.label, symbol: a.symbol, destructive: a.role === "destructive" },
        ]),
        at,
      )
    : await actionSheet(title, actions);
  actions.find((a) => a.id === chosen)?.run();
}

const renameCollectionPrompt = (id: string) =>
  promptText({
    title: "Rename collection",
    value: collectionName(id),
    placeholder: "Name",
    confirm: "Rename",
    run: (name) => renameCollection(id, name),
  });

async function confirmDeleteCollection(id: string, onGone?: () => void) {
  const n = countFor({ kind: "collection", id });
  const { action } = await AlertDialog.show({
    title: `Delete “${collectionName(id)}”?`,
    description:
      n > 0
        ? `Its ${n} bookmark${n === 1 ? "" : "s"} move to Unsorted; none are deleted.`
        : "It's empty.",
    actions: [
      { id: "delete", label: "Delete", role: "destructive" },
      { id: "cancel", label: "Cancel", role: "cancel" },
    ],
  });
  if (action !== "delete") return;
  await deleteCollection(id).then(onGone, (e) =>
    notice("Couldn't delete it", (e as Error).message),
  );
}

const renameTagPrompt = (name: string, onGone?: () => void) =>
  promptText({
    title: "Rename tag",
    value: name,
    placeholder: "Tag",
    confirm: "Rename",
    run: async (to) => {
      await renameTag(name, to);
      if (to.trim().toLowerCase() !== name) onGone?.();
    },
  });

async function confirmDeleteTag(name: string, onGone?: () => void) {
  const n = countFor({ kind: "tag", name });
  const { action } = await AlertDialog.show({
    title: `Delete #${name}?`,
    description: `It comes off ${n} bookmark${n === 1 ? "" : "s"}; the bookmarks stay.`,
    actions: [
      { id: "delete", label: "Delete", role: "destructive" },
      { id: "cancel", label: "Cancel", role: "cancel" },
    ],
  });
  if (action !== "delete") return;
  await deleteTag(name).then(onGone, (e) => notice("Couldn't delete it", (e as Error).message));
}
