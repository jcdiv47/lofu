import { cleanup, effect, lifecycle, mount, platform, signal, Text, View, windowSize } from "nsh";
import { createNavStack, Dialog, NavPage, NavStack } from "nsh/base";
import { isAvailable, titleBar, Window } from "nsh/desktop";
import { AddBookmark } from "./components/AddBookmark";
import { GlassTint } from "./components/ui";
import { setBrowser, showBookmarkMenu } from "./lib/actions";
import type { Bookmark } from "./lib/api";
import { loadSettings } from "./lib/api";
import { glass, look } from "./lib/look";
import { bookmark as current, reset, type Source, sourceTitle, start, sync } from "./lib/store";
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
  | { name: "add"; source: Source };

/** "Open original" pushes the page onto this stack while it's mounted. */
function useBrowser(push: (r: Route) => void) {
  setBrowser((b) => push({ name: "browser", url: b.url, domain: b.domain }));
  cleanup(() => setBrowser(null));
}

const SIDEBAR = 240;
/** The sidebar floats inset from the window's edges, as on macOS 26. */
const INSET = 8;
const TOOLBAR = 52;

if (isAvailable) Window.setTitleBar({ style: "hidden", height: TOOLBAR });

/** Sidebar beside the content: desktops and tablets with room for it. */
const wide = () => platform.idiom !== "phone" && windowSize().width >= 640;

/** Pages slide in on phones and tablets, where the stack follows the swipe back. */
const pageAnimation = platform.os === "ios" || platform.os === "android" ? "default" : "none";

function App() {
  const ready = signal<"settings" | "app" | null>(null);
  void loadSettings().then((s) => {
    if (s.server && s.token) {
      ready.set("app");
      void start();
    } else ready.set("settings");
  });

  // Catch up whenever the app comes back to the front. nsh 0.4.0's web
  // runtime doesn't have `lifecycle` (it's typed and documented), so the web
  // build only syncs on start and on request.
  if (typeof lifecycle === "function") {
    effect(() => {
      if (lifecycle() === "active" && ready() === "app") void sync();
    });
  }

  const onConnected = async () => {
    await reset();
    ready.set("app");
    await start();
  };

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      {() => {
        const r = ready();
        if (!r) return null;
        if (r === "settings") return <Settings first onDone={onConnected} />;
        return wide() ? <Desktop onReconnect={onConnected} /> : <Phone onReconnect={onConnected} />;
      }}
    </View>
  );
}

/** Sidebar, and a stack of the library and the reader beside it. */
function Desktop(props: { onReconnect: () => void }) {
  const source = signal<Source>({ kind: "all" });
  const nav = createNavStack<Route>([{ name: "library", source: source() }]);
  const settingsOpen = signal(false);
  const adding = signal(false);
  useBrowser((r) => nav.push(r));
  const select = (s: Source) => {
    source.set(s);
    nav.setRoutes([{ name: "library", source: s }]);
  };
  return (
    <View class="flex-1 flex-row">
      <View
        class="overflow-hidden rounded-[18px]"
        style={{
          ...glass(),
          width: SIDEBAR,
          margin: INSET,
          marginRight: 0,
          borderCurve: "continuous",
        }}
      >
        <GlassTint radius={18} />
        <View
          desktop={{ windowDrag: true }}
          class="flex-row items-center justify-end px-4"
          style={{ height: TOOLBAR - INSET, paddingLeft: Math.max(0, titleBar().left - INSET) }}
        >
          <Wordmark size={21} />
        </View>
        <Sources
          selected={() => source()}
          onSelect={select}
          onSettings={() => settingsOpen.set(true)}
        />
      </View>
      <View class="flex-1">
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
                  onOpen={(b) => nav.push({ name: "reader", bookmark: b })}
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
        backdropClass="bg-black/25"
        class="m-auto w-[440px] overflow-hidden rounded-[26px]"
        style={{ ...glass(), borderCurve: "continuous" }}
      >
        <GlassTint radius={26} />
        <Settings
          onCancel={() => settingsOpen.set(false)}
          onDone={() => {
            settingsOpen.set(false);
            props.onReconnect();
          }}
        />
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

/** Library → bookmarks → reader, as a native stack that opens on the Library page. */
function Phone(props: { onReconnect: () => void }) {
  const nav = createNavStack<Route | { name: "settings" }>([{ name: "sources" }]);
  /** The Library page's "…" menu: the system bar's button opens it on iOS. */
  const homeMenu = signal(false);
  useBrowser((r) => nav.push(r));
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
                <Library
                  source={route.source}
                  wide={false}
                  initialQuery={route.query}
                  onOpen={(b) => nav.push({ name: "reader", bookmark: b })}
                  onAdd={() => nav.push({ name: "add", source: route.source })}
                />
              </NavPage>
            );
          case "reader": {
            const b = () => current(route.bookmark.id) ?? route.bookmark;
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
                    onPress={() => void showBookmarkMenu(b(), undefined)}
                  />
                }
              >
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
          case "settings":
            return (
              <NavPage
                animation={pageAnimation}
                title="Server"
                headerClass={solidHeaderClass()}
                style={{ backgroundColor: look().paper }}
              >
                <Settings
                  onDone={() => {
                    nav.pop();
                    props.onReconnect();
                  }}
                />
              </NavPage>
            );
        }
      }}
    </NavStack>
  );
}

mount(App);
