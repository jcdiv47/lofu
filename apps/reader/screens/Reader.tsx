import { signal, Text, View } from "nsh";
import {
  createRichEditor,
  RichEditor,
  RichEditorPlugin,
  type RichEditorRef,
  type RichEditorSelection,
  type RichEditorSession,
  starterKit,
} from "nsh/base";
import { findQuote, quoteAt } from "../../../packages/shared/src/anchor";
import { api, type Bookmark, type Highlight } from "../lib/api";
import { type DocIndex, indexDoc, toDocRange, toTextRange } from "../lib/docIndex";
import { look } from "../lib/look";

/**
 * Raw HTML embeds (iframes, scripts) can't be shown by the editor and would
 * appear as literal tags. Anchoring is unaffected: quotes are matched in the
 * editor's own text.
 */
const readable = (markdown: string) =>
  markdown
    .replace(/<(iframe|script|style|video|audio|object|embed)\b[\s\S]*?(<\/\1>|\/>)/gi, "")
    .replace(/^<(iframe|embed)\b[^\n]*$/gim, "");

interface Placed {
  highlight: Highlight;
  from: number;
  to: number;
}

/**
 * The article in a read-only RichEditor (it still selects and copies).
 * Highlights are inline decorations placed by their text quote; selecting
 * text offers "Highlight", and a caret inside a highlight offers "Remove".
 */
export function Reader(props: { bookmark: Bookmark; onBack: () => void }) {
  const editor = signal<RichEditorSession | null>(null);
  const status = signal("Loading…");
  const selection = signal<RichEditorSelection | null>(null);
  const placed = signal<Placed[]>([]);
  const orphans = signal(0);
  const plugin = new RichEditorPlugin("highlights");
  let view: RichEditorRef | null = null;
  let index: DocIndex = { text: "", pos: [] };

  const decorate = () => {
    const ed = editor();
    if (!ed) return;
    ed.setDecorations(
      "highlights",
      placed().map((p) => ({
        from: p.from,
        to: p.to,
        kind: "inline" as const,
        attrs: { class: look().highlightClass },
      })),
    );
  };

  const place = (highlights: Highlight[]) => {
    const out: Placed[] = [];
    let missing = 0;
    for (const h of highlights) {
      const hit = findQuote(index.text, h);
      if (!hit) {
        missing++;
        continue;
      }
      const range = toDocRange(index, hit.start, hit.end);
      // Dev check that the text index and the editor agree on positions.
      const shown = editor()?.textBetween(range.from, range.to, " ");
      if (
        shown !== undefined &&
        shown.replace(/\s+/g, " ").trim() !== h.quote.replace(/\s+/g, " ").trim()
      ) {
        console.warn(
          `highlight misplaced: wanted "${h.quote}", got "${shown}" at ${range.from}..${range.to}`,
        );
      }
      out.push({ highlight: h, ...range });
    }
    placed.set(out);
    orphans.set(missing);
    decorate();
  };

  (async () => {
    try {
      const [markdown, highlights] = await Promise.all([
        api.markdown(props.bookmark.id),
        api.highlights(props.bookmark.id),
      ]);
      if (!markdown) {
        status.set("This page has no saved text yet.");
        return;
      }
      const ed = createRichEditor({
        content: readable(markdown),
        format: "markdown",
        editable: false,
        plugins: [starterKit(), plugin],
      });
      index = indexDoc(ed.getJSON());
      editor.set(ed);
      status.set("");
      place(highlights);
    } catch (e) {
      status.set((e as Error).message);
    }
  })();

  const underCaret = () => {
    const s = selection();
    if (!s?.empty) return null;
    // Strictly inside: right after highlighting, the caret sits on its edge.
    return placed().find((p) => s.from > p.from && s.from < p.to) ?? null;
  };

  const addHighlight = async () => {
    const s = selection();
    if (!s || s.empty) return;
    const { start, end } = toTextRange(index, s.from, s.to);
    const quote = quoteAt(index.text, start, end);
    if (!quote.quote) return;
    view?.setSelection(s.to, s.to); // collapse it: the bubble menu closes
    try {
      const h = await api.addHighlight(props.bookmark.id, quote);
      place([...placed().map((p) => p.highlight), h]);
    } catch (e) {
      status.set((e as Error).message);
    }
  };

  const removeHighlight = async (p: Placed) => {
    try {
      await api.removeHighlight(p.highlight.id);
      place(
        placed()
          .filter((x) => x !== p)
          .map((x) => x.highlight),
      );
    } catch (e) {
      status.set((e as Error).message);
    }
  };

  const menuButton = (label: string, onPress: () => void) => (
    <View onPress={onPress} role="button" class="px-3 py-2 active:opacity-60">
      <Text style={{ color: look().paper, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </View>
  );

  const bubble = () => {
    const s = selection();
    if (s && !s.empty) {
      return (
        <View class="flex-row rounded-lg" style={{ backgroundColor: look().ink }}>
          {menuButton("Highlight", addHighlight)}
        </View>
      );
    }
    const hit = underCaret();
    if (hit) {
      return (
        <View class="flex-row rounded-lg" style={{ backgroundColor: look().ink }}>
          {menuButton("Remove highlight", () => removeHighlight(hit))}
        </View>
      );
    }
    return undefined;
  };

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <View
        class="flex-row items-center gap-3 px-4 py-3"
        style={{ borderBottomWidth: 1, borderColor: look().rule }}
      >
        <View onPress={props.onBack} role="button" class="py-1 pr-2 active:opacity-60">
          <Text style={{ color: look().inkSoft, fontSize: 15 }}>‹ Library</Text>
        </View>
        <Text
          class="flex-1 truncate"
          style={{ color: look().inkFaint, fontSize: 12, fontFamily: "monospace" }}
        >
          {props.bookmark.domain}
        </Text>
        <Text
          testID="highlight-count"
          style={{ color: look().stamp, fontSize: 12, fontFamily: "monospace" }}
        >
          {placed().length ? `${placed().length} highlight${placed().length === 1 ? "" : "s"}` : ""}
          {orphans() ? ` · ${orphans()} not found` : ""}
        </Text>
      </View>
      <If
        when={editor()}
        else={
          <Text class="p-6" style={{ color: look().inkSoft }}>
            {status()}
          </Text>
        }
      >
        {(ed) => (
          <RichEditor
            editor={ed()}
            ref={(r) => {
              view = r;
            }}
            editable={false}
            class="flex-1"
            onSelectionChange={({ selection: s }) => selection.set(s)}
            bubbleMenu={bubble()}
            classes={{
              content: "px-6 pt-6 pb-24",
              nodes: {
                paragraph: "text-[18px] leading-[30px] mb-4",
                heading: "font-semibold mt-6 mb-3",
                "heading[level=1]": "text-[30px] leading-[36px]",
                "heading[level=2]": "text-[24px] leading-[30px]",
                "heading[level=3]": "text-[20px] leading-[26px]",
                blockquote: "pl-4 border-l-2",
                codeBlock: "rounded-md p-3 font-mono text-[13px] leading-[20px]",
              },
              marks: { code: "font-mono text-[15px]" },
            }}
            styles={{
              root: { color: look().ink, fontFamily: "serif" },
              selection: { backgroundColor: look().highlight },
            }}
          />
        )}
      </If>
    </View>
  );
}
