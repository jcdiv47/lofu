import { cleanup, effect, lifecycle, mount, platform, signal, Text, View, windowSize } from "nsh";
import { createNavStack, Dialog, NavPage, NavStack } from "nsh/base";
import { isAvailable, titleBar, Window } from "nsh/desktop";
import { AddBookmark } from "./components/AddBookmark";
import { Icon } from "./components/ui";
import { setBrowser, showBookmarkMenu } from "./lib/actions";
import type { Bookmark } from "./lib/api";
import { loadSettings } from "./lib/api";
import { look } from "./lib/look";
import { bookmark as current, reset, type Source, sourceTitle, start, sync } from "./lib/store";
import { Browser } from "./screens/Browser";
import { Library } from "./screens/Library";
import { Reader } from "./screens/Reader";
import { Settings } from "./screens/Settings";
import { Sources, Wordmark } from "./screens/Sidebar";

type Route =
  | { name: "sources" }
  | { name: "library"; source: Source }
  | { name: "reader"; bookmark: Bookmark }
  | { name: "browser"; url: string; domain: string }
  | { name: "add"; source: Source };

/** "Open original" pushes the page onto this stack while it's mounted. */
function useBrowser(push: (r: Route) => void) {
  setBrowser((b) => push({ name: "browser", url: b.url, domain: b.domain }));
  cleanup(() => setBrowser(null));
}

const SIDEBAR = 232;
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
        style={{
          width: SIDEBAR,
          backgroundColor: look().sidebar,
          borderRightWidth: 1,
          borderColor: look().ruleSoft,
        }}
      >
        <View
          desktop={{ windowDrag: true }}
          class="flex-row items-center justify-end px-4"
          style={{ height: TOOLBAR, paddingLeft: titleBar().left }}
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
        backdropClass="bg-black/40"
        class="m-auto w-[440px] overflow-hidden rounded-2xl"
        style={{ backgroundColor: look().paper }}
      >
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
        backdropClass="bg-black/40"
        class="m-auto w-[440px] overflow-hidden rounded-2xl"
        style={{ backgroundColor: look().paper }}
      >
        <If when={adding()}>
          <View class="gap-5 p-6" style={{ backgroundColor: look().paper }}>
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

/** Library → bookmarks → reader, as a native stack that opens on all bookmarks. */
function Phone(props: { onReconnect: () => void }) {
  const nav = createNavStack<Route | { name: "settings" }>([
    { name: "sources" },
    { name: "library", source: { kind: "all" } },
  ]);
  useBrowser((r) => nav.push(r));
  const headerClass = () => `bg-[${look().paper}] text-[${look().ink}] tint-[${look().stamp}]`;
  return (
    <NavStack state={nav} class="flex-1" style={{ backgroundColor: look().paper }}>
      {(route) => {
        switch (route.name) {
          case "sources":
            return (
              <NavPage
                animation={pageAnimation}
                title="Library"
                headerLargeTitle
                headerBackTitle="Library"
                headerClass={headerClass()}
                style={{ backgroundColor: look().paper }}
              >
                <View class="flex-1" style={{ backgroundColor: look().paper }}>
                  <Sources
                    compact
                    selected={() => null}
                    onSelect={(s) => nav.push({ name: "library", source: s })}
                    onSettings={() => nav.push({ name: "settings" })}
                  />
                </View>
              </NavPage>
            );
          case "library":
            return (
              <NavPage
                animation={pageAnimation}
                title={sourceTitle(route.source)}
                headerLargeTitle
                headerClass={headerClass()}
                style={{ backgroundColor: look().paper }}
                ios={{ headerRightSystemItem: "add" }}
                headerRight={
                  <View
                    role="button"
                    accessibilityLabel="Add bookmark"
                    testID="add"
                    onPress={() => nav.push({ name: "add", source: route.source })}
                    class="h-8 w-8 items-center justify-center active:opacity-60"
                  >
                    <Icon name="plus" size={20} color={look().stamp} />
                  </View>
                }
              >
                <Library
                  source={route.source}
                  wide={false}
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
                headerClass={headerClass()}
                style={{ backgroundColor: look().paper }}
                ios={{ headerRightSymbol: "ellipsis.circle" }}
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
                headerClass={headerClass()}
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
                headerClass={headerClass()}
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
                headerClass={headerClass()}
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
