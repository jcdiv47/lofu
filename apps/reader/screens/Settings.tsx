import {
  effect,
  type InputRef,
  type JSX,
  keyboardFrame,
  platform,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type ViewRef,
} from "nsh";
import { AlertDialog, Input } from "nsh/base";
import { isAvailable as desktopApp, Menu } from "nsh/desktop";
import { nativeControls, SystemGlassButton } from "../components/native";
import { Icon } from "../components/ui";
import { hasBrowser, openWays } from "../lib/actions";
import { api, loadSettings, normalizeServer, saveSettings } from "../lib/api";
import {
  clearArticles,
  downloading,
  type KeepMode,
  keepMode,
  keepModes,
  keptBytes,
  keptCount,
  prefetchArticles,
  setKeepMode,
} from "../lib/articles";
import { onDisk } from "../lib/files";
import { fonts, look } from "../lib/look";
import { type OpenIn, prefs, setPrefs } from "../lib/prefs";
import { bookmarks, offline } from "../lib/store";
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
  void loadSettings()
    .then((s) => {
      server.set(s.server);
      token.set(s.token);
    })
    .catch((e) => error.set((e as Error).message));

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
      tokenInput?.blur();
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

  // First launch on a small phone: iOS scrolls the field being typed in
  // above the keyboard, and Connect under it stayed behind the keyboard.
  // It's kept in view while the keyboard is up.
  let connectButton: ViewRef | undefined;
  effect(() => {
    if (props.first && keyboardFrame().height > 0)
      untracked(() => connectButton?.reveal({ vertical: "nearest" }));
  });

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
            accessibilityLabel="Cancel"
            onPress={() => props.onCancel?.()}
            class="rounded-full px-4 py-2.5 active:opacity-60"
          >
            <Text style={{ color: look().inkSoft, fontSize: 14.5, fontWeight: "500" }}>Cancel</Text>
          </View>
        </If>
        <View
          role="button"
          testID="connect"
          ref={(r) => {
            connectButton = r;
          }}
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

  /** The saved server and token: Connect has something to do once they're edited. */
  const saved = signal({ server: "", token: "" });
  void loadSettings()
    .then((s) => saved.set(s))
    .catch(() => {});
  const edited = () =>
    normalizeServer(server()) !== saved().server || token().trim() !== saved().token;

  /** A field in a row of the Server group. */
  const rowField = (
    id: "server" | "token",
    value: () => string,
    set: (v: string) => void,
    placeholder: string,
  ) => (
    <Input
      testID={id}
      value={value()}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={id === "server" ? "url" : "default"}
      returnKeyType={id === "server" ? "next" : "go"}
      ref={(r) => {
        if (id === "token") tokenInput = r;
      }}
      masked={id === "token"}
      onChange={({ value: v }) => {
        set(v);
        error.set("");
      }}
      onSubmit={() => (id === "server" ? tokenInput?.focus() : void connect())}
      class="flex-1 rounded-[7px] px-2.5"
      style={{
        height: 28,
        color: look().ink,
        fontSize: 13.5,
        fontFamily: id === "token" ? fonts.mono : undefined,
        backgroundColor: look().control,
        placeholderColor: look().inkFaint,
      }}
    />
  );

  return (
    <If
      when={props.first}
      else={
        <View class="gap-5 p-5">
          <If when={props.onCancel}>
            <Text style={{ color: look().ink, fontSize: 17, fontWeight: "700" }}>Settings</Text>
          </If>
          <Group
            title="Server"
            footer={
              <View class="flex-row items-center gap-3">
                <Text
                  testID={error() ? "settings-error" : undefined}
                  class="flex-1"
                  style={{
                    color: error() ? look().stamp : look().inkSoft,
                    fontSize: 12,
                    lineHeight: 16,
                  }}
                >
                  {error() || "The lofu server on your network or tailnet."}
                </Text>
                <Button
                  label={busy() ? "Connecting…" : "Connect"}
                  testID="connect"
                  disabled={busy() || !edited()}
                  onPress={() => void connect()}
                />
              </View>
            }
          >
            <Row label="Address" first>
              {rowField("server", server, (v) => server.set(v), "https://homebox.tail1234.ts.net")}
            </Row>
            <Row label="API token">{rowField("token", token, (v) => token.set(v), "lofu_…")}</Row>
          </Group>
          <OpeningBookmarks />
          <If when={onDisk}>
            <OfflineReading />
          </If>
          <If when={props.onCancel}>
            <View class="flex-row justify-end">
              <Button label="Done" testID="settings-done" onPress={() => props.onCancel?.()} />
            </View>
          </If>
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

/**
 * The Mac's system menus: a choice is a pop-up button in its row, as in
 * System Settings. Elsewhere (phones, the web) the choices are rows of
 * their own, the current one checked.
 */
const popUps = desktopApp;
/** The system's glass buttons, where the Mac has them (`components/native.tsx`). */
const systemButtons = nativeControls && platform.os === "macos";
/** The rows' text: the Mac's is smaller, as its controls are. */
const body = popUps ? 13.5 : 15;

/** A titled group of rows on a rounded panel, with a note or buttons under it. */
function Group(props: { title: string; footer?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="gap-1.5">
      <Text style={{ color: look().inkSoft, fontSize: 12.5, fontWeight: "600", paddingLeft: 4 }}>
        {props.title}
      </Text>
      <View
        class="overflow-hidden rounded-[12px]"
        style={{
          backgroundColor: look().groupFill,
          borderWidth: 1,
          borderColor: look().groupEdge,
          borderCurve: "continuous",
        }}
      >
        {props.children}
      </View>
      <If when={props.footer}>
        <View style={{ paddingHorizontal: 4, paddingTop: 2 }}>{props.footer}</View>
      </If>
    </View>
  );
}

/** A note under a group. */
function Note(props: { children: string }) {
  return (
    <Text style={{ color: look().inkSoft, fontSize: 12, lineHeight: 16 }}>{props.children}</Text>
  );
}

/** A row of a group: its name on the left, its control on the right. */
function Row(props: { label: string; first?: boolean; children: JSX.Element }) {
  return (
    <View
      class="flex-row items-center gap-3 px-3.5"
      style={{ minHeight: 44, borderTopWidth: props.first ? 0 : 1, borderColor: look().groupEdge }}
    >
      <Text style={{ color: look().ink, fontSize: body, minWidth: 72 }}>{props.label}</Text>
      <View class="flex-1 flex-row items-center justify-end">{props.children}</View>
    </View>
  );
}

/** A button: the system's glass one on the Mac, the app's own capsule elsewhere. */
function Button(props: { label: string; testID: string; onPress: () => void; disabled?: boolean }) {
  if (systemButtons)
    return (
      <SystemGlassButton
        title={props.label}
        label={props.label}
        controlSize="large"
        testID={props.testID}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      class="rounded-full px-4 py-2 active:opacity-60"
      style={{
        backgroundColor: look().control,
        borderWidth: 1,
        borderColor: look().groupEdge,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: look().ink, fontSize: 13.5, fontWeight: "500" }}>{props.label}</Text>
    </View>
  );
}

type Option<T extends string> = { value: T; label: string };

/**
 * One of a few choices. On the Mac, a pop-up button whose system menu has
 * them all, the current one checked; elsewhere, a row each (`Choices`).
 */
function PopUp<T extends string>(props: {
  testID: string;
  label: string;
  options: () => Option<T>[];
  value: () => T;
  onChange: (v: T) => void;
}) {
  let ref: ViewRef | undefined;
  const current = () => props.options().find((o) => o.value === props.value());
  return (
    <View
      ref={(r) => {
        ref = r;
      }}
      role="button"
      testID={props.testID}
      accessibilityLabel={`${props.label}: ${current()?.label ?? ""}`}
      onPress={async () => {
        const m = await ref?.measure();
        await Menu.popup(
          props.options().map((o) => ({
            label: o.label,
            checked: o.value === props.value(),
            onSelect: () => props.onChange(o.value),
          })),
          m ? { x: m.pagePosition.x, y: m.pagePosition.y + m.bounds.size.height + 4 } : undefined,
        );
      }}
      class="flex-row items-center gap-1.5 rounded-[7px] py-1 pl-2.5 pr-1.5 active:opacity-60"
      style={{ backgroundColor: look().control }}
    >
      <Text style={{ color: look().ink, fontSize: 13.5 }}>{current()?.label ?? ""}</Text>
      <Icon name="upDown" size={11} color={look().inkSoft} />
    </View>
  );
}

/** The choices as rows of their group, the current one checked (phones, the web). */
function Choices<T extends string>(props: {
  id: (v: T) => string;
  options: () => Option<T>[];
  value: () => T;
  onChange: (v: T) => void;
}) {
  return (
    <View role="radiogroup">
      <Each of={props.options()}>
        {(o, i) => (
          <View
            role="radio"
            testID={props.id(o().value)}
            accessibilityLabel={o().label}
            accessibilityState={{ checked: props.value() === o().value }}
            onPress={() => props.onChange(o().value)}
            class="flex-row items-center gap-3 px-3.5 active:opacity-60"
            style={{
              minHeight: 44,
              borderTopWidth: i() === 0 ? 0 : 1,
              borderColor: look().groupEdge,
            }}
          >
            <Text class="flex-1" style={{ color: look().ink, fontSize: body }}>
              {o().label}
            </Text>
            <If when={props.value() === o().value}>
              <Icon name="check" size={15} color={look().stamp} />
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

/** What a tap on a bookmark opens (`openBookmark`); its menu offers the others. */
function OpeningBookmarks() {
  const label: Record<OpenIn, string> = {
    reader: "Reader, with highlights",
    app: hasBrowser ? "Original page, in lofu" : "Original page, in a new tab",
    browser: "Original page, in your browser",
  };
  const options = () => openWays().map((w) => ({ value: w.id, label: label[w.id] }));
  const value = () => prefs().openIn;
  const set = (v: OpenIn) => setPrefs({ openIn: v });
  return (
    <Group
      title="Opening bookmarks"
      footer={
        <Note>{`What ${popUps ? "a click" : "a tap"} on a bookmark opens. Its menu has the others.`}</Note>
      }
    >
      <If
        when={popUps}
        else={<Choices id={(v) => `open-in-${v}`} options={options} value={value} onChange={set} />}
      >
        <Row label="Open in" first>
          <PopUp testID="open-in" label="Open in" options={options} value={value} onChange={set} />
        </Row>
      </If>
    </Group>
  );
}

const megabytes = (n: number) =>
  n < 1 << 20 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;

/**
 * What is kept on the device for reading offline (`lib/articles.ts`): which
 * articles are fetched ahead, how many are here and the room they take,
 * and buttons to fetch them now (before a flight) or let them go.
 */
function OfflineReading() {
  const bytes = signal(0);
  // Measured again as articles come and go.
  effect(() => {
    keptCount();
    if (downloading()) return;
    untracked(() => void keptBytes().then((n) => bytes.set(n)));
  });

  const status = () => {
    const d = downloading();
    if (d) return `Downloading ${d.done} of ${d.total}…`;
    const n = keptCount();
    if (!n) return "No articles yet";
    return `${n} article${n === 1 ? "" : "s"} · ${megabytes(bytes())}`;
  };

  const remove = async () => {
    const n = keptCount();
    const { action } = await AlertDialog.show({
      title: `Remove ${n} article${n === 1 ? "" : "s"} from this device?`,
      description:
        keepMode() === "opened"
          ? "They're downloaded again when you open them."
          : "They're downloaded again when you open them, and as you chose after the next sync.",
      actions: [
        { id: "remove", label: "Remove", role: "destructive" },
        { id: "cancel", label: "Cancel", role: "cancel" },
      ],
    });
    if (action === "remove") await clearArticles();
  };

  const options = () => keepModes.map((m) => ({ value: m.mode, label: m.label }));
  const set = (mode: KeepMode) => {
    setKeepMode(mode);
    void prefetchArticles(bookmarks());
  };
  const here = platform.os === "macos" ? "this Mac" : "this device";

  return (
    <Group
      title="Reading offline"
      footer={
        <View class="gap-3">
          <Note>Every article you open is kept here, with its pictures.</Note>
          <View class="flex-row flex-wrap justify-end gap-2">
            <Button
              label={`Remove from ${here === "this Mac" ? "This Mac" : "This Device"}…`}
              testID="offline-remove"
              disabled={!!downloading() || keptCount() === 0}
              onPress={() => void remove()}
            />
            <Button
              label="Download Now"
              testID="offline-download"
              disabled={!!downloading() || offline() || keepMode() === "opened"}
              onPress={() => void prefetchArticles(bookmarks(), true)}
            />
          </View>
        </View>
      }
    >
      <If
        when={popUps}
        else={<Choices id={(v) => `keep-${v}`} options={options} value={keepMode} onChange={set} />}
      >
        <Row label="Download ahead" first>
          <PopUp
            testID="keep"
            label="Download ahead"
            options={options}
            value={keepMode}
            onChange={set}
          />
        </Row>
      </If>
      <Row label={`On ${here}`}>
        <Text testID="offline-status" style={{ color: look().inkSoft, fontSize: body }}>
          {status()}
        </Text>
      </Row>
    </Group>
  );
}
