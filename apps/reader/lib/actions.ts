import { PopupMenu, Share } from "lofu/native";
import { Clipboard, openUrl, platform } from "nsh";
import { AlertDialog } from "nsh/base";
import { isAvailable, Menu } from "nsh/desktop";
import { promptText } from "../components/Prompt";
import { api, type Bookmark } from "./api";
import { prefs, sortedCollections } from "./prefs";
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

/** The app's stack registers how it shows a page in the app. */
export function setBrowser(show: ((b: Bookmark) => void) | null) {
  browse = show;
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

/** Where a bookmark can be moved: Unsorted and the collections, except where it is. */
export function destinations(b: Bookmark) {
  const here = inTrash(b) ? undefined : b.collectionId;
  return [
    { id: null as string | null, label: "Unsorted" },
    ...sortedCollections().map((c) => ({ id: c.id as string | null, label: c.name })),
  ].filter((d) => d.id !== here);
}

/** Whether the system's menu can open from a point (`src/lib.rs`): iOS 17.4 on. */
const systemMenus = (() => {
  try {
    return PopupMenu.available();
  } catch {
    return false;
  }
})();

type SheetAction = { id: string; label: string; role?: "destructive" };

/** An item of the system's menu (`PopupMenu.show`); a separator starts a group. */
type MenuEntry =
  | {
      id: string;
      title: string;
      subtitle?: string;
      /** An SF Symbol. */
      symbol?: string;
      destructive?: boolean;
    }
  | { title: string; symbol?: string; children: MenuEntry[] }
  | { separator: true };

/**
 * The system's menu (iOS), from `at` (the navigation bar's right-hand button
 * without one). Resolves with the chosen item's id, or null.
 */
async function systemMenu(title: string, items: MenuEntry[], at?: At): Promise<string | null> {
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

const move = (b: Bookmark, to: string | null) => void moveBookmark(b.id, to).catch(() => {});

/**
 * Asks where to move a bookmark: a menu at the pointer on the desktop and
 * from `at` on iOS, an action sheet on Android, a dialog on the web.
 */
export async function chooseDestination(b: Bookmark, at?: At) {
  const places = destinations(b);
  if (isAvailable) {
    await Menu.popup(
      places.map((d) => ({ label: d.label, onSelect: () => move(b, d.id) })),
      at,
    );
    return;
  }
  if (systemMenus) {
    const id = await systemMenu("Move to", moveEntries(b), at);
    if (id?.startsWith("to:")) move(b, id.slice(3) || null);
    return;
  }
  const action = await actionSheet(
    "Move to",
    places.map((d) => ({ id: d.id ?? "", label: d.label })),
  );
  if (action == null) return;
  move(b, action || null);
}

/** The places a bookmark can move to, as menu items with ids `to:<collection>` (`to:` for Unsorted). */
const moveEntries = (b: Bookmark): MenuEntry[] =>
  destinations(b).map((d) => ({
    id: `to:${d.id ?? ""}`,
    title: d.label,
    symbol: d.id == null ? "tray" : "folder",
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

export interface BookmarkAction {
  id: string;
  label: string;
  run: () => void;
  /** Drawn in red. */
  destructive?: boolean;
}

/** What can be done to a bookmark from its card, its row or the reader's toolbar. */
export function bookmarkActions(b: Bookmark, open?: () => void, at?: At): BookmarkAction[] {
  const trashed = inTrash(b);
  const actions: (BookmarkAction | false | undefined)[] = [
    open && { id: "open", label: "Open", run: open },
    { id: "original", label: "Open original", run: () => openOriginal(b) },
    { id: "copy", label: "Copy link", run: () => void Clipboard.writeText(b.url) },
    !!edit && { id: "edit", label: "Edit title, tags and note…", run: () => editBookmark(b) },
    canShare && { id: "share", label: "Share…", run: () => shareBookmark(b, at) },
    !trashed && {
      id: "favorite",
      label: b.favorite ? "Remove from favorites" : "Add to favorites",
      run: () => void updateBookmark(b.id, { favorite: !b.favorite }).catch(() => {}),
    },
    { id: "move", label: "Move to…", run: () => void chooseDestination(b, at) },
    trashed && {
      id: "restore",
      label: "Put back",
      run: () => void restoreBookmark(b.id).catch(() => {}),
    },
    b.contentStatus === "failed" && {
      id: "refetch",
      label: "Try reading it again",
      run: async () => {
        await api.refetch(b.id).catch(() => {});
        setTimeout(() => void sync(), 4000);
      },
    },
    {
      id: "delete",
      label: trashed ? "Delete permanently…" : "Delete",
      destructive: true,
      run: () => void deleteBookmark(b),
    },
  ];
  return actions.filter((a): a is BookmarkAction => !!a);
}

/** Where a menu draws a line: before the bookmark's own settings, and before Delete. */
export const separatedBefore = (a: BookmarkAction, i: number) =>
  i > 0 && (a.id === "original" || a.id === "favorite" || a.id === "delete");

/**
 * Menus the platform draws: a context menu on the desktop apps, the
 * system's menu on iOS, an action sheet on Android. The web build has neither (its action sheet is pinned to
 * the bottom of the window), so its cards use the app's `ContextMenu`
 * (`components/BookmarkMenu.tsx`), which opens at the pointer.
 */
export const nativeMenus = platform.os !== "web";

/** Each action's SF Symbol in the system's menu (iOS). */
const symbolFor: Record<string, (b: Bookmark) => string> = {
  original: () => "safari",
  copy: () => "link",
  share: () => "square.and.arrow.up",
  edit: () => "pencil",
  favorite: (b) => (b.favorite ? "star.slash" : "star"),
  move: () => "folder",
  restore: () => "arrow.uturn.backward",
  refetch: () => "arrow.clockwise",
  delete: () => "trash",
};

/**
 * The bookmark's actions as the system's menu (iOS), in three groups: the
 * page (open, copy, share), the bookmark itself (favorite, edit, move…) and
 * Delete. With symbols, the collections as a submenu of *Move to*, and
 * without *Open*, which a tap on the row does. The edit item is short, with
 * what it edits under it, since the menu is narrow.
 */
function menuEntries(b: Bookmark, actions: BookmarkAction[]): MenuEntry[] {
  const groups = [
    ["original", "copy", "share"],
    ["favorite", "edit", "move", "restore", "refetch"],
    ["delete"],
  ];
  const entry = (a: BookmarkAction): MenuEntry =>
    a.id === "move"
      ? { title: "Move to", symbol: "folder", children: moveEntries(b) }
      : a.id === "edit"
        ? { id: a.id, title: "Edit", subtitle: "Title, tags and note", symbol: "pencil" }
        : { id: a.id, title: a.label, symbol: symbolFor[a.id]?.(b), destructive: a.destructive };
  return groups
    .map((ids) =>
      actions
        .filter((a) => ids.includes(a.id))
        .sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)),
    )
    .filter((g) => g.length > 0)
    .flatMap((g, i): MenuEntry[] => [
      ...(i > 0 ? [{ separator: true as const }] : []),
      ...g.map(entry),
    ]);
}

/**
 * A native context menu on the desktop, the system's menu from `at` on iOS
 * (from the navigation bar's ••• without it), an action sheet on Android.
 */
export async function showBookmarkMenu(b: Bookmark, open: (() => void) | undefined, at?: At) {
  const actions = bookmarkActions(b, open, at);
  if (isAvailable) {
    await Menu.popup(
      actions.flatMap((a, i) => [
        ...(separatedBefore(a, i) ? [{ type: "separator" as const }] : []),
        a.id === "move"
          ? {
              label: "Move to",
              submenu: destinations(b).map((d) => ({
                label: d.label,
                onSelect: () => move(b, d.id),
              })),
            }
          : { label: a.label, onSelect: a.run },
      ]),
      at,
    );
    return;
  }
  if (systemMenus) {
    const id = await systemMenu(b.title || b.domain, menuEntries(b, actions), at);
    if (id?.startsWith("to:")) move(b, id.slice(3) || null);
    else actions.find((a) => a.id === id)?.run();
    return;
  }
  const action = await actionSheet(
    b.title || b.domain,
    actions.map((a) => ({
      id: a.id,
      label: a.label,
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
