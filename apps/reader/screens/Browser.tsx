import { safeAreaInsets, signal, Text, View, WebView, type WebViewRef } from "nsh";
import { GlassButton, GlassGroup, GlassTint, IconButton, RoundGlassButton } from "../components/ui";
import { openInBrowser } from "../lib/actions";
import { glass, look } from "../lib/look";

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
      name="external"
      label="Open in browser"
      testID="web-external"
      onPress={() => openInBrowser(at().url)}
    />
  );

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <If when={props.wide}>
        <View
          desktop={{ windowDrag: true }}
          class="flex-row items-center gap-2.5 pr-4"
          style={{ height: 60, paddingTop: 8, paddingLeft: (props.toolbarInset ?? 0) + 16 }}
        >
          <RoundGlassButton
            name="close"
            label="Close page"
            testID="web-close"
            onPress={props.onClose}
          />
          <GlassGroup>
            {back()}
            {forward()}
            {reload()}
          </GlassGroup>
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
          <RoundGlassButton
            name="external"
            label="Open in browser"
            testID="web-external"
            onPress={() => openInBrowser(at().url)}
          />
        </View>
      </If>
      <View class="flex-1">
        <WebView
          src={props.url}
          testID="web"
          accessibilityLabel="Original page"
          class="flex-1"
          ref={(r) => {
            web = r;
          }}
          desktop={{ allowsBackForwardNavigationGestures: true }}
          onNavigationStateChange={(e) => at.set(e)}
          onLoadStart={() => failed.set(null)}
          onError={(e) => failed.set(e.message || "The page didn't load.")}
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
        </View>
      </If>
    </View>
  );
}
