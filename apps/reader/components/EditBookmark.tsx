import { signal, View } from "nsh";
import { Input } from "nsh/base";
import type { Bookmark } from "../lib/api";
import { bookmark as current, updateBookmark } from "../lib/store";
import { normalizeTag, TagField } from "./TagField";
import { ActionButton, ErrorText, FieldLabel, fieldClass } from "./ui";

/**
 * A bookmark's title, tags and note. A dialog on desktops, a page on phones.
 * Saving changes only what changed.
 */
export function EditBookmark(props: { b: Bookmark; onDone: () => void; onCancel?: () => void }) {
  const b = () => current(props.b.id) ?? props.b;
  const title = signal(b().title);
  const tags = signal([...b().tags]);
  /** A tag typed but not yet added: saving adds it. */
  const tagQuery = signal("");
  const note = signal(b().note ?? "");
  const error = signal("");
  const busy = signal(false);

  const save = async () => {
    if (busy()) return;
    const patch: Parameters<typeof updateBookmark>[1] = {};
    const t = title().trim();
    if (t && t !== b().title) patch.title = t;
    const typed = normalizeTag(tagQuery());
    const tg = typed && !tags().includes(typed) ? [...tags(), typed] : tags();
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

  const label = (text: string) => <FieldLabel text={text} />;

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
          class={fieldClass}
          style={{ height: 40, fontSize: 15 }}
        />
      </View>
      <View class="gap-1.5">
        {label("Tags")}
        <TagField testID="edit-tags" value={tags} query={tagQuery} onSubmit={() => void save()} />
      </View>
      <View class="gap-1.5">
        {label("Note")}
        <Input
          testID="edit-note"
          value={note()}
          placeholder="Why you saved it, what to look for…"
          multiline
          onChange={({ value }) => note.set(value)}
          class={`${fieldClass} py-2.5`}
          style={{ height: 132, fontSize: 15 }}
        />
      </View>
      <If when={error()}>
        <ErrorText testID="edit-error" text={error()} />
      </If>
      <View class="flex-row items-center justify-end gap-2">
        <If when={props.onCancel}>
          <ActionButton variant="cancel" label="Cancel" onPress={() => props.onCancel?.()} />
        </If>
        <ActionButton
          testID="edit-save"
          busy={busy()}
          label={busy() ? "Saving…" : "Save"}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
