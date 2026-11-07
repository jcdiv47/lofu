import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Bookmark } from "../lib/api";
import { look } from "../lib/look";
import { tags as allTags, bookmark as current, updateBookmark } from "../lib/store";

/** Tags as typed: separated by commas (a tag may have spaces), lowercased, once each. */
export const parseTags = (text: string) => [
  ...new Set(
    text
      .split(/[,，]/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/**
 * A bookmark's title, tags and note. A dialog on desktops, a page on phones.
 * Saving changes only what changed.
 */
export function EditBookmark(props: { b: Bookmark; onDone: () => void; onCancel?: () => void }) {
  const b = () => current(props.b.id) ?? props.b;
  const title = signal(b().title);
  const tags = signal(b().tags.join(", "));
  const note = signal(b().note ?? "");
  const error = signal("");
  const busy = signal(false);

  /** Tags in use that start like the one being typed. */
  const suggestions = () => {
    const typed = tags().split(/[,，]/).pop()?.trim().toLowerCase() ?? "";
    const have = new Set(parseTags(tags()));
    if (!typed) return [];
    return allTags()
      .filter((t) => t.name.startsWith(typed) && t.name !== typed && !have.has(t.name))
      .slice(0, 6);
  };
  const complete = (name: string) => {
    const parts = tags().split(/[,，]/);
    parts[parts.length - 1] = ` ${name}`;
    tags.set(`${parts.join(",").trim()}, `);
  };

  const save = async () => {
    if (busy()) return;
    const patch: Parameters<typeof updateBookmark>[1] = {};
    const t = title().trim();
    if (t && t !== b().title) patch.title = t;
    const tg = parseTags(tags());
    if (tg.join("\n") !== b().tags.join("\n")) patch.tags = tg;
    const n = note().trim();
    if (n !== (b().note ?? "").trim()) patch.note = n || null;
    if (!Object.keys(patch).length) {
      props.onDone();
      return;
    }
    busy.set(true);
    error.set("");
    try {
      await updateBookmark(b().id, patch);
      props.onDone();
    } catch (e) {
      error.set((e as Error).message);
    } finally {
      busy.set(false);
    }
  };

  const fieldStyle = (height: number) => ({
    height,
    color: look().ink,
    fontSize: 15,
    backgroundColor: look().card,
    borderWidth: 1,
    borderColor: look().rule,
    placeholderColor: look().inkFaint,
  });
  const label = (text: string) => (
    <Text style={{ color: look().inkSoft, fontSize: 12.5, fontWeight: "600" }}>{text}</Text>
  );

  return (
    <View class="gap-4">
      <View class="gap-1.5">
        {label("Title")}
        <Input
          testID="edit-title"
          value={title()}
          placeholder={b().url}
          returnKeyType="next"
          onChange={({ value }) => title.set(value)}
          class="rounded-xl px-3.5"
          style={fieldStyle(40)}
        />
      </View>
      <View class="gap-1.5">
        {label("Tags")}
        <Input
          testID="edit-tags"
          value={tags()}
          placeholder="reading, rust, essays"
          autoCapitalize="none"
          autoCorrect={false}
          onChange={({ value }) => tags.set(value)}
          onSubmit={() => void save()}
          class="rounded-xl px-3.5"
          style={fieldStyle(40)}
        />
        <If when={suggestions().length}>
          <View class="flex-row flex-wrap gap-1.5">
            <Each of={suggestions()}>
              {(t) => (
                <View
                  role="button"
                  onPress={() => complete(t().name)}
                  class="rounded-full px-2.5 py-1 active:opacity-60"
                  style={{ backgroundColor: look().field }}
                >
                  <Text style={{ color: look().inkSoft, fontSize: 12.5 }}>#{t().name}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
      <View class="gap-1.5">
        {label("Note")}
        <Input
          testID="edit-note"
          value={note()}
          placeholder="Why you saved it, what to look for…"
          multiline
          onChange={({ value }) => note.set(value)}
          class="rounded-xl px-3.5 py-2.5"
          style={fieldStyle(132)}
        />
      </View>
      <If when={error()}>
        <Text testID="edit-error" style={{ color: look().stamp, fontSize: 13.5, lineHeight: 19 }}>
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
          testID="edit-save"
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
