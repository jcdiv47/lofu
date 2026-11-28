import { Sidebar } from "lofu/native";
import {
  batch,
  cleanup,
  computed,
  effect,
  type JSX,
  keyboardFrame,
  lifecycle,
  mount,
  platform,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type ViewStyle,
  windowSize,
} from "nsh";
import { createNavStack, Dialog, NavPage, NavStack } from "nsh/base";
import { isAvailable, Menu, titleBar } from "nsh/desktop";
import { AddBookmark } from "./components/AddBookmark";
import { EditBookmark } from "./components/EditBookmark";
import { PromptHost, prompting } from "./components/Prompt";
import { GlassTint, RoundGlassButton } from "./components/ui";
import {
  deleteBookmark,
  editBookmark,
  focusSearch,
  newCollectionPrompt,
  openBookmark,
  openInBrowser,
  openOriginal,
  setBrowser,
  setEditor,
  setReader,
  shareBookmark,
  showBookmarkMenu,
} from "./lib/actions";
import { incomingShare, listenForShares } from "./lib/android";
import type { Bookmark } from "./lib/api";
import { loadSettings, shareLogin } from "./lib/api";
import { glass, hasGlass, look } from "./lib/look";
import { prefs, setPrefs } from "./lib/prefs";
import {
  bookmark as current,
  reset,
  type Source,
  sourceTitle,
  start,
  sync,
  updateBookmark,
} from "./lib/store";
import { SWIPE_STACK, useSwipeBack } from "./lib/swipe";
import { contentLeft, toolbarBlocked } from "./lib/toolbar";
import { Browser } from "./screens/Browser";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { Reader } from "./screens/Reader";
import { Settings } from "./screens/Settings";
import { Sources, Wordmark } from "./screens/Sidebar";

type Route =
  | { name: "sources" }
  | { name: "library"; source: Source; query?: string }
  | { name: "reader"; bookmark: Bookmark }
  /** A bookmark's page, which keeps the bookmark for its ••• menu. */
  | { name: "browser"; url: string; domain: string; bookmark: Bookmark }
  | { name: "add"; source: Source }
  | { name: "edit"; bookmark: Bookmark };

/**
 * The desktop's pages: the library, whose source is the sidebar's (one page
 * that follows it, rather than one per source), under the reader and the
 * original page.
 */
type DesktopRoute =
  | { name: "library" }
  | { name: "reader"; bookmark: Bookmark }
  | { name: "browser"; url: string; domain: string; bookmark: Bookmark };

/** The reader and "Open Original" push onto this stack while it's mounted. */
function useOpeners(push: (r: Extract<Route, { name: "reader" | "browser" }>) => void) {
  setReader((b) => push({ name: "reader", bookmark: b }));
  setBrowser((b) => push({ name: "browser", url: b.url, domain: b.domain, bookmark: b }));
  cleanup(() => {
    setReader(null);
    setBrowser(null);
  });
}

/** How often an open app catches up, besides coming to the front. */
const SYNC_EVERY = 5 * 60_000;

const SIDEBAR = 240;
/** The sidebar floats inset from the window's edges, as on macOS 26. */
const INSET = 8;
/** The hidden title bar's height: `nsh.json`'s `window.titleBar` says the same. */
const TOOLBAR = 52;

/**
 * The tallest a centred dialog may be. The Mac's toolbar is drawn in the title
 * bar above nsh's root view, so a dialog that reached into it would slide
 * under its buttons: it keeps clear of the toolbar, and as far from the foot.
 */
const dialogMaxHeight = () => windowSize().height - 2 * (TOOLBAR + 12);

/**
 * The Mac's sidebar is the system's own (`src/sidebar.rs`), drawn by AppKit
 * in Liquid Glass under nsh's root view; the app draws its rows over it.
 */
const nativeSidebar = hasGlass && platform.os === "macos" && Sidebar.available();

/**
 * The Mac's window keeps room for the sidebar, the library's title and the
 * window toolbar's items beside it (`TITLE_ROOM` in `screens/Library.tsx`),
 * as Finder's does: the phone's Library page isn't made for a window (its
 * buttons lie under the traffic lights, its large title under the title bar).
 * The room is `nsh.json`'s `window.minSize`, which the window has from its
 * first frame, along with its hidden title bar.
 */
const macWindow = platform.os === "macos";

/**
 * Sidebar beside the content: always on the Mac (its window keeps the room),
 * and on tablets and browsers with room for it. A computed, so it changes only
 * when it crosses 640: the root mounts Desktop or Phone on it, and read
 * straight from `windowSize` every frame of a live resize mounted the whole
 * app again (a stalled drag, and the place lost).
 */
const wide = computed(() => macWindow || (platform.idiom !== "phone" && windowSize().width >= 640));

/** Pages slide in on phones and tablets, where the stack follows the swipe back. */
const pageAnimation = platform.os === "ios" || platform.os === "android" ? "default" : "none";

function App() {
  const ready = signal<"settings" | "app" | null>(null);
  cleanup(listenForShares());
  void loadSettings()
    .then((s) => {
      if (s.server && s.token) {
        // Logins from before the share extension reach it this way.
        shareLogin(s);
        ready.set("app");
        void start();
      } else ready.set("settings");
    })
    .catch(() => ready.set("settings"));

  // Catch up whenever the app comes back to the front (a browser tab too).
  effect(() => {
    if (lifecycle() === "active" && ready() === "app") void sync();
  });
  // A window left open in front (the Mac's, a browser tab) stays current too.
  const timer = setInterval(() => {
    if (ready() === "app" && lifecycle() === "active") void sync();
  }, SYNC_EVERY);
  cleanup(() => clearInterval(timer));

  const onConnected = async () => {
    await reset();
    ready.set("app");
    await start();
  };

  return (
    <View
      // The system's sidebar lies under the root: the desktop's layout paints its own paper.
      class={
        nativeSidebar && ready() === "app" && wide() && !prefs().sidebarHidden
          ? "flex-1"
          : "flex-1 bg-paper"
      }
    >
      {() => {
        const r = ready();
        if (!r) return null;
        if (r === "settings") return <Settings first onDone={onConnected} />;
        return wide() ? <Desktop onReconnect={onConnected} /> : <Phone onReconnect={onConnected} />;
      }}
      {() =>
        ready() === "app" && incomingShare() ? (
          <Dialog
            open
            onCancel={() => incomingShare.set("")}
            onOpenChange={(e) => {
              if (!e.open) incomingShare.set("");
            }}
            backdropClass="bg-black/40"
            class="m-auto overflow-hidden rounded-[20px] bg-paper"
            style={{ width: Math.min(440, windowSize().width - 32) }}
          >
            <View class="gap-5 bg-paper p-5">
              <Text class="text-ink" style={{ fontSize: 20, fontWeight: "700" }}>
                Save shared link
              </Text>
              <AddBookmark
                source={{ kind: "all" }}
                initialText={incomingShare()}
                onDone={() => incomingShare.set("")}
                onCancel={() => incomingShare.set("")}
              />
            </View>
          </Dialog>
        ) : null
      }
      <PromptHost />
    </View>
  );
}

/** Sidebar, and a stack of the library and the reader beside it. */
function Desktop(props: { onReconnect: () => void }) {
  const source = signal<Source>({ kind: "all" });
  /**
   * The library's page stays for every source (`Library` follows `source`):
   * picking one in the sidebar only goes back to it from the reader, so the
   * page, its toolbar and its search field aren't made again on each click.
   */
  const nav = createNavStack<DesktopRoute>([{ name: "library" }]);
  const settingsOpen = signal(false);
  const adding = signal(false);
  const editing = signal<Bookmark | null>(null);
  // What the add and edit dialogs show stays until their fade out ends
  // (`onGone`), so it's set as they open, not cleared as they close.
  const edited = signal<Bookmark | null>(null);
  const addShown = signal(false);
  const edit = (b: Bookmark) =>
    batch(() => {
      edited.set(b);
      editing.set(b);
    });
  const add = () =>
    batch(() => {
      addShown.set(true);
      adding.set(true);
    });
  useOpeners((r) => nav.push(r));
  setEditor(edit);
  cleanup(() => setEditor(null));
  /** View › Hide Sidebar (⌘B) folds it away, kept on the device. */
  const sidebarShown = () => !prefs().sidebarHidden;
  /** With the sidebar hidden, the pages keep clear of the traffic lights. */
  const toolbarInset = () => (sidebarShown() ? 0 : titleBar().left);
  // The window toolbar's leading items line up with the content (`lib/toolbar.ts`).
  effect(() => contentLeft.set(sidebarShown() ? SIDEBAR + INSET : titleBar().left));
  // The window toolbar can't be covered by a dialog: it waits while one is open.
  effect(() => toolbarBlocked.set(settingsOpen() || !!editing() || adding() || prompting()));
  cleanup(() => toolbarBlocked.set(false));
  const select = (s: Source) =>
    batch(() => {
      source.set(s);
      if (nav.routes().length > 1) nav.popToRoot();
    });
  /** The bookmark open in the reader, for the Bookmark menu. */
  const reading = () => {
    const top = nav.routes().at(-1);
    return top?.name === "reader" ? (current(top.bookmark.id) ?? top.bookmark) : null;
  };
  if (nativeSidebar) {
    effect(() => {
      if (sidebarShown()) Sidebar.show(SIDEBAR + INSET);
      else Sidebar.hide();
    });
    cleanup(() => Sidebar.hide());
  }
  useMenuBar({
    select,
    reading,
    add,
    newCollection: () => void newCollectionPrompt((id) => select({ kind: "collection", id })),
    settings: () => settingsOpen.set(true),
    sidebarShown,
    toggleSidebar: () => setPrefs({ sidebarHidden: sidebarShown() }),
    back: () => {
      if (nav.routes().length > 1) nav.pop();
    },
  });
  // Two fingers right on the trackpad slide the page back, as in Safari, unless a dialog is open.
  useSwipeBack(
    () => nav.routes().length > 1 && !toolbarBlocked(),
    () => {
      if (nav.routes().length > 1) nav.pop();
    },
  );
  return (
    <View class="flex-1 flex-row">
      <If when={sidebarShown()}>
        <View
          // The system's sidebar is flush with the window's edges, as Finder's;
          // the app's own floats inset on its glass.
          class={nativeSidebar ? undefined : "overflow-hidden rounded-[18px]"}
          style={
            nativeSidebar
              ? { width: SIDEBAR + INSET, paddingLeft: INSET / 2, paddingRight: INSET / 2 }
              : {
                  ...glass(),
                  width: SIDEBAR,
                  margin: INSET,
                  marginRight: 0,
                  borderCurve: "continuous",
                }
          }
        >
          {nativeSidebar ? null : <GlassTint radius={18} />}
          <View
            desktop={{ windowDrag: true }}
            class="flex-row items-center justify-end px-4"
            style={{
              height: nativeSidebar ? TOOLBAR : TOOLBAR - INSET,
              paddingLeft: Math.max(0, titleBar().left - INSET),
            }}
          >
            <Wordmark size={21} />
          </View>
          <Sources
            selected={() => source()}
            onSelect={select}
            onSettings={() => settingsOpen.set(true)}
          />
        </View>
      </If>
      <View class="flex-1 bg-paper">
        <NavStack state={nav} testID={SWIPE_STACK} class="flex-1">
          {(route) => {
            if (route.name === "browser") {
              return (
                <NavPage animation={pageAnimation} header={<View />} title="">
                  <Browser
                    url={route.url}
                    wide
                    toolbarInset={toolbarInset()}
                    onClose={() => nav.pop()}
                  />
                </NavPage>
              );
            }
            if (route.name === "reader") {
              return (
                <NavPage animation={pageAnimation} header={<View />} title="">
                  <Reader
                    bookmark={route.bookmark}
                    wide
                    toolbarInset={toolbarInset()}
                    onBack={() => nav.pop()}
                  />
                </NavPage>
              );
            }
            return (
              <NavPage animation={pageAnimation} header={<View />} title={sourceTitle(source())}>
                <Library
                  source={source()}
                  wide
                  onSource={select}
                  onOpen={(b) => openBookmark(b)}
                  onAdd={add}
                  toolbarInset={toolbarInset()}
                />
              </NavPage>
            );
          }}
        </NavStack>
      </View>
      <GlassDialog
        open={settingsOpen()}
        onClose={() => settingsOpen.set(false)}
        backdropClass="bg-black/40"
        class="m-auto w-[500px] overflow-hidden rounded-[26px]"
        // Taller than a short window: it scrolls inside it.
        style={{
          ...glass(),
          borderCurve: "continuous",
          maxHeight: dialogMaxHeight(),
        }}
      >
        <GlassTint radius={26} color={look().sheetTint} />
        <Scroll class="shrink" keyboardShouldPersistTaps="handled">
          <Settings
            onCancel={() => settingsOpen.set(false)}
            onDone={() => {
              settingsOpen.set(false);
              props.onReconnect();
            }}
          />
        </Scroll>
      </GlassDialog>
      <GlassDialog
        open={!!editing()}
        onClose={() => editing.set(null)}
        onGone={() => {
          if (!untracked(editing)) edited.set(null);
        }}
        backdropClass="bg-black/25"
        class="m-auto w-[480px] overflow-hidden rounded-[26px]"
        style={{ ...glass(), borderCurve: "continuous" }}
      >
        <GlassTint radius={26} />
        <If when={edited()}>
          {(b) => (
            <View class="gap-5 p-6">
              <Text class="text-ink" style={{ fontSize: 19, fontWeight: "700" }}>
                Edit bookmark
              </Text>
              <EditBookmark
                b={b()}
                onCancel={() => editing.set(null)}
                onDone={() => editing.set(null)}
              />
            </View>
          )}
        </If>
      </GlassDialog>
      <GlassDialog
        open={adding()}
        onClose={() => adding.set(false)}
        onGone={() => {
          if (!untracked(adding)) addShown.set(false);
        }}
        backdropClass="bg-black/25"
        class="m-auto w-[440px] overflow-hidden rounded-[26px]"
        style={{ ...glass(), borderCurve: "continuous" }}
      >
        <GlassTint radius={26} />
        <If when={addShown()}>
          <View class="gap-5 p-6">
            <Text class="text-ink" style={{ fontSize: 19, fontWeight: "700" }}>
              Add bookmark
            </Text>
            <AddBookmark
              source={source()}
              onCancel={() => adding.set(false)}
              onDone={() => adding.set(false)}
            />
          </View>
        </If>
      </GlassDialog>
    </View>
  );
}

/**
 * A dialog on glass that fades in and out. Since nsh 0.6 a fade keeps the
 * dialog's live views, glass and backdrop included, until it ends
 * (longbridge/nsh#1719); before, it faded out a picture without them.
 */
function GlassDialog(props: {
  open: boolean;
  onClose: () => void;
  /** It has gone, its fade out over. */
  onGone?: () => void;
  backdropClass: string;
  class: string;
  style: ViewStyle;
  children: JSX.Element;
}) {
  return (
    <Dialog
      open={props.open}
      animation="fade"
      onOpenChange={(e) => {
        if (!e.open) props.onClose();
      }}
      onClose={() => props.onGone?.()}
      backdropClass={props.backdropClass}
      class={props.class}
      style={props.style}
    >
      {props.children}
    </Dialog>
  );
}

/**
 * The Mac's menu bar (and the shortcuts of the window's menu on Windows and
 * Linux): saving, finding, syncing, going between the fixed views, and what
 * can be done to the bookmark being read.
 */
function useMenuBar(app: {
  select: (s: Source) => void;
  reading: () => Bookmark | null;
  add: () => void;
  newCollection: () => void;
  settings: () => void;
  sidebarShown: () => boolean;
  toggleSidebar: () => void;
  back: () => void;
}) {
  if (!isAvailable) return;
  effect(() => {
    const b = app.reading();
    const sidebarShown = app.sidebarShown();
    const go = (label: string, shortcut: string, s: Source) => ({
      label,
      shortcut,
      onSelect: () => app.select(s),
    });
    Menu.setApplicationMenu([
      {
        label: "lofu",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Settings…", shortcut: "mod+,", onSelect: app.settings },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "showAll" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "New Bookmark…", shortcut: "mod+n", onSelect: app.add },
          { label: "New Collection…", shortcut: "mod+shift+n", onSelect: app.newCollection },
          { type: "separator" },
          { role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
          { type: "separator" },
          { label: "Find", shortcut: "mod+f", onSelect: () => focusSearch() },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: sidebarShown ? "Hide Sidebar" : "Show Sidebar",
            shortcut: "mod+b",
            onSelect: app.toggleSidebar,
          },
          { type: "separator" },
          { label: "Sync Now", shortcut: "mod+r", onSelect: () => void sync() },
          { type: "separator" },
          { role: "toggleFullScreen" },
        ],
      },
      {
        label: "Go",
        submenu: [
          { label: "Back", shortcut: "mod+[", when: "notEditing", onSelect: app.back },
          { type: "separator" },
          go("All Bookmarks", "mod+1", { kind: "all" }),
          go("Unsorted", "mod+2", { kind: "unsorted" }),
          go("Favorites", "mod+3", { kind: "favorites" }),
          go("Highlights", "mod+4", { kind: "highlights" }),
          go("Trash", "mod+5", { kind: "trash" }),
        ],
      },
      {
        label: "Bookmark",
        submenu: [
          {
            label: b?.favorite ? "Remove from Favorites" : "Add to Favorites",
            shortcut: "mod+d",
            disabled: !b || b.archived,
            onSelect: () =>
              b && void updateBookmark(b.id, { favorite: !b.favorite }).catch(() => {}),
          },
          {
            label: "Edit Title, Tags and Note…",
            shortcut: "mod+e",
            disabled: !b,
            onSelect: () => b && editBookmark(b),
          },
          {
            label: "Open Original",
            shortcut: "mod+o",
            disabled: !b,
            onSelect: () => b && openOriginal(b),
          },
          {
            label: "Open in Browser",
            shortcut: "mod+shift+o",
            disabled: !b,
            onSelect: () => b && openInBrowser(b.url),
          },
          {
            label: "Share…",
            disabled: !b,
            onSelect: () => b && shareBookmark(b),
          },
          { type: "separator" },
          {
            label: b?.archived ? "Delete Permanently…" : "Move to Trash",
            shortcut: "mod+backspace",
            when: "notEditing",
            disabled: !b,
            onSelect: () =>
              b &&
              void deleteBookmark(b).then((gone) => {
                if (gone) app.back();
              }),
          },
        ],
      },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
    ]);
  });
  cleanup(() => Menu.setApplicationMenu(null));
}

/** Library → bookmarks → reader, as a native stack that opens on the Library page. */
function Phone(props: { onReconnect: () => void }) {
  const nav = createNavStack<Route | { name: "settings" }>([{ name: "sources" }]);
  /** The Library page's "…" menu: the system bar's button opens it on iOS. */
  const homeMenu = signal(false);
  useOpeners((r) => nav.push(r));
  setEditor((b) => nav.push({ name: "edit", bookmark: b }));
  cleanup(() => setEditor(null));
  // No header background: iOS 26 draws its bar as Liquid Glass over the page,
  // with the content scrolling under it; the app only tints it.
  const headerClass = `${platform.os === "android" ? "bg-paper " : ""}text-ink tint-stamp`;
  /** Pages that keep an opaque bar (forms, the web view) draw it in the paper. */
  const solidHeaderClass = `bg-paper ${headerClass}`;
  return (
    <NavStack state={nav} class="flex-1 bg-paper">
      {(route) => {
        switch (route.name) {
          case "sources":
            return (
              <NavPage
                animation={pageAnimation}
                title="Library"
                // iOS keeps its bar, transparent and untitled (the page draws
                // its large title): Settings and the menu are the system's
                // own glass buttons. Leaving a page whose bar is hidden would
                // lay out the next page's large title without its margin.
                headerVisible={platform.os === "ios"}
                headerTransparent
                headerTitle={<View />}
                headerBackTitle="Library"
                headerClass={headerClass}
                ios={{ headerLeftSymbol: "gearshape", headerRightSymbol: "ellipsis" }}
                headerLeft={
                  <View
                    role="button"
                    accessibilityLabel="Settings"
                    testID="settings"
                    onPress={() => nav.push({ name: "settings" })}
                  />
                }
                headerRight={
                  <View
                    role="button"
                    accessibilityLabel="More"
                    testID="home-menu"
                    onPress={() => homeMenu.set(true)}
                  />
                }
                class="bg-paper"
              >
                <Home
                  menu={homeMenu}
                  systemBar={platform.os === "ios"}
                  onSelect={(s) => nav.push({ name: "library", source: s })}
                  onSettings={() => nav.push({ name: "settings" })}
                  onSearch={(query) =>
                    nav.push({ name: "library", source: { kind: "all" }, query })
                  }
                  onAdd={() => nav.push({ name: "add", source: { kind: "all" } })}
                />
              </NavPage>
            );
          case "library": {
            /** The list's ••• menu: View, Sort by, Filter, Show in … (`components/ListControls.tsx`). */
            const listMenu = signal(false);
            return (
              <NavPage
                animation={pageAnimation}
                title={sourceTitle(route.source)}
                headerLargeTitle={platform.os === "ios"}
                headerTransparent={platform.os === "ios"}
                headerClass={headerClass}
                class="bg-paper"
                ios={{ headerRightSymbol: "ellipsis" }}
                headerRight={
                  <View
                    role="button"
                    accessibilityLabel="View, sort and filter"
                    testID="list-menu"
                    onPress={() => listMenu.set(true)}
                  >
                    {platform.os === "android" ? (
                      <RoundGlassButton
                        name="more"
                        label="View, sort and filter"
                        onPress={() => listMenu.set(true)}
                      />
                    ) : null}
                  </View>
                }
              >
                <WebBar title={sourceTitle(route.source)} onBack={() => nav.pop()} />
                <Library
                  source={route.source}
                  wide={false}
                  initialQuery={route.query}
                  menu={listMenu}
                  onOpen={(b) => openBookmark(b)}
                  onAdd={() => nav.push({ name: "add", source: route.source })}
                />
              </NavPage>
            );
          }
          case "reader": {
            const b = () => current(route.bookmark.id) ?? route.bookmark;
            /** Off the stack, once deleted; only if it's still on top (a menu can outlive it). */
            const back = () => {
              const top = nav.routes().at(-1);
              if (top?.name === "reader" && top.bookmark.id === route.bookmark.id) nav.pop();
            };
            return (
              <NavPage
                animation={pageAnimation}
                title={route.bookmark.domain.replace(/^www\./, "")}
                headerTransparent={platform.os === "ios"}
                headerClass={headerClass}
                class="bg-paper"
                ios={{ headerRightSymbol: "ellipsis" }}
                headerRight={
                  <View
                    role="button"
                    accessibilityLabel="More"
                    onPress={() => void showBookmarkMenu(b(), { inReader: true, onGone: back })}
                  >
                    {platform.os === "android" ? (
                      <RoundGlassButton
                        name="more"
                        label="More"
                        testID="reader-menu"
                        onPress={() => void showBookmarkMenu(b(), { inReader: true, onGone: back })}
                      />
                    ) : null}
                  </View>
                }
              >
                <WebBar
                  title={route.bookmark.domain.replace(/^www\./, "")}
                  onBack={() => nav.pop()}
                  onMore={(at) => void showBookmarkMenu(b(), { at, inReader: true, onGone: back })}
                />
                <Reader bookmark={route.bookmark} wide={false} onBack={() => nav.pop()} />
              </NavPage>
            );
          }
          case "browser": {
            const b = () => current(route.bookmark.id) ?? route.bookmark;
            /** Off the stack, once deleted; only if it's still on top (a menu can outlive it). */
            const back = () => {
              const top = nav.routes().at(-1);
              if (top?.name === "browser" && top.bookmark.id === route.bookmark.id) nav.pop();
            };
            // The bookmark's menu, as the reader's: a site opened as a page (Settings)
            // has no reader, so this is where its actions are. Already the original here.
            const more = () => void showBookmarkMenu(b(), { omit: ["open-app"], onGone: back });
            return (
              <NavPage
                animation={pageAnimation}
                title={route.domain.replace(/^www\./, "")}
                headerClass={solidHeaderClass}
                class="bg-paper"
                ios={{ headerRightSymbol: "ellipsis" }}
                headerRight={
                  <View
                    role="button"
                    accessibilityLabel="More"
                    testID="browser-menu"
                    onPress={more}
                  >
                    {platform.os === "android" ? (
                      <RoundGlassButton name="more" label="More" onPress={more} />
                    ) : null}
                  </View>
                }
              >
                <Browser url={route.url} wide={false} onClose={() => nav.pop()} />
              </NavPage>
            );
          }
          case "add":
            return (
              <NavPage
                animation={pageAnimation}
                title="Add bookmark"
                headerClass={solidHeaderClass}
                class="bg-paper"
              >
                <WebBar title="Add bookmark" onBack={() => nav.pop()} />
                <View class="flex-1 bg-paper p-5">
                  <AddBookmark
                    source={route.source}
                    onDone={() => nav.pop()}
                    // The web draws no header, so no back button: offer Cancel.
                    onCancel={platform.os === "web" ? () => nav.pop() : undefined}
                  />
                </View>
              </NavPage>
            );
          case "edit":
            return (
              <NavPage
                animation={pageAnimation}
                title="Edit bookmark"
                headerClass={solidHeaderClass}
                class="bg-paper"
              >
                <WebBar title="Edit bookmark" onBack={() => nav.pop()} />
                <Scroll
                  class="flex-1 bg-paper"
                  keyboardDismissMode="on-drag"
                  keyboardShouldPersistTaps="handled"
                  contentStyle={{ padding: 20, paddingBottom: keyboardFrame().height + 20 }}
                >
                  <EditBookmark
                    b={route.bookmark}
                    onDone={() => nav.pop()}
                    onCancel={platform.os === "web" ? () => nav.pop() : undefined}
                  />
                </Scroll>
              </NavPage>
            );
          case "settings":
            return (
              <NavPage
                animation={pageAnimation}
                title="Settings"
                headerClass={solidHeaderClass}
                class="bg-paper"
              >
                <WebBar title="Settings" onBack={() => nav.pop()} />
                {/* Taller than a small phone: the server, opening, reading offline. */}
                <Scroll
                  class="flex-1 bg-paper"
                  keyboardDismissMode="on-drag"
                  keyboardShouldPersistTaps="handled"
                  contentStyle={{ paddingBottom: keyboardFrame().height }}
                >
                  <Settings
                    onDone={() => {
                      nav.pop();
                      props.onReconnect();
                    }}
                  />
                </Scroll>
              </NavPage>
            );
        }
      }}
    </NavStack>
  );
}

mount(App);

/**
 * The web draws no navigation header (on iOS the system's bar has the title
 * and Back): a phone-sized browser window gets a bar of the app's own.
 */
function WebBar(props: {
  title: string;
  onBack: () => void;
  onMore?: (at: { x: number; y: number }) => void;
}) {
  if (platform.os !== "web") return null;
  return (
    <View class="flex-row items-center gap-3 bg-paper px-3" style={{ height: 56 }}>
      <RoundGlassButton name="back" label="Back" testID="back" onPress={props.onBack} />
      <Text
        class="flex-1 truncate text-ink"
        style={{ fontSize: 17, fontWeight: "600", textAlign: "center" }}
      >
        {props.title}
      </Text>
      <If when={props.onMore} else={<View style={{ width: 40 }} />}>
        <RoundGlassButton
          name="more"
          label="More"
          onPress={(e) => props.onMore?.(e?.pagePosition ?? { x: 0, y: 0 })}
        />
      </If>
    </View>
  );
}
