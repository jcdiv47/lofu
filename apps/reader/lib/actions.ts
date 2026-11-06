import { Clipboard, openUrl, platform } from "nsh";
import { AlertDialog } from "nsh/base";
import { isAvailable, Menu } from "nsh/desktop";
import { api, type Bookmark } from "./api";
import { sync, updateBookmark } from "./store";

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

/** Outside the app: the system's browser. */
export const openInBrowser = (url: string) => void openUrl(url).catch(() => {});

/** The bookmark's page: in the app where it can, else in the system's browser. */
export function openOriginal(b: Bookmark) {
  if (hasBrowser && browse) browse(b);
  else openInBrowser(b.url);
}

/** What can be done to a bookmark from its card, its row or the reader's toolbar. */
export function bookmarkActions(b: Bookmark, open?: () => void) {
  return [
    open && { id: "open", label: "Open", run: open },
    { id: "original", label: "Open original", run: () => openOriginal(b) },
    { id: "copy", label: "Copy link", run: () => void Clipboard.writeText(b.url) },
    {
      id: "favorite",
      label: b.favorite ? "Remove from favorites" : "Add to favorites",
      run: () => void updateBookmark(b.id, { favorite: !b.favorite }).catch(() => {}),
    },
    {
      id: "archive",
      label: b.archived ? "Move out of archive" : "Archive",
      run: () => void updateBookmark(b.id, { archived: !b.archived }).catch(() => {}),
    },
    b.contentStatus === "failed" && {
      id: "refetch",
      label: "Try reading it again",
      run: async () => {
        await api.refetch(b.id).catch(() => {});
        setTimeout(() => void sync(), 4000);
      },
    },
  ].filter((a): a is { id: string; label: string; run: () => void } => !!a);
}

/** A native context menu on the desktop, an action sheet on phones. */
export async function showBookmarkMenu(
  b: Bookmark,
  open: (() => void) | undefined,
  at?: { x: number; y: number },
) {
  const actions = bookmarkActions(b, open);
  if (isAvailable) {
    await Menu.popup(
      actions.flatMap((a, i) => [
        ...((a.id === "original" && i > 0) || a.id === "favorite"
          ? [{ type: "separator" as const }]
          : []),
        { label: a.label, onSelect: a.run },
      ]),
      at,
    );
    return;
  }
  const { action } = await AlertDialog.show({
    title: b.title || b.domain,
    presentation: "actionSheet",
    actions: [
      ...actions.map((a) => ({ id: a.id, label: a.label })),
      { id: "cancel", label: "Cancel", role: "cancel" as const },
    ],
  });
  actions.find((a) => a.id === action)?.run();
}
