import { Sidebar } from "lofu/native";
import {
  cleanup,
  effect,
  keyboardFrame,
  lifecycle,
  mount,
  platform,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
} from "nsh";
import { createNavStack, Dialog, NavPage, NavStack } from "nsh/base";
import { isAvailable, Menu, titleBar, Window } from "nsh/desktop";
import { AddBookmark } from "./components/AddBookmark";
import { EditBookmark } from "./components/EditBookmark";
import { PromptHost, prompting } from "./components/Prompt";
import { GlassTint, RoundGlassButton } from "./components/ui";
import {
  deleteBookmark,
  editBookmark,
  focusSearch,
  openBookmark,
  openInBrowser,
  openOriginal,
  setBrowser,
  setEditor,
  setReader,
  shareBookmark,
  showBookmarkMenu,
} from "./lib/actions";
import type { Bookmark } from "./lib/api";
import { loadSettings, shareLogin } from "./lib/api";
import { glass, hasGlass, look } from "./lib/look";
import {
  bookmark as current,
  reset,
  type Source,
  sourceTitle,
  start,
  sync,
  updateBookmark,
} from "./lib/store";
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
  | { name: "browser"; url: string; domain: string }
  | { name: "add"; source: Source }
  | { name: "edit"; bookmark: Bookmark };

/** The reader and "Open Original" push onto this stack while it's mounted. */
function useOpeners(push: (r: Route) => void) {
  setReader((b) => push({ name: "reader", bookmark: b }));
  setBrowser((b) => push({ name: "browser", url: b.url, domain: b.domain }));
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

if (isAvailable) Window.setTitleBar({ style: "hidden", height: TOOLBAR });

/** Sidebar beside the content: desktops and tablets with room for it. */
const wide = () => platform.idiom !== "phone" && windowSize().width >= 640;

/** Pages slide in on phones and tablets, where the stack follows the swipe back. */
const pageAnimation = platform.os === "ios" || platform.os === "android" ? "default" : "none";

function App() {
  const ready = signal<"settings" | "app" | null>(null);
  void loadSettings().then((s) => {
    if (s.server && s.token) {
      // Logins from before the share extension reach it this way.
      shareLogin(s);
      ready.set("app");
      void start();
    } else ready.set("settings");
  });

  // Catch up whenever the app comes back to the front. nsh 0.4.0's web
  // runtime doesn't have `lifecycle` (it's typed and documented), so the web
  // build only syncs on start and on request.
  const active = () => typeof lifecycle !== "function" || lifecycle() === "active";
  if (typeof lifecycle === "function") {
    effect(() => {
      if (lifecycle() === "active" && ready() === "app") void sync();
    });
  }
  // A window left open (the Mac's, a browser tab) stays current too.
  const timer = setInterval(() => {
    if (ready() === "app" && active()) void sync();
  }, SYNC_EVERY);
  cleanup(() => clearInterval(timer));

  const onConnected = async () => {
    await reset();
    ready.set("app");
    await start();
  };

  return (
    <View
      class="flex-1"
      // The system's sidebar lies under the root: the desktop's layout paints its own paper.
      style={{
        backgroundColor: nativeSidebar && ready() === "app" && wide() ? undefined : look().paper,
      }}
    >
      {() => {
        const r = ready();
        if (!r) return null;
        if (r === "settings") return <Settings first onDone={onConnected} />;
        return wide() ? <Desktop onReconnect={onConnected} /> : <Phone onReconnect={onConnected} />;
      }}
      <PromptHost />
    </View>
  );
}

/** Sidebar, and a stack of the library and the reader beside it. */
function Desktop(props: { onReconnect: () => void }) {
  const source = signal<Source>({ kind: "all" });
  const nav = createNavStack<Route>([{ name: "library", source: source() }]);
  const settingsOpen = signal(false);
  const adding = signal(false);
  const editing = signal<Bookmark | null>(null);
  useOpeners((r) => nav.push(r));
  setEditor((b) => editing.set(b));
  cleanup(() => setEditor(null));
  // The window toolbar's leading items line up with the content (`lib/toolbar.ts`).
  contentLeft.set(SIDEBAR + INSET);
  // The window toolbar can't be covered by a dialog: it waits while one is open.
  effect(() => toolbarBlocked.set(settingsOpen() || !!editing() || adding() || prompting()));
  cleanup(() => toolbarBlocked.set(false));
  const select = (s: Source) => {
    source.set(s);
    nav.setRoutes([{ name: "library", source: s }]);
  };
  /** The bookmark open in the reader, for the Bookmark menu. */
  const reading = () => {
    const top = nav.routes().at(-1);
    return top?.name === "reader" ? (current(top.bookmark.id) ?? top.bookmark) : null;
  };
  if (nativeSidebar) {
    Sidebar.show(SIDEBAR + INSET);
    cleanup(() => Sidebar.hide());
  }
  useMenuBar({
    select,
    reading,
    add: () => adding.set(true),
    settings: () => settingsOpen.set(true),
    back: () => {
      if (nav.routes().length > 1) nav.pop();
    },
  });
  return (
    <View class="flex-1 flex-row">
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
      <View class="flex-1" style={{ backgroundColor: look().paper }}>
        <NavStack state={nav} class="flex-1">
          {(route) => {
            if (route.name === "browser") {
              return (
                <NavPage animation={pageAnimation} header={<View />} title="">
                  <Browser url={route.url} wide onClose={() => nav.pop()} />
                </NavPage>
              );
            }
            if (route.name === "reader") {
              return (
                <NavPage animation={pageAnimation} header={<View />} title="">
                  <Reader bookmark={route.bookmark} wide onBack={() => nav.pop()} />
                </NavPage>
              );
            }
            const s = route.name === "library" ? route.source : { kind: "all" as const };
            return (
              <NavPage animation={pageAnimation} header={<View />} title={sourceTitle(s)}>
                <Library
                  source={s}
                  wide
                  onSource={select}
                  onOpen={(b) => openBookmark(b)}
                  onAdd={() => adding.set(true)}
                />
              </NavPage>
            );
          }}
        </NavStack>
      </View>
      <Dialog
        open={settingsOpen()}
        animation="fade"
        onOpenChange={(e) => settingsOpen.set(e.open)}
        backdropClass="bg-black/40"
        class="m-auto w-[500px] overflow-hidden rounded-[26px]"
        // Taller than a short window: it scrolls inside it.
        style={{ ...glass(), borderCurve: "continuous", maxHeight: dialogMaxHeight() }}
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
      </Dialog>
      <Dialog
        open={!!editing()}
        animation="fade"
        onOpenChange={(e) => {
          if (!e.open) editing.set(null);
        }}
        backdropClass="bg-black/25"
        class="m-auto w-[480px] overflow-hidden rounded-[26px]"
        style={{ ...glass(), borderCurve: "continuous" }}
      >
        <GlassTint radius={26} />
        <If when={editing()}>
          {(b) => (
            <View class="gap-5 p-6">
              <Text style={{ color: look().ink, fontSize: 19, fontWeight: "700" }}>
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
      </Dialog>
      <Dialog
        open={adding()}
        animation="fade"
        onOpenChange={(e) => adding.set(e.open)}
        backdropClass="bg-black/25"
        class="m-auto w-[440px] overflow-hidden rounded-[26px]"
        style={{ ...glass(), borderCurve: "continuous" }}
      >
        <GlassTint radius={26} />
        <If when={adding()}>
          <View class="gap-5 p-6">
            <Text style={{ color: look().ink, fontSize: 19, fontWeight: "700" }}>Add bookmark</Text>
            <AddBookmark
              source={source()}
              onCancel={() => adding.set(false)}
              onDone={() => adding.set(false)}
            />
          </View>
        </If>
      </Dialog>
    </View>
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
  settings: () => void;
  back: () => void;
}) {
  if (!isAvailable) return;
  effect(() => {
    const b = app.reading();
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
  const headerClass = () => `text-[${look().ink}] tint-[${look().stamp}]`;
  /** Pages that keep an opaque bar (forms, the web view) draw it in the paper. */
  const solidHeaderClass = () => `bg-[${look().paper}] ${headerClass()}`;
  return (
    <NavStack state={nav} class="flex-1" style={{ backgroundColor: look().paper }}>
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
                headerClass={headerClass()}
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
                style={{ backgroundColor: look().paper }}
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
          case "library":
            return (
              <NavPage
                animation={pageAnimation}
                title={sourceTitle(route.source)}
                headerLargeTitle
                headerTransparent
                headerClass={headerClass()}
                style={{ backgroundColor: look().paper }}
              >
                <WebBar title={sourceTitle(route.source)} onBack={() => nav.pop()} />
                <Library
                  source={route.source}
                  wide={false}
                  initialQuery={route.query}
                  onOpen={(b) => openBookmark(b)}
                  onAdd={() => nav.push({ name: "add", source: route.source })}
                />
              </NavPage>
            );
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
                headerTransparent
                headerClass={headerClass()}
                style={{ backgroundColor: look().paper }}
                ios={{ headerRightSymbol: "ellipsis" }}
                headerRight={
                  <View
                    role="button"
                    accessibilityLabel="More"
                    onPress={() => void showBookmarkMenu(b(), { inReader: true, onGone: back })}
                  />
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
          case "browser":
            return (
              <NavPage
                animation={pageAnimation}
                title={route.domain.replace(/^www\./, "")}
                headerClass={solidHeaderClass()}
                style={{ backgroundColor: look().paper }}
              >
                <Browser url={route.url} wide={false} onClose={() => nav.pop()} />
              </NavPage>
            );
          case "add":
            return (
              <NavPage
                animation={pageAnimation}
                title="Add bookmark"
                headerClass={solidHeaderClass()}
                style={{ backgroundColor: look().paper }}
              >
                <WebBar title="Add bookmark" onBack={() => nav.pop()} />
                <View class="flex-1 p-5" style={{ backgroundColor: look().paper }}>
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
                headerClass={solidHeaderClass()}
                style={{ backgroundColor: look().paper }}
              >
                <WebBar title="Edit bookmark" onBack={() => nav.pop()} />
                <Scroll
                  class="flex-1"
                  keyboardDismissMode="on-drag"
                  keyboardShouldPersistTaps="handled"
                  contentStyle={{ padding: 20, paddingBottom: keyboardFrame().height + 20 }}
                  style={{ backgroundColor: look().paper }}
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
                headerClass={solidHeaderClass()}
                style={{ backgroundColor: look().paper }}
              >
                <WebBar title="Settings" onBack={() => nav.pop()} />
                {/* Taller than a small phone: the server, opening, reading offline. */}
                <Scroll
                  class="flex-1"
                  keyboardDismissMode="on-drag"
                  keyboardShouldPersistTaps="handled"
                  contentStyle={{ paddingBottom: keyboardFrame().height }}
                  style={{ backgroundColor: look().paper }}
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
    <View
      class="flex-row items-center gap-3 px-3"
      style={{ height: 56, backgroundColor: look().paper }}
    >
      <RoundGlassButton name="back" label="Back" testID="back" onPress={props.onBack} />
      <Text
        class="flex-1 truncate"
        style={{ color: look().ink, fontSize: 17, fontWeight: "600", textAlign: "center" }}
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
