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
import { IconButton } from "../components/ui";
import { openOriginal, showBookmarkMenu } from "../lib/actions";
import { api, type Bookmark, type Highlight } from "../lib/api";
import { type DocIndex, indexDoc, toDocRange, toTextRange } from "../lib/docIndex";
import { readingTime } from "../lib/format";
import { fonts, look } from "../lib/look";
import { bookmark as current, setHighlightCount, updateBookmark } from "../lib/store";

/**
 * Raw HTML embeds (iframes, scripts) can't be shown by the editor and would
 * appear as literal tags. Anchoring is unaffected: quotes are matched in the
 * editor's own text.
 */
const readable = (markdown: string) =>
  markdown
    .replace(/<(iframe|script|style|video|audio|object|embed)\b[\s\S]*?(<\/\1>|\/>)/gi, "")
    .replace(/^<(iframe|embed)\b[^\n]*$/gim, "");

/** The article starts with its title, unless the extracted text already does. */
const withTitle = (markdown: string, title: string) => {
  const t = title.trim();
  if (!t) return markdown;
  const first =
    markdown
      .trimStart()
      .split("\n", 1)[0]
      ?.replace(/^#+\s*/, "")
      .trim() ?? "";
  if (first && (first === t || t.startsWith(first) || first.startsWith(t))) return markdown;
  return `# ${t.replace(/\n/g, " ")}\n\n${markdown}`;
};

/** The widest the text gets, for a comfortable line length. */
const MEASURE = 680;

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
export function Reader(props: {
  bookmark: Bookmark;
  onBack: () => void;
  /** Desktops: the page draws its own toolbar. */
  wide: boolean;
  /** Leading room for the window's controls when the sidebar is hidden. */
  toolbarInset?: number;
}) {
  /** The bookmark as it is now (favorite and archive change while it's open). */
  const b = () => current(props.bookmark.id) ?? props.bookmark;
  const width = signal(0);
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
    setHighlightCount(
      props.bookmark.id,
      out.map((p) => p.highlight.id),
    );
    decorate();
  };

  (async () => {
    try {
      const [markdown, highlights] = await Promise.all([
        api.markdown(props.bookmark.id),
        api.highlights(props.bookmark.id),
      ]);
      if (!markdown) {
        const b = props.bookmark;
        status.set(
          b.contentStatus === "pending"
            ? "lofu is still fetching this page."
            : b.contentStatus === "failed"
              ? `lofu couldn't read this page${b.contentError ? `: ${b.contentError}` : "."}`
              : "This page has no saved text.",
        );
        return;
      }
      const ed = createRichEditor({
        content: withTitle(readable(markdown), props.bookmark.title),
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

  const meta = () =>
    [props.bookmark.domain.replace(/^www\./, ""), readingTime(props.bookmark.wordCount)]
      .filter(Boolean)
      .join(" · ");
  const highlights = () =>
    (placed().length ? `${placed().length} highlight${placed().length === 1 ? "" : "s"}` : "") +
    (orphans() ? ` · ${orphans()} not found` : "");
  const sidePad = () => Math.max(props.wide ? 40 : 20, Math.round((width() - MEASURE) / 2));

  return (
    <View
      class="flex-1"
      style={{ backgroundColor: look().paper }}
      onLayout={(e) => width.set(e.bounds.size.width)}
    >
      <If when={props.wide}>
        <View
          desktop={{ windowDrag: true }}
          class="flex-row items-center gap-1 pr-3"
          style={{
            height: 52,
            paddingLeft: (props.toolbarInset ?? 0) + 14,
            borderBottomWidth: 1,
            borderColor: look().ruleSoft,
          }}
        >
          <IconButton
            name="back"
            label="Back to the library"
            testID="back"
            onPress={props.onBack}
          />
          <Text
            class="flex-1 truncate"
            style={{ color: look().inkFaint, fontSize: 12.5, marginLeft: 6 }}
          >
            {meta()}
          </Text>
          <Text
            testID="highlight-count"
            style={{ color: look().stamp, fontSize: 12, marginRight: 8 }}
          >
            {highlights()}
          </Text>
          <IconButton
            name={b().favorite ? "starFill" : "star"}
            label={b().favorite ? "Remove from favorites" : "Add to favorites"}
            color={b().favorite ? look().favorite : undefined}
            onPress={() => void updateBookmark(b().id, { favorite: !b().favorite }).catch(() => {})}
          />
          <IconButton
            name="archive"
            label={b().archived ? "Move out of archive" : "Archive"}
            active={b().archived}
            onPress={() => void updateBookmark(b().id, { archived: !b().archived }).catch(() => {})}
          />
          <IconButton name="external" label="Open original" onPress={() => openOriginal(b())} />
          <IconButton
            name="more"
            label="More"
            onPress={() => void showBookmarkMenu(b(), undefined)}
          />
        </View>
      </If>
      <If when={!props.wide && (placed().length || orphans())}>
        <Text
          testID="highlight-count"
          class="px-5 pt-2"
          style={{ color: look().stamp, fontSize: 12 }}
        >
          {highlights()}
        </Text>
      </If>
      <If
        when={editor()}
        else={
          <View class="items-center gap-2 px-8 pt-24">
            <Text
              class="text-center"
              style={{ color: look().inkSoft, fontSize: 15, lineHeight: 21 }}
            >
              {status()}
            </Text>
            <If when={props.bookmark.contentStatus !== "ok"}>
              <View
                role="button"
                onPress={() => openOriginal(b())}
                class="mt-2 rounded-lg px-4 py-2 active:opacity-70"
                style={{ backgroundColor: look().ink }}
              >
                <Text style={{ color: look().paper, fontSize: 14, fontWeight: "600" }}>
                  Open original
                </Text>
              </View>
            </If>
          </View>
        }
      >
        {(ed) => (
          <RichEditor
            editor={ed()}
            ref={(r) => {
              view = r;
            }}
            editable={false}
            testID="article"
            accessibilityLabel="Article"
            class="flex-1"
            onSelectionChange={({ selection: s }) => selection.set(s)}
            bubbleMenu={bubble()}
            classes={{
              content: `px-[${sidePad()}px] pt-8 pb-32`,
              nodes: {
                paragraph: "text-[18px] leading-[30px] mb-5",
                heading: "font-semibold mt-8 mb-3",
                "heading[level=1]": "text-[32px] leading-[39px] mt-0 mb-6",
                "heading[level=2]": "text-[24px] leading-[31px]",
                "heading[level=3]": "text-[20px] leading-[27px]",
                blockquote: "pl-4 border-l-2",
                codeBlock: "rounded-md p-3 font-mono text-[13px] leading-[20px]",
              },
              marks: { code: "font-mono text-[15px]" },
            }}
            styles={{
              root: { color: look().ink, fontFamily: fonts.serif },
              selection: { backgroundColor: look().highlight },
            }}
          />
        )}
      </If>
    </View>
  );
}
