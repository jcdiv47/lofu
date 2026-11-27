import { Clipboard, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { extractUrl, isRedirectLink } from "../../../packages/shared/src/links";
import type { Bookmark } from "../lib/api";
import {
  addBookmark,
  collectionName,
  inTrash,
  type Source,
  savedFor,
  sourceTitle,
} from "../lib/store";
import { ActionButton, ErrorText, fieldClass } from "./ui";

/** Where saving adds something the source shows; the fixed views just save. */
const intoLabel = (s: Source) =>
  s.kind === "collection" || s.kind === "tag" || s.kind === "favorites" ? sourceTitle(s) : "";

/** Says where a link that's saved already is, rather than saving it twice. */
const alreadySaved = (b: Bookmark) => {
  const name = b.title.trim() || b.domain || b.url;
  const where = inTrash(b)
    ? " It's in the Trash."
    : b.collectionId && collectionName(b.collectionId)
      ? ` It's in ${collectionName(b.collectionId)}.`
      : "";
  return `Already saved as “${name}”.${where}`;
};

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
    const saved = savedFor(u);
    if (saved) {
      error.set(alreadySaved(saved));
      return;
    }
    busy.set(true);
    error.set("");
    try {
      const { bookmark, existing } = await addBookmark(u, props.source);
      if (existing) error.set(alreadySaved(bookmark));
      else props.onDone(bookmark);
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
          class={fieldClass}
          style={{ height: 40, fontSize: 15 }}
        />
        <If when={hint()}>
          <Text testID="add-hint" class="text-ink-faint" style={{ fontSize: 12.5, lineHeight: 17 }}>
            {hint()}
          </Text>
        </If>
      </View>
      <If when={error()}>
        <ErrorText testID="add-error" text={error()} />
      </If>
      <View class="flex-row items-center justify-end gap-2">
        <If when={props.onCancel}>
          <ActionButton variant="cancel" label="Cancel" onPress={() => props.onCancel?.()} />
        </If>
        <ActionButton
          testID="add-save"
          busy={busy()}
          label={busy() ? "Saving…" : "Save"}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
