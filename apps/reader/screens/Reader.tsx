import { effect, signal, Text, untracked, View } from "nsh";
import {
  createRichEditor,
  RichEditor,
  RichEditorPlugin,
  type RichEditorRef,
  type RichEditorSelection,
  type RichEditorSession,
  type RichNodeJSON,
  StarterKit,
  TableKit,
} from "nsh/base";
import { findQuote, quoteAt } from "../../../packages/shared/src/anchor";
import { BookmarkDropdown } from "../components/BookmarkMenu";
import { IconButton } from "../components/ui";
import { nativeMenus, openOriginal, showBookmarkMenu } from "../lib/actions";
import { type ArticleImage, api, type Bookmark, type Highlight } from "../lib/api";
import { type DocIndex, indexDoc, toDocRange, toTextRange } from "../lib/docIndex";
import { isFootnoteNumber, numberFootnotes, raiseFootnotes } from "../lib/footnotes";
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

/**
 * Gives each image its size and the server's proxy as its source. The editor
 * lays an image out only at an explicit width and height (a Markdown image,
 * which has neither, is drawn at 0×0), and doesn't keep it within the text,
 * so images get their measured size, scaled down to `textWidth`. Hotlink
 * protection (WeChat, CSDN) refuses the original URL from another site's
 * page, hence the proxy. Images are matched by URL, or by position when the
 * parser changed a URL and the counts agree. Returns a new document.
 */
export function placeImages(
  doc: RichNodeJSON,
  images: ArticleImage[],
  textWidth: number,
): RichNodeJSON {
  const out = JSON.parse(JSON.stringify(doc)) as RichNodeJSON;
  const bySrc = new Map(images.map((i) => [i.src, i]));
  const nodes: RichNodeJSON[] = [];
  const walk = (n: RichNodeJSON) => {
    if (n.type === "image") nodes.push(n);
    n.content?.forEach(walk);
  };
  walk(out);
  nodes.forEach((n, k) => {
    const src = String(n.attrs?.src ?? "");
    const img = bySrc.get(src) ?? (nodes.length === images.length ? images[k] : undefined);
    if (!img) return;
    n.attrs = { ...n.attrs, src: img.proxy ?? src };
    if (img.width && img.height) {
      const width = Math.max(1, Math.min(img.width, Math.floor(textWidth)));
      n.attrs.width = width;
      n.attrs.height = Math.max(1, Math.round((img.height * width) / img.width));
    }
  });
  return out;
}

/**
 * Marks the paragraphs in table cells (`textAlign: "left"`, which is how they
 * look anyway) so they can be styled apart from the article's: the editor's
 * classes select a node by type and attributes, not by where it is.
 */
export function compactCells(doc: RichNodeJSON): RichNodeJSON {
  const walk = (n: RichNodeJSON, inCell: boolean): RichNodeJSON => {
    const cell = inCell || n.type === "tableCell" || n.type === "tableHeader";
    const out = n.content ? { ...n, content: n.content.map((c) => walk(c, cell)) } : n;
    return inCell && n.type === "paragraph" && !n.attrs?.textAlign
      ? { ...out, attrs: { ...n.attrs, textAlign: "left" } }
      : out;
  };
  return walk(doc, false);
}

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
  let hasFootnotes = false;
  /** The document as parsed and the text width its images are sized for. */
  let sized: { doc: RichNodeJSON; images: ArticleImage[]; width: number } | null = null;
  const sidePad = () => Math.max(props.wide ? 40 : 20, Math.round((width() - MEASURE) / 2));
  /** The text's width (before the first layout, the widest it gets). */
  const textWidth = () => (width() > 0 ? Math.min(MEASURE, width() - 2 * sidePad()) : MEASURE);

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
      // (Skipped with footnotes: their numbers are shown but not quoted.)
      const shown = hasFootnotes ? undefined : editor()?.textBetween(range.from, range.to, " ");
      const norm = (t: string) => t.replace(/\s+/g, " ").trim();
      if (shown !== undefined && norm(shown) !== norm(h.quote)) {
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
      const [{ markdown, images }, highlights] = await Promise.all([
        api.article(props.bookmark.id),
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
      const content = numberFootnotes(withTitle(readable(markdown), props.bookmark.title));
      const ed = createRichEditor({
        content,
        format: "markdown",
        editable: false,
        extensions: [StarterKit, TableKit.configure({ table: { resizable: false } })],
        plugins: [plugin],
      });
      hasFootnotes = content.includes("\uE000");
      if (images.length > 0 || hasFootnotes || content.includes("|")) {
        const doc = compactCells(raiseFootnotes(ed.getJSON()));
        if (images.length > 0) {
          sized = { doc, images, width: textWidth() };
          ed.setContent(placeImages(doc, images, sized.width), "json");
        } else {
          ed.setContent(doc, "json");
        }
      }
      index = indexDoc(ed.getJSON(), isFootnoteNumber);
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

  // A narrower window or a rotated phone resizes the images (the text keeps its
  // positions, so highlights only need drawing again). Settles first: a window
  // being dragged narrower changes width on every frame.
  effect(() => {
    const w = textWidth();
    const t = setTimeout(() => {
      const ed = untracked(editor);
      if (!ed || !sized || sized.width === w) return;
      sized.width = w;
      ed.setContent(placeImages(sized.doc, sized.images, w), "json");
      decorate();
    }, 150);
    return () => clearTimeout(t);
  });

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
          <If
            when={nativeMenus}
            else={<BookmarkDropdown b={b()} trigger={<IconButton name="more" label="More" />} />}
          >
            <IconButton
              name="more"
              label="More"
              onPress={() => void showBookmarkMenu(b(), undefined)}
            />
          </If>
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
                table: "my-6",
                tableCell: `px-3 py-2 border-b border-[${look().rule}]`,
                tableHeader: `px-3 py-2 border-b-2 border-[${look().rule}] font-semibold`,
                horizontalRule: `my-8 border-t border-[${look().rule}]`,
                // Paragraphs in cells (compactCells).
                "paragraph[textAlign=left]": "text-[15px] leading-[22px] mb-0",
              },
              marks: {
                code: "font-mono text-[15px]",
                bold: "font-bold",
                // Footnote numbers: the editor can't raise text, so small and in the accent.
                superscript: `text-[12px] font-semibold text-[${look().stamp}]`,
              },
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
