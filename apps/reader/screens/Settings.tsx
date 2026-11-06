import { type InputRef, keyboardFrame, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { api, loadSettings, normalizeServer, saveSettings } from "../lib/api";
import { fonts, look } from "../lib/look";
import { Wordmark } from "./Sidebar";

/**
 * The server address and token. Shown on first launch (full screen), as a
 * dialog on desktops and as a page on phones. Connecting checks both before
 * they're saved, so a typo is caught here rather than as an empty library.
 */
export function Settings(props: { onDone: () => void; onCancel?: () => void; first?: boolean }) {
  const server = signal("");
  const token = signal("");
  const error = signal("");
  const busy = signal(false);
  let tokenInput: InputRef | null = null;
  void loadSettings().then((s) => {
    server.set(s.server);
    token.set(s.token);
  });

  const connect = async () => {
    if (busy()) return;
    const s = { server: normalizeServer(server()), token: token().trim() };
    if (!/^https?:\/\//.test(s.server)) {
      error.set("The address starts with https:// (or http:// on your own network).");
      return;
    }
    if (!s.token) {
      error.set("Paste a token from `bun run stack:token create <name>`.");
      return;
    }
    busy.set(true);
    error.set("");
    try {
      await api.check(s);
      await saveSettings(s);
      props.onDone();
    } catch (e) {
      error.set((e as Error).message);
    } finally {
      busy.set(false);
    }
  };

  const field = (
    label: string,
    id: string,
    value: () => string,
    set: (v: string) => void,
    placeholder: string,
    masked = false,
  ) => (
    <View class="gap-1.5">
      <Text style={{ color: look().inkSoft, fontSize: 12.5, fontWeight: "600" }}>{label}</Text>
      <Input
        testID={id}
        value={value()}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={id === "server" ? "url" : "default"}
        // Return moves from the address to the token, and connects from there.
        returnKeyType={id === "server" ? "next" : "go"}
        ref={(r) => {
          if (id === "token") tokenInput = r;
        }}
        masked={masked}
        onChange={({ value: v }) => {
          set(v);
          error.set("");
        }}
        onSubmit={() => (id === "server" ? tokenInput?.focus() : void connect())}
        class="rounded-xl px-3.5"
        style={{
          height: 40,
          color: look().ink,
          fontSize: 15,
          fontFamily: id === "token" ? fonts.mono : undefined,
          backgroundColor: look().card,
          borderWidth: 1,
          borderColor: look().rule,
          placeholderColor: look().inkFaint,
        }}
      />
    </View>
  );

  const form = (
    <View class="gap-5">
      {field(
        "Server address",
        "server",
        server,
        (v) => server.set(v),
        "https://homebox.tail1234.ts.net",
      )}
      {field("API token", "token", token, (v) => token.set(v), "lofu_…", !props.first)}
      <If when={error()}>
        <Text
          testID="settings-error"
          style={{ color: look().stamp, fontSize: 13.5, lineHeight: 19 }}
        >
          {error()}
        </Text>
      </If>
      <View class="flex-row items-center justify-end gap-2">
        <If when={props.onCancel}>
          <View
            role="button"
            onPress={() => props.onCancel?.()}
            class="rounded-full px-4 py-2.5 active:opacity-60"
          >
            <Text style={{ color: look().inkSoft, fontSize: 14.5, fontWeight: "500" }}>Cancel</Text>
          </View>
        </If>
        <View
          role="button"
          testID="connect"
          accessibilityState={{ disabled: busy() }}
          onPress={() => void connect()}
          class="rounded-full px-5 py-2.5 active:opacity-70"
          style={{ backgroundColor: look().ink, opacity: busy() ? 0.6 : 1 }}
        >
          <Text style={{ color: look().paper, fontSize: 14.5, fontWeight: "600" }}>
            {busy() ? "Connecting…" : "Connect"}
          </Text>
        </View>
      </View>
    </View>
  );

  return (
    <If
      when={props.first}
      else={
        <View class="gap-5 p-6">
          <Text style={{ color: look().ink, fontSize: 19, fontWeight: "700" }}>Your server</Text>
          {form}
        </View>
      }
    >
      <View desktop={{ windowDrag: true }} class="flex-1" style={{ backgroundColor: look().paper }}>
        {/* Scrolls on phones so Connect stays above the keyboard; a tap
            outside the fields or a drag puts the keyboard away. */}
        <Scroll
          class="flex-1"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentStyle={{
            flexGrow: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 24,
            paddingTop: 24,
            paddingBottom: keyboardFrame().height + 24,
          }}
        >
          <View class="w-full gap-8" style={{ maxWidth: 400 }}>
            <View class="gap-2">
              <Wordmark size={44} />
              <Text style={{ color: look().inkSoft, fontSize: 15.5, lineHeight: 22 }}>
                Your bookmarks and reading, from your own server: the lofu server on your network or
                tailnet.
              </Text>
            </View>
            {form}
          </View>
        </Scroll>
      </View>
    </If>
  );
}
