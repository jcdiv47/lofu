import { Keyboard } from "lofu/native";
import {
  cleanup,
  createAnimatedValue,
  effect,
  platform,
  reduceMotion,
  safeArea,
  signal,
  Text,
  untracked,
  View,
  type ViewRef,
} from "nsh";
import {
  AlertDialog,
  chain,
  createRichEditor,
  insertContentAt,
  link,
  RichEditor,
  RichEditorPlugin,
  type RichEditorRef,
  type RichEditorSelection,
  type RichEditorSession,
  type RichNodeJSON,
  StarterKit,
  scrollIntoView,
  setTextSelection,
  TableKit,
} from "nsh/base";
import { findQuote, quoteAt } from "../../../packages/shared/src/anchor";
import { BookmarkDropdown } from "../components/BookmarkMenu";
import {
  nativeControls,
  nativeScrollEdges,
  ScrollEdge,
  SystemGlassButton,
} from "../components/native";
import {
  GlassButton,
  GlassGroup,
  GlassTint,
  IconButton,
  RoundGlassButton,
  TopEdge,
} from "../components/ui";
import {
  type BookmarkMenuOptions,
  canShare,
  deleteBookmark,
  editBookmark,
  hasBrowser,
  nativeMenus,
  notice,
  openOriginal,
  shareBookmark,
  showBookmarkMenu,
  toolbarActions,
} from "../lib/actions";
import { type ArticleImage, api, type Bookmark, type Highlight, OfflineError } from "../lib/api";
import {
  fetchArticle,
  type Kept,
  keepArticle,
  keepPictures,
  keptArticle,
  withKeptPictures,
} from "../lib/articles";
import {
  type DocIndex,
  indexDoc,
  nodeSize,
  toDocRange,
  toTextRange,
  withoutRange,
} from "../lib/docIndex";
import { isFootnoteNumber, numberFootnotes, raiseFootnotes } from "../lib/footnotes";
import { readingTime } from "../lib/format";
import { fonts, glass, look } from "../lib/look";
import {
  bookmark as current,
  removeHighlight as dropHighlight,
  inTrash,
  pendingHighlights,
  addHighlight as saveHighlight,
  setHighlightCount,
  setReadProgress,
  sync,
  updateBookmark,
} from "../lib/store";
import { contentLeft, nativeToolbar, useToolbar } from "../lib/toolbar";

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

/** A long document's first page, in nodes (each a native view): a few screens. */
const FIRST_PAGE = 300;
/** The pages after it, in nodes. */
const PAGE = 150;
/** A page is added when the text shown ends less than this many screens below the view. */
const AHEAD_SCREENS = 2;
/** How often a page is added when where the reader is can't be told. */
const SLOW_PAGE_MS = 1500;
/** Characters of text shown after the place an article reopens at, before it's revealed. */
const RESTORE_AHEAD = 3000;

const nodeCount = (n: RichNodeJSON): number =>
  1 + (n.content ?? []).reduce((sum, c) => sum + nodeCount(c), 0);
/** The size of blocks in document positions. */
const sizeOf = (blocks: RichNodeJSON[]) => blocks.reduce((sum, b) => sum + nodeSize(b), 0);

/**
 * Top-level blocks in pages of about `first` nodes, then `size` (a block is
 * never split; each page has one at least). The first page also reaches
 * `through`, a document position. One page when it all fits.
 */
export function paginate(
  blocks: RichNodeJSON[],
  first: number,
  size: number,
  through = 0,
): RichNodeJSON[][] {
  const pages: RichNodeJSON[][] = [];
  let page: RichNodeJSON[] = [];
  let nodes = 0;
  let pos = 0;
  for (const b of blocks) {
    const n = nodeCount(b);
    const full = pages.length ? nodes + n > size : nodes + n > first && pos >= through;
    pos += nodeSize(b);
    if (page.length && full) {
      pages.push(page);
      page = [];
      nodes = 0;
    }
    page.push(b);
    nodes += n;
  }
  if (page.length || !pages.length) pages.push(page);
  return pages;
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

/**
 * The bookmark's note as a block under the article's title: a blockquote of
 * paragraphs marked `textAlign: "justify"` (styled apart, as table cells
 * are). Returns the document and the note's range, which the text index
 * leaves out.
 */
export function withNote(
  doc: RichNodeJSON,
  note: string | null,
): { doc: RichNodeJSON; note: { from: number; to: number } | null } {
  const text = note?.trim();
  if (!text) return { doc, note: null };
  const content = doc.content ?? [];
  const first = content[0];
  const at = first?.type === "heading" ? 1 : 0;
  const paragraphs = text.split(/\n\s*\n/).map((para) => ({
    type: "paragraph",
    attrs: { textAlign: "justify" },
    content: para
      .split("\n")
      .flatMap((line, k) => [
        ...(k ? [{ type: "hardBreak" }] : []),
        ...(line ? [{ type: "text", text: line }] : []),
      ]),
  }));
  const block: RichNodeJSON = { type: "blockquote", content: paragraphs as RichNodeJSON[] };
  const from = content.slice(0, at).reduce((n, c) => n + nodeSize(c), 0);
  return {
    doc: { ...doc, content: [...content.slice(0, at), block, ...content.slice(at)] },
    note: { from, to: from + nodeSize(block) },
  };
}

/** The widest the text gets, for a comfortable line length. */
const MEASURE = 680;
/** The desktop's toolbar, floating over the article. */
const TOOLBAR = 52;
/** The window toolbar's Back (macOS), before the page's meta. */
const BACK_ROOM = 48;
/** The window toolbar's actions at the trailing end (macOS). */
const ACTIONS_ROOM = 300;

interface Placed {
  highlight: Highlight;
  from: number;
  to: number;
}

/** The article editor's label, which `Keyboard.keepAway` finds it by. */
const ARTICLE = "Article";

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
  /** The bookmark as it is now (favorite and Trash change while it's open). */
  const b = () => current(props.bookmark.id) ?? props.bookmark;
  const width = signal(0);
  const editor = signal<RichEditorSession | null>(null);
  const status = signal("Loading…");
  /** Why there's no text to show. */
  const noText = (bm: Bookmark) =>
    bm.contentStatus === "pending"
      ? "lofu is still fetching this page."
      : bm.contentStatus === "failed"
        ? `lofu couldn't read this page${bm.contentError ? `: ${bm.contentError}` : "."}`
        : "This page has no saved text.";
  const retrying = signal(false);
  /** Asks the server to read the page again, and shows it once it has. */
  const retry = async () => {
    retrying.set(true);
    status.set("Reading the page again…");
    try {
      await api.refetch(props.bookmark.id);
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await sync();
        if (b().contentStatus !== "pending") break;
      }
      if (b().contentStatus === "ok") await load();
      else status.set(noText(b()));
    } catch (e) {
      status.set((e as Error).message);
    } finally {
      retrying.set(false);
    }
  };
  const selection = signal<RichEditorSelection | null>(null);
  const placed = signal<Placed[]>([]);
  /** Highlights whose text isn't in the article as saved now. */
  const orphans = signal<Highlight[]>([]);
  /** Every highlight of the bookmark, placed or not. */
  const all = () => [...placed().map((p) => p.highlight), ...orphans()];
  const plugin = new RichEditorPlugin("highlights");
  let view: RichEditorRef | null = null;
  let index: DocIndex = { text: "", pos: [] };
  let hasFootnotes = false;
  /** The document as parsed and the text width its images are sized for. */
  let sized: { doc: RichNodeJSON; images: ArticleImage[]; width: number } | null = null;
  /** Room above the article: the desktop's floating toolbar, or iOS's
   * transparent header (the editor doesn't inset itself under it). */
  const topPad = () =>
    props.wide ? TOOLBAR + 36 : platform.os === "ios" ? safeArea().top + 54 + 20 : 24;
  const sidePad = () => Math.max(props.wide ? 40 : 20, Math.round((width() - MEASURE) / 2));
  /** The text's width (before the first layout, the widest it gets). */
  const textWidth = () => (width() > 0 ? Math.min(MEASURE, width() - 2 * sidePad()) : MEASURE);

  const decorate = () => {
    const ed = editor();
    if (!ed) return;
    ed.setDecorations(
      "highlights",
      placed()
        .filter((p) => isShown(p.to))
        .map((p) => ({
          from: p.from,
          to: p.to,
          kind: "inline" as const,
          attrs: { class: look().highlightClass },
        })),
    );
  };

  const place = (highlights: Highlight[]) => {
    const out: Placed[] = [];
    const missing: Highlight[] = [];
    for (const h of highlights) {
      const hit = findQuote(index.text, h);
      if (!hit) {
        missing.push(h);
        continue;
      }
      const range = toDocRange(index, hit.start, hit.end);
      // Dev check that the text index and the editor agree on positions.
      // (Skipped with footnotes: their numbers are shown but not quoted.)
      // (And for text not shown yet: a long article comes a page at a time.)
      const drawn =
        hasFootnotes || !isShown(range.to)
          ? undefined
          : editor()?.textBetween(range.from, range.to, " ");
      const norm = (t: string) => t.replace(/\s+/g, " ").trim();
      if (drawn !== undefined && norm(drawn) !== norm(h.quote)) {
        console.warn(
          `highlight misplaced: wanted "${h.quote}", got "${drawn}" at ${range.from}..${range.to}`,
        );
      }
      out.push({ highlight: h, ...range });
    }
    placed.set(out);
    orphans.set(missing);
    // All of them: one the text has lost is still the bookmark's.
    setHighlightCount(
      props.bookmark.id,
      highlights.map((h) => h.id),
    );
    decorate();
  };

  // ---- Pages ------------------------------------------------------------
  // nsh's editor makes a native view of every node of its document at once,
  // and lays them all out again on every change, so a long article (a README
  // of 6,600 nodes and 471 pictures) held the window still for seconds before
  // its first line showed. A long document is shown a page at a time
  // instead: the first at once, the next added at the end as the reader nears
  // it (the editor reports no scrolling: where the shown text ends on the
  // page is asked a few times a second). Until the pointer or a finger has
  // been over the text that can't be told, and pages are added slowly.
  // Adding at the end moves nothing before it, so the text index and the
  // highlights are those of the whole document throughout.

  /** Where the text shown ends (a document position); infinite once it all is. */
  let shownTo = Number.POSITIVE_INFINITY;
  /** The pages still to add, to which editor, and the position to add them up to whatever the view. */
  let pending: { ed: RichEditorSession; pages: RichNodeJSON[][]; wanted: number } | null = null;
  let pageTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPage = 0;
  cleanup(() => {
    pending = null;
    if (pageTimer != null) clearTimeout(pageTimer);
  });
  /** Whether the text up to `pos` is shown yet. */
  const isShown = (pos: number) => pos <= shownTo;

  const addPage = () => {
    const page = pending?.pages.shift();
    if (!pending || !page) return;
    // At the end of the text shown: before the empty paragraph the editor
    // may keep after a list (StarterKit's trailing node).
    pending.ed.run(insertContentAt(shownTo, page, { updateSelection: false }));
    shownTo += sizeOf(page);
    lastPage = Date.now();
    if (!pending.pages.length) {
      pending = null;
      shownTo = Number.POSITIVE_INFINITY;
    }
    decorate();
  };

  /** Whether the end of the text shown is within a few screens of the view's bottom (null: can't tell). */
  const nearEnd = async (ed: RichEditorSession): Promise<boolean | null> => {
    const m = await host?.measure().catch(() => null);
    let end: { y: number } | null = null;
    try {
      end = ed.pageCoordsAtPos(shownTo - 1) as { y: number } | null;
    } catch {}
    if (!m || !end) return null;
    const height = m.bounds.size.height;
    return end.y < m.pagePosition.y + height * (1 + AHEAD_SCREENS);
  };

  /** Adds pages as the reader nears the end, until there are none. */
  const fill = async () => {
    pageTimer = null;
    const p = pending;
    if (!p) return;
    const want =
      p.wanted > shownTo || ((await nearEnd(p.ed)) ?? Date.now() - lastPage > SLOW_PAGE_MS);
    if (p !== pending) return;
    if (want) addPage();
    // Right after a page, look again once it's drawn.
    if (pending) pageTimer = setTimeout(() => void fill(), want ? 16 : 200);
  };

  /**
   * Puts `doc` in the editor: whole when it is short, else its first page,
   * the rest as the reader nears it. The first page reaches `through` (a
   * position), so text already shown stays. `changed`: whether `doc` differs
   * from what the editor holds.
   */
  const present = (ed: RichEditorSession, doc: RichNodeJSON, changed: boolean, through = 0) => {
    if (pageTimer != null) clearTimeout(pageTimer);
    pending = null;
    const [first = [], ...rest] = paginate(doc.content ?? [], FIRST_PAGE, PAGE, through);
    if (!rest.length) {
      shownTo = Number.POSITIVE_INFINITY;
      if (changed) ed.setContent(doc, "json");
      return;
    }
    ed.setContent({ ...doc, content: first }, "json");
    shownTo = sizeOf(first);
    pending = { ed, pages: rest, wanted: 0 };
    lastPage = Date.now();
    pageTimer = setTimeout(() => void fill(), 200);
  };

  /** Shows the text up to `pos`, a page a frame, whatever the view. */
  const showThrough = (pos: number) => {
    if (!pending || isShown(pos)) return;
    pending.wanted = Math.max(pending.wanted, pos);
    if (pageTimer != null) clearTimeout(pageTimer);
    pageTimer = setTimeout(() => void fill(), 0);
  };

  /** The article as shown: compared with the server's when that comes. */
  let shown: string | null = null;
  /** What `show` last laid out, and the note it put above the text. */
  let last: Kept | null = null;
  let shownNote: string | null = null;

  /** Shows an article (laid out from its Markdown), its highlights placed. */
  const show = (a: Kept) => {
    const markdown = a.markdown ?? "";
    const content = numberFootnotes(withTitle(readable(markdown), props.bookmark.title));
    const ed = createRichEditor({
      content,
      format: "markdown",
      editable: false,
      extensions: [StarterKit, TableKit.configure({ table: { resizable: false } })],
      // StarterKit's link is the mark alone: opening a pressed link (the
      // editor being read-only, any press) is this plugin's. It opens in
      // the system's browser.
      plugins: [plugin, link({ openOnClick: true, autolink: false, linkOnPaste: false })],
    });
    hasFootnotes = content.includes("\uE000");
    last = a;
    shownNote = b().note;
    const parsed = ed.getJSON();
    const noted = withNote(parsed, shownNote);
    let doc = parsed;
    if (a.images.length > 0 || hasFootnotes || content.includes("|") || noted.note) {
      doc = compactCells(raiseFootnotes(noted.doc));
      if (a.images.length > 0) {
        sized = { doc, images: a.images, width: textWidth() };
        doc = placeImages(doc, a.images, sized.width);
      }
    }
    // The whole text, though a long article is shown a page at a time.
    index = indexDoc(doc, isFootnoteNumber);
    if (noted.note) index = withoutRange(index, noted.note.from, noted.note.to);
    present(ed, doc, doc !== parsed);
    shown = markdown;
    hideForRestore();
    editor.set(ed);
    status.set("");
    place(pendingHighlights(props.bookmark.id, a.highlights));
    restoreProgress();
  };

  /** The device's copy at once, then the server's (offline, the copy stays). */
  const load = async () => {
    const id = props.bookmark.id;
    const kept = await keptArticle(id);
    if (kept?.markdown) show(await withKeptPictures(id, kept));
    try {
      const fresh = await fetchArticle(props.bookmark.id);
      if (!fresh.markdown) {
        if (!kept?.markdown) status.set(noText(b()));
        return;
      }
      if (fresh.markdown === shown) place(pendingHighlights(id, fresh.highlights));
      else show(await withKeptPictures(id, fresh));
      // Its pictures too, for reading it offline (and from the disk next time).
      void keepPictures(id, fresh);
    } catch (e) {
      if (kept?.markdown) return;
      status.set(
        e instanceof OfflineError
          ? "You're offline, and this article isn't on this device yet."
          : (e as Error).message,
      );
    }
  };
  void load();

  // The note was edited: lay the article out again with it.
  effect(() => {
    const note = b().note;
    if (note === shownNote || !last) return;
    // With the highlights as they are now, not as the article came.
    untracked(() => last && show({ ...last, highlights: all() }));
  });

  /** Keeps the device's copy in step with the highlights shown. */
  const keepHighlights = () => {
    if (shown === null) return;
    void keptArticle(props.bookmark.id).then((k) => {
      if (k) void keepArticle(props.bookmark.id, { ...k, highlights: all() });
    });
  };

  // ---- Reading progress -------------------------------------------------
  // The editor reports no scrolling, so every few seconds the reader asks
  // which text is at the top of the view (once the pointer or a finger has
  // been over the text, which is when the editor knows where it is on the
  // page). Progress is that place's share of the text; reaching the end is 1.
  let host: ViewRef | null = null;
  let restoring = false;
  /** Where the view starts under the bars over it. */
  const chromeTop = () =>
    props.wide ? TOOLBAR + 8 : platform.os === "ios" ? safeArea().top + 54 : 0;

  const textOffset = (pos: number) => toTextRange(index, pos, pos).start;

  const measureProgress = async (): Promise<number | null> => {
    const ed = untracked(editor);
    const m = await host?.measure();
    if (!ed || !m || !index.text.length) return null;
    const x = m.pagePosition.x + sidePad() + 4;
    const viewBottom = m.pagePosition.y + m.bounds.size.height - 24;
    const top = ed.posAtPageCoords({ x, y: m.pagePosition.y + chromeTop() + 16 });
    if (top == null) return null;
    // The end is on screen: read. (The point at the view's bottom lies in
    // the padding under the text there, so it can't tell; an article not
    // much longer than the screen never got past its first percent.)
    const last = index.pos[index.pos.length - 1];
    const end =
      last == null || !isShown(last)
        ? null
        : (ed.pageCoordsAtPos(last) as { y: number; height: number } | null);
    if (end && end.y + end.height <= viewBottom) return 1;
    const bottom = ed.posAtPageCoords({ x, y: viewBottom });
    const len = index.text.length;
    if (bottom != null && textOffset(bottom) >= len - 1) return 1;
    return Math.min(1, textOffset(top) / len);
  };

  const saveProgress = async () => {
    if (restoring) return;
    const p = await measureProgress().catch(() => null);
    if (p != null) setReadProgress(props.bookmark.id, Math.round(p * 1000) / 1000);
  };
  const progressTimer = setInterval(() => void saveProgress(), 4000);
  cleanup(() => {
    clearInterval(progressTimer);
    void saveProgress();
  });

  /** Back where the reader left off, without showing the way there: the
   * article stays hidden until it is at the place, then fades in (at once
   * when the system asks for less motion). The place lands just under the
   * bars. `scrollIntoView` moves the least, so the caret goes where the
   * view's bottom edge should be, and the view follows it there. */
  let restored = false;
  let restoreFrame: number | null = null;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  const fade = createAnimatedValue(1);
  cleanup(() => {
    if (restoreFrame != null) cancelAnimationFrame(restoreFrame);
    if (revealTimer != null) clearTimeout(revealTimer);
  });
  const willRestore = () => {
    const p = b().readProgress;
    return !restored && p > 0.02 && p < 0.98 && index.text.length > 0;
  };
  /** Hides the article for `restoreProgress` (before it is first shown). */
  const hideForRestore = () => {
    if (willRestore()) fade.set(0);
  };
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (restoreFrame != null) cancelAnimationFrame(restoreFrame);
    if (revealTimer != null) clearTimeout(revealTimer);
    restoreFrame = null;
    revealTimer = null;
    if (untracked(reduceMotion)) fade.set(1);
    else void fade.timing(1, { duration: 150, easing: "easeOut" });
    setTimeout(() => {
      restoring = false;
      selection.set(null);
    }, 100);
  };
  /** After `frames` frames (the editor scrolls once it has laid out). */
  const afterFrames = (frames: number, then: () => void) => {
    restoreFrame = requestAnimationFrame(() =>
      frames <= 1 ? then() : afterFrames(frames - 1, then),
    );
  };
  const restoreProgress = () => {
    if (!willRestore()) return;
    const p = b().readProgress;
    restored = true;
    restoring = true;
    // Shown whatever happens: never a blank page for long. (A long article
    // is shown a page at a time: the place, and a few screens after it,
    // come first.)
    revealTimer = setTimeout(reveal, 1000);
    const end = index.pos[index.pos.length - 1];
    const k = Math.min(index.pos.length - 1, Math.floor(p * index.text.length));
    const at = index.pos[k];
    const after = index.pos[Math.min(index.pos.length - 1, k + RESTORE_AHEAD)];
    if (after != null && !isShown(after)) {
      if (revealTimer != null) clearTimeout(revealTimer);
      revealTimer = setTimeout(reveal, 5000);
      showThrough(after);
    }
    let waited = false;
    /** Each frame until the editor has laid the text out, then to the place. */
    const attempt = async () => {
      restoreFrame = null;
      const ed = untracked(editor);
      if (!ed || end == null || at == null) return reveal();
      if (after != null && !isShown(after)) {
        waited = true;
        restoreFrame = requestAnimationFrame(() => void attempt());
        return;
      }
      if (waited) {
        // Its pages are in: from here, as long as a short article gets.
        waited = false;
        if (revealTimer != null) clearTimeout(revealTimer);
        revealTimer = setTimeout(reveal, 1000);
      }
      const box = (pos: number) => ed.coordsAtPos(pos) as { y: number; height: number } | null;
      const place = box(at);
      // The text's end, once it's all shown (until then more comes after).
      const last = isShown(end) ? box(end) : null;
      const m = await host?.measure().catch(() => null);
      const height = m?.bounds.size.height ?? 0;
      // Shown already (it took too long): don't move what's being read.
      if (revealed) return;
      if (!place || (isShown(end) && !last) || height <= 0) {
        restoreFrame = requestAnimationFrame(() => void attempt());
        return;
      }
      // Where the view's top goes: no further than the caret can take it,
      // the last line at the view's bottom (not the padding under it).
      const bottom = last ? last.y + last.height : Number.POSITIVE_INFINITY;
      const target = Math.max(0, Math.min(place.y - chromeTop() - 8, bottom - height));
      const pos = ed.posAtCoords({ x: sidePad() + 4, y: target + height - 1 });
      if (target > 0 && pos != null) ed.run(chain([setTextSelection(pos), scrollIntoView()]));
      afterFrames(2, reveal);
    };
    restoreFrame = requestAnimationFrame(() => void attempt());
  };

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
      const h = await saveHighlight(props.bookmark.id, quote);
      place([...all(), h]);
      keepHighlights();
    } catch (e) {
      void notice("Couldn't highlight", (e as Error).message);
    }
  };

  const removeHighlights = async (gone: Highlight[]) => {
    try {
      for (const h of gone) await dropHighlight(h);
      place(all().filter((h) => !gone.includes(h)));
      keepHighlights();
    } catch (e) {
      void notice("Couldn't remove it", (e as Error).message);
    }
  };
  const removeHighlight = (p: Placed) => removeHighlights([p.highlight]);

  /** Highlights the text has lost (the page changed, or the extraction did):
   * shown as quotes, to keep or remove. */
  const showOrphans = async () => {
    const lost = orphans();
    if (!lost.length) return;
    const { action } = await AlertDialog.show({
      title:
        lost.length === 1
          ? "A highlight isn't in this text"
          : `${lost.length} highlights aren't in this text`,
      description: `${lost.map((h) => `“${h.quote.trim()}”`).join("\n\n")}\n\nThe saved page doesn't have these words any more, so they can't be shown in place.`,
      actions: [
        {
          id: "remove",
          label: lost.length === 1 ? "Remove it" : "Remove them",
          role: "destructive",
        },
        { id: "keep", label: "Keep", role: "cancel" },
      ],
    });
    if (action === "remove") await removeHighlights(lost);
  };

  const menuButton = (label: string, onPress: () => void) => (
    <View onPress={onPress} role="button" class="px-3.5 py-2.5 active:opacity-60">
      <Text style={{ color: look().ink, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </View>
  );

  /** iOS only: the Mac keeps its own bubble. */
  const iosGlass = nativeControls && platform.os === "ios";
  const bubble = () => {
    const s = selection();
    // The system's glass button where there is one: it answers the touch.
    if (iosGlass) {
      if (s && !s.empty) return <GlassButton label="Highlight" onPress={addHighlight} />;
      const hit = underCaret();
      if (hit) return <GlassButton label="Remove highlight" onPress={() => removeHighlight(hit)} />;
      return undefined;
    }
    if (s && !s.empty) {
      return (
        <View class="flex-row rounded-full px-1" style={{ ...glass(), borderCurve: "continuous" }}>
          <GlassTint />
          {menuButton("Highlight", addHighlight)}
        </View>
      );
    }
    const hit = underCaret();
    if (hit) {
      return (
        <View class="flex-row rounded-full px-1" style={{ ...glass(), borderCurve: "continuous" }}>
          <GlassTint />
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
    (orphans().length ? ` · ${orphans().length} not found` : "");

  // A narrower window or a rotated phone resizes the images (the text keeps its
  // positions, so highlights only need drawing again). Settles first: a window
  // being dragged narrower changes width on every frame.
  effect(() => {
    const w = textWidth();
    const t = setTimeout(() => {
      const ed = untracked(editor);
      if (!ed || !sized || sized.width === w) return;
      sized.width = w;
      // Pages still to come are added sized anew; what's shown stays shown.
      present(ed, placeImages(sized.doc, sized.images, w), true, shownTo);
      decorate();
    }, 150);
    return () => clearTimeout(t);
  });

  /**
   * The toolbar's •••: the ways to open the page and what the toolbar has
   * no button for. Deleting from it goes back, as the toolbar's trash does.
   */
  const menuOptions = {
    inReader: true,
    omit: toolbarActions,
    onGone: () => props.onBack(),
  } satisfies BookmarkMenuOptions;

  /** The Mac's window toolbar has Back and the bookmark's actions (`lib/toolbar.ts`). */
  const native = props.wide && nativeToolbar;
  if (native) {
    useToolbar(() => {
      const bm = b();
      return [
        // Back starts where the article's column does, beside the sidebar.
        { kind: "space", id: "lead", x: contentLeft() + 16 },
        {
          kind: "button",
          id: "back",
          symbol: "chevron.left",
          label: "Back to the library",
          onPress: () => props.onBack(),
        },
        { kind: "flex" },
        {
          kind: "button",
          id: "favorite",
          symbol: bm.favorite ? "star.fill" : "star",
          label: bm.favorite ? "Remove from favorites" : "Add to favorites",
          tint: bm.favorite ? look().favorite : undefined,
          onPress: () => void updateBookmark(bm.id, { favorite: !bm.favorite }).catch(() => {}),
        },
        ...(canShare
          ? [
              {
                kind: "button" as const,
                id: "share",
                symbol: "square.and.arrow.up",
                label: "Share",
                onPress: (at: { x: number; y: number }) => shareBookmark(b(), at),
              },
            ]
          : []),
        {
          kind: "button",
          id: "delete",
          symbol: "trash",
          label: inTrash(bm) ? "Delete permanently" : "Delete",
          onPress: () =>
            void deleteBookmark(b()).then((gone) => {
              if (gone) props.onBack();
            }),
        },
        {
          kind: "button",
          id: "edit",
          symbol: "pencil",
          label: "Edit title, tags and note",
          onPress: () => editBookmark(b()),
        },
        {
          kind: "button",
          id: "original",
          // The page in the app; the compass is the system's browser (`Browser.tsx`).
          symbol: "globe",
          label: "Open original",
          onPress: () => openOriginal(b()),
        },
        {
          kind: "button",
          id: "more",
          symbol: "ellipsis",
          label: "More",
          onPress: (at) => void showBookmarkMenu(b(), { ...menuOptions, at }),
        },
      ];
    });
  }

  return (
    <View
      class="flex-1"
      ref={(r) => {
        host = r;
      }}
      style={{ backgroundColor: look().paper }}
      onLayout={(e) => width.set(e.bounds.size.width)}
    >
      <If
        when={editor()}
        else={
          <View class="items-center gap-3 px-8 pt-32">
            <Text
              class="text-center"
              style={{ color: look().inkSoft, fontSize: 15, lineHeight: 21 }}
            >
              {status()}
            </Text>
            <If when={b().contentStatus === "failed"}>
              <Text
                class="text-center"
                style={{ color: look().inkFaint, fontSize: 13.5, lineHeight: 19, maxWidth: 420 }}
              >
                Pages behind a login or a bot check save in full from the browser extension: open
                the page there and save it again.
              </Text>
            </If>
            <View class="flex-row items-center gap-2.5 pt-2">
              <If when={b().contentStatus === "failed" && !retrying()}>
                <GlassButton
                  label="Try reading it again"
                  testID="retry"
                  onPress={() => void retry()}
                />
              </If>
              <If when={b().contentStatus !== "ok" || !editor()}>
                <GlassButton
                  label="Open original"
                  prominent
                  testID="open-original"
                  onPress={() => openOriginal(b())}
                />
              </If>
            </View>
          </View>
        }
      >
        {(ed) => (
          <RichEditor
            editor={ed()}
            ref={(r) => {
              view = r;
              // Once its views are up: a press focuses its text view, which
              // would raise iOS's keyboard (Keyboard in src/lib.rs).
              setTimeout(() => Keyboard.keepAway(ARTICLE), 0);
            }}
            editable={false}
            testID="article"
            accessibilityLabel={ARTICLE}
            onFocus={() => Keyboard.keepAway(ARTICLE)}
            class="flex-1"
            style={{ opacity: fade }}
            onSelectionChange={({ selection: s }) => {
              if (!restoring) selection.set(s);
            }}
            bubbleMenu={bubble()}
            classes={{
              content: `px-[${sidePad()}px] pt-[${topPad()}px] pb-32`,
              nodes: {
                paragraph: "text-[18px] leading-[30px] mb-5",
                heading: "font-semibold mt-8 mb-3",
                "heading[level=1]": "text-[32px] leading-[39px] mt-0 mb-6",
                "heading[level=2]": "text-[24px] leading-[31px]",
                "heading[level=3]": "text-[20px] leading-[27px]",
                blockquote: `pl-4 border-l-2 border-[${look().rule}]`,
                codeBlock: "rounded-md p-3 font-mono text-[13px] leading-[20px]",
                table: "my-6",
                tableCell: `px-3 py-2 border-b border-[${look().rule}]`,
                tableHeader: `px-3 py-2 border-b-2 border-[${look().rule}] font-semibold`,
                horizontalRule: `my-8 border-t border-[${look().rule}]`,
                // Paragraphs in cells (compactCells).
                "paragraph[textAlign=left]": "text-[15px] leading-[22px] mb-0",
                // The bookmark's note (withNote).
                "paragraph[textAlign=justify]": `text-[15px] leading-[23px] mb-2 text-[${look().inkSoft}]`,
              },
              marks: {
                code: "font-mono text-[15px]",
                bold: "font-bold",
                link: `text-[${look().stamp}] underline`,
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
      <If when={!props.wide && (placed().length || orphans().length)}>
        {/* Phones: the count on a small capsule of glass over the article's foot. */}
        <View
          class="absolute right-0 left-0 items-center"
          style={{ bottom: Math.max(safeArea().bottom, 12) + 6, pointerEvents: "box-none" }}
        >
          {/* iOS 26: the text fades out under the capsule, as under any bar. */}
          {nativeScrollEdges && <ScrollEdge edge="bottom" />}
          <If
            when={iosGlass}
            else={
              <View
                role={orphans().length ? "button" : undefined}
                onPress={orphans().length ? () => void showOrphans() : undefined}
                class="h-8 justify-center rounded-full px-3.5"
                style={{ ...glass(), borderCurve: "continuous" }}
              >
                <GlassTint />
                <Text testID="highlight-count" style={{ color: look().stamp, fontSize: 13 }}>
                  {highlights()}
                </Text>
              </View>
            }
          >
            <SystemGlassButton
              title={highlights()}
              label={orphans().length ? `${highlights()}: show those not found` : highlights()}
              tint={look().stamp}
              testID="highlight-count"
              onPress={() => {
                if (orphans().length) void showOrphans();
              }}
            />
          </If>
        </View>
      </If>
      <If when={!props.wide && platform.os === "ios"}>
        <TopEdge />
      </If>
      <If when={props.wide}>
        {/* Floats over the article: the text scrolls under the glass and fades
            out beneath it (the scroll edge). */}
        <View
          class="absolute top-0 right-0 left-0"
          style={{ height: TOOLBAR + 30, backgroundImage: look().edgeFade, pointerEvents: "none" }}
        />
        <View
          desktop={{ windowDrag: true }}
          class="absolute top-0 right-0 left-0 flex-row items-center gap-2.5"
          style={{
            // With the window's toolbar, Back and the actions are its items:
            // the row keeps what's said about the page, beside Back and clear
            // of the items at the trailing end.
            height: native ? TOOLBAR : TOOLBAR + 8,
            paddingTop: native ? 0 : 8,
            paddingLeft: (props.toolbarInset ?? 0) + 16 + (native ? BACK_ROOM : 0),
            paddingRight: native ? ACTIONS_ROOM : 16,
          }}
        >
          <If when={!native}>
            <RoundGlassButton
              name="back"
              label="Back to the library"
              testID="back"
              onPress={props.onBack}
            />
          </If>
          <Text
            class={native ? "truncate" : "flex-1 truncate"}
            style={{ color: look().inkSoft, fontSize: 12.5, flexShrink: 1 }}
          >
            {meta()}
          </Text>
          <View
            role={orphans().length ? "button" : undefined}
            accessibilityLabel={orphans().length ? "Highlights not found" : undefined}
            onPress={orphans().length ? () => void showOrphans() : undefined}
            class="active:opacity-60"
          >
            <Text testID="highlight-count" style={{ color: look().stamp, fontSize: 12 }}>
              {highlights()}
            </Text>
          </View>
          <If when={native}>
            <View class="flex-1" />
          </If>
          <If when={!native}>
            <GlassGroup>
              <IconButton
                name={b().favorite ? "starFill" : "star"}
                label={b().favorite ? "Remove from favorites" : "Add to favorites"}
                color={b().favorite ? look().favorite : undefined}
                onPress={() =>
                  void updateBookmark(b().id, { favorite: !b().favorite }).catch(() => {})
                }
              />
              <If when={canShare}>
                <IconButton
                  name="share"
                  label="Share"
                  onPress={(e) => shareBookmark(b(), e?.pagePosition)}
                />
              </If>
              <IconButton
                name="trash"
                label={inTrash(b()) ? "Delete permanently" : "Delete"}
                onPress={() =>
                  void deleteBookmark(b()).then((gone) => {
                    if (gone) props.onBack();
                  })
                }
              />
              <IconButton
                name="pencil"
                label="Edit title, tags and note"
                onPress={() => editBookmark(b())}
              />
              <IconButton
                // In the app (the globe), or where there's none, the system's browser.
                name={hasBrowser ? "globe" : "compass"}
                label="Open original"
                onPress={() => openOriginal(b())}
              />
              <If
                when={nativeMenus}
                else={
                  <BookmarkDropdown
                    b={b()}
                    options={menuOptions}
                    trigger={<IconButton name="more" label="More" />}
                  />
                }
              >
                <IconButton
                  name="more"
                  label="More"
                  onPress={(e) =>
                    void showBookmarkMenu(b(), { ...menuOptions, at: e?.pagePosition })
                  }
                />
              </If>
            </GlassGroup>
          </If>
        </View>
      </If>
    </View>
  );
}
