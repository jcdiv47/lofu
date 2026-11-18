import { cleanup, safeAreaInsets, signal, Text, View, WebView, type WebViewRef } from "nsh";
import {
  NativeGlassBar,
  nativeGlassBar,
  nativeScrollEdges,
  ScrollEdge,
} from "../components/native";
import { GlassButton, GlassGroup, GlassTint, IconButton, RoundGlassButton } from "../components/ui";
import { openInBrowser } from "../lib/actions";
import { glass, look } from "../lib/look";
import { contentLeft, nativeToolbar, useToolbar } from "../lib/toolbar";
import { isAppLinkRefusal } from "../lib/web";

/**
 * The room before the page's title that the window toolbar's Close and its
 * back, forward and reload take (macOS), from the content's left edge, until
 * the toolbar says where they end (its `mark`; measured on macOS 26, where
 * AppKit gives the space before them a slot of at least 36 points).
 */
const NAV_ROOM = 214;

/**
 * Silences the page: its videos and sounds, and those of the frames it can
 * reach. nsh keeps a popped page's web view alive (lent to the image of the
 * screen that leaves) past the pop on the Mac, so a video went on playing
 * after Close.
 */
const PAUSE_MEDIA = `(() => {
  const quiet = (d) => {
    try {
      d.querySelectorAll("video, audio").forEach((m) => { m.pause(); m.muted = true; });
      d.querySelectorAll("iframe").forEach((f) => { try { if (f.contentDocument) quiet(f.contentDocument); } catch {} });
    } catch {}
  };
  quiet(document);
})(); true;`;

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * A saved page's original, in a web view: back and forward through what you
 * follow from it, reload, and a way out to the system's browser. Desktops get
 * a toolbar like the reader's; phones a bar along the bottom, under the
 * system header.
 */
export function Browser(props: {
  url: string;
  onClose: () => void;
  wide: boolean;
  /** Leading room for the window's controls when the sidebar is hidden. */
  toolbarInset?: number;
}) {
  const at = signal({
    url: props.url,
    title: "",
    loading: true,
    canGoBack: false,
    canGoForward: false,
  });
  const failed = signal<string | null>(null);
  const insets = safeAreaInsets();
  let web: WebViewRef | null = null;
  let quiet = false;
  /** Stops what the page plays: before it goes, however it goes. */
  const silence = () => {
    if (quiet) return;
    quiet = true;
    web?.injectJavaScript(PAUSE_MEDIA);
  };
  const leave = () => {
    silence();
    props.onClose();
  };
  // Back from the menu (⌘[) or the system pops the page without Close.
  cleanup(silence);

  const back = () => (
    <IconButton
      name="back"
      label="Back"
      testID="web-back"
      disabled={!at().canGoBack}
      onPress={() => web?.goBack()}
    />
  );
  const forward = () => (
    <IconButton
      name="forward"
      label="Forward"
      testID="web-forward"
      disabled={!at().canGoForward}
      onPress={() => web?.goForward()}
    />
  );
  const reload = () => (
    <IconButton
      name={at().loading ? "close" : "refresh"}
      label={at().loading ? "Stop loading" : "Reload"}
      testID="web-reload"
      onPress={() => {
        if (at().loading) web?.stopLoading();
        else {
          failed.set(null);
          web?.reload();
        }
      }}
    />
  );
  const external = () => (
    <IconButton
      name="compass"
      label="Open in browser"
      testID="web-external"
      onPress={() => openInBrowser(at().url)}
    />
  );

  /** A press on the phone's native bar (`NativeGlassBar`), by its button's id. */
  const barTap = (id: string) => {
    if (id === "web-back") web?.goBack();
    else if (id === "web-forward") web?.goForward();
    else if (id === "web-external") openInBrowser(at().url);
    else if (id === "web-reload") {
      if (at().loading) web?.stopLoading();
      else {
        failed.set(null);
        web?.reload();
      }
    }
  };

  /** The Mac's window toolbar has the page's controls (`lib/toolbar.ts`). */
  const native = props.wide && nativeToolbar;
  /** Where the window toolbar's reload ends, from the window's left edge, once it says. */
  const navEnd = signal<number | null>(null);
  /** The page's title starts after the controls, from the content's left edge. */
  const navRoom = () => {
    const end = navEnd();
    return end == null ? 16 + NAV_ROOM : Math.max(16, end - contentLeft() + 10);
  };
  if (native) {
    useToolbar(() => [
      { kind: "space", id: "lead", x: contentLeft() + 16 },
      {
        kind: "button",
        id: "close",
        symbol: "xmark",
        label: "Close page",
        onPress: leave,
      },
      { kind: "gap" },
      {
        kind: "button",
        id: "web-back",
        symbol: "chevron.left",
        label: "Back",
        disabled: !at().canGoBack,
        onPress: () => web?.goBack(),
      },
      {
        kind: "button",
        id: "web-forward",
        symbol: "chevron.right",
        label: "Forward",
        disabled: !at().canGoForward,
        onPress: () => web?.goForward(),
      },
      {
        kind: "button",
        id: "web-reload",
        symbol: at().loading ? "xmark" : "arrow.clockwise",
        label: at().loading ? "Stop loading" : "Reload",
        onPress: () => {
          if (at().loading) web?.stopLoading();
          else {
            failed.set(null);
            web?.reload();
          }
        },
      },
      { kind: "mark", id: "nav-end", onPlace: (_right, left) => navEnd.set(left) },
      { kind: "flex" },
      {
        kind: "button",
        id: "web-external",
        symbol: "safari",
        label: "Open in browser",
        onPress: () => openInBrowser(at().url),
      },
    ]);
  }

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <If when={props.wide}>
        <View
          desktop={{ windowDrag: true }}
          class="flex-row items-center gap-2.5"
          style={{
            // With the window's toolbar, the controls are its items: the row
            // keeps the page's title, between them.
            height: native ? 52 : 60,
            paddingTop: native ? 0 : 8,
            paddingLeft: (props.toolbarInset ?? 0) + (native ? navRoom() : 16),
            paddingRight: native ? 64 : 16,
          }}
        >
          <If when={!native}>
            <RoundGlassButton name="close" label="Close page" testID="web-close" onPress={leave} />
            <GlassGroup>
              {back()}
              {forward()}
              {reload()}
            </GlassGroup>
          </If>
          <View class="flex-1 px-1">
            <Text
              testID="web-title"
              class="truncate"
              style={{ color: look().ink, fontSize: 13, fontWeight: "600" }}
            >
              {at().title || host(at().url)}
            </Text>
            <Text class="truncate" style={{ color: look().inkFaint, fontSize: 11.5 }}>
              {host(at().url)}
            </Text>
          </View>
          <If when={!native}>
            <RoundGlassButton
              name="compass"
              label="Open in browser"
              testID="web-external"
              onPress={() => openInBrowser(at().url)}
            />
          </If>
        </View>
      </If>
      <View class="flex-1">
        <WebView
          src={props.url}
          testID="web"
          accessibilityLabel="Original page"
          class="flex-1"
          ref={(r) => {
            // Kept through unmount, for `silence`.
            if (r) web = r;
          }}
          desktop={{ allowsBackForwardNavigationGestures: true }}
          onNavigationStateChange={(e) => at.set(e)}
          onLoadStart={() => failed.set(null)}
          onError={(e) => {
            // A page sending the reader to its app (`zhihu://…`) stays put.
            if (isAppLinkRefusal(e)) return;
            failed.set(e.message || "The page didn't load.");
          }}
        />
        <If when={failed()}>
          {(message) => (
            <View
              class="absolute inset-0 items-center gap-2 px-8 pt-24"
              style={{ backgroundColor: look().paper }}
            >
              <Text
                class="text-center"
                style={{ color: look().inkSoft, fontSize: 15, lineHeight: 21 }}
              >
                {`This page didn't load: ${message()}`}
              </Text>
              <View class="mt-2">
                <GlassButton
                  label="Open in browser"
                  prominent
                  onPress={() => openInBrowser(at().url)}
                />
              </View>
            </View>
          )}
        </If>
      </View>
      <If when={!props.wide}>
        {/* A capsule of glass floating over the page, as Safari's on iOS 26. */}
        <View
          class="absolute right-0 left-0 items-center"
          style={{ bottom: Math.max(insets().bottom, 12) + 4, pointerEvents: "box-none" }}
        >
          {nativeScrollEdges && <ScrollEdge edge="bottom" />}
          <If
            when={nativeGlassBar}
            else={
              <View
                class="h-14 flex-row items-center gap-5 rounded-full px-4"
                style={{ ...glass(), borderCurve: "continuous" }}
              >
                <GlassTint />
                {back()}
                {forward()}
                {reload()}
                {external()}
              </View>
            }
          >
            {/* The system's glass: it answers the touch as Safari's bar does. */}
            <NativeGlassBar
              testID="web-bar"
              items={[
                {
                  id: "web-back",
                  symbol: "chevron.left",
                  label: "Back",
                  disabled: !at().canGoBack,
                },
                {
                  id: "web-forward",
                  symbol: "chevron.right",
                  label: "Forward",
                  disabled: !at().canGoForward,
                },
                {
                  id: "web-reload",
                  symbol: at().loading ? "xmark" : "arrow.clockwise",
                  label: at().loading ? "Stop loading" : "Reload",
                },
                { id: "web-external", symbol: "safari", label: "Open in browser" },
              ]}
              height={56}
              onTap={(e) => barTap(e.id)}
            />
          </If>
        </View>
      </If>
    </View>
  );
}
