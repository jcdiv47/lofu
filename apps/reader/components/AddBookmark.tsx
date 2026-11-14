import { Clipboard, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { extractUrl, isRedirectLink } from "../../../packages/shared/src/links";
import type { Bookmark } from "../lib/api";
import { look } from "../lib/look";
import { addBookmark, type Source, sourceTitle } from "../lib/store";

/** Where saving adds something the source shows; the fixed views just save. */
const intoLabel = (s: Source) =>
  s.kind === "collection" || s.kind === "tag" || s.kind === "favorites" ? sourceTitle(s) : "";

/**
 * Save a page by its address. A dialog on desktops, a page on phones. Saving
 * from a collection or tag puts the bookmark there; the server reads the page
 * afterwards, as it does for the extension and `lofu add`.
 */
export function AddBookmark(props: {
  source: Source;
  initialText?: string;
  onDone: (b: Bookmark) => void;
  onCancel?: () => void;
}) {
  const url = signal(props.initialText ?? "");
  const error = signal("");
  const busy = signal(false);

  // Start from a link on the clipboard. The web would ask for permission
  // first; iOS asks "Allow Paste?" when the app reads it, so check that it
  // holds text before reading.
  const fromClipboard = signal(false);
  if (platform.os !== "web" && !props.initialText) {
    void Clipboard.hasText()
      .then((has) => (has ? Clipboard.readText() : ""))
      .then((t) => {
        const u = extractUrl(t);
        if (u && !url()) {
          url.set(u);
          fromClipboard.set(true);
        }
      })
      .catch(() => {});
  }

  /** What the field's text will save, when that isn't obvious from it. */
  const hint = () => {
    const raw = url().trim();
    const u = extractUrl(raw);
    const parts: string[] = [];
    if (fromClipboard()) parts.push("From the clipboard.");
    if (u && u !== raw && u !== `https://${raw}`) parts.push(`Saves ${u}`);
    if (u && isRedirectLink(u)) parts.push("A short link: the page it leads to is saved.");
    if (intoLabel(props.source)) parts.push(`Into ${intoLabel(props.source)}.`);
    return parts.join(" ");
  };

  const save = async () => {
    if (busy()) return;
    const u = extractUrl(url());
    if (!u) {
      error.set("No web address in that text.");
      return;
    }
    busy.set(true);
    error.set("");
    try {
      props.onDone(await addBookmark(u, props.source));
    } catch (e) {
      error.set((e as Error).message);
    } finally {
      busy.set(false);
    }
  };

  return (
    <View class="gap-4">
      <View class="gap-1.5">
        <Input
          testID="add-url"
          value={url()}
          placeholder="https://…"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onChange={({ value }) => {
            url.set(value);
            error.set("");
            fromClipboard.set(false);
          }}
          // Share text pastes as its link alone.
          pasteBehavior="report"
          onPaste={({ text }) => {
            url.set(extractUrl(text) ?? `${url()}${text}`);
            error.set("");
            fromClipboard.set(false);
          }}
          onSubmit={() => void save()}
          class="rounded-xl px-3.5"
          style={{
            height: 40,
            color: look().ink,
            fontSize: 15,
            backgroundColor: look().card,
            borderWidth: 1,
            borderColor: look().rule,
            placeholderColor: look().inkFaint,
          }}
        />
        <If when={hint()}>
          <Text
            testID="add-hint"
            style={{ color: look().inkFaint, fontSize: 12.5, lineHeight: 17 }}
          >
            {hint()}
          </Text>
        </If>
      </View>
      <If when={error()}>
        <Text testID="add-error" style={{ color: look().stamp, fontSize: 13.5, lineHeight: 19 }}>
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
          testID="add-save"
          accessibilityState={{ disabled: busy() }}
          onPress={() => void save()}
          class="rounded-full px-5 py-2.5 active:opacity-70"
          style={{ backgroundColor: look().ink, opacity: busy() ? 0.6 : 1 }}
        >
          <Text style={{ color: look().paper, fontSize: 14.5, fontWeight: "600" }}>
            {busy() ? "Saving…" : "Save"}
          </Text>
        </View>
      </View>
    </View>
  );
}
