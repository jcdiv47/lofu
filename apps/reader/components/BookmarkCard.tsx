import { Image, pixelRatio, reduceMotion, signal, Text, View } from "nsh";
import { nativeMenus, showBookmarkMenu } from "../lib/actions";
import type { Bookmark } from "../lib/api";
import { isKept } from "../lib/articles";
import { onDisk } from "../lib/files";
import { markRuns, shortDate } from "../lib/format";
import { fonts, look } from "../lib/look";
import { motion } from "../lib/motion";
import { displayTitle, type ShowField, timeFormat } from "../lib/prefs";
import { opensAsPage } from "../lib/sites";
import { collectionName, highlightCount, offline } from "../lib/store";
import { BookmarkContextMenu } from "./BookmarkMenu";
import type { DragProps } from "./ManualDrag";
import { Favicon, focusRing, Icon } from "./ui";

export const CARD_COVER = 132;
const CARD_BODY = 112;

/**
 * A card's hover, for the grid's cards and the moodboard's tiles: it lifts
 * 3pt off the page under a wider shadow, and its edge darkens, which carries
 * the hover in dark mode, where a shadow hardly shows. With reduced motion the
 * edge and shadow change at once and the card stays where it is; while it is
 * dragged it neither lifts nor eases, so it keeps up with the pointer. The lift
 * is `translate`, apart from the drag's `transform`, so the two never fight.
 */
function cardHover(drag?: DragProps) {
  const still = () => reduceMotion() || !!drag?.style();
  return {
    style: () => ({
      transitionProperty: `box-shadow, background-color, border-color${still() ? "" : ", translate"}`,
      transitionDuration: reduceMotion() ? 0 : motion.fast,
      transitionTimingFunction: "ease-out" as const,
    }),
    hoverStyle: () => ({
      boxShadow: look().shadowLift,
      ...(still() ? {} : { translate: "0px -3px" }),
    }),
  };
}

/**
 * A page with no cover image gets a catalog card instead: its excerpt set in
 * serif under the site's name, on ruled paper.
 */
function PaperCover(props: { b: Bookmark; height: number; radius?: number }) {
  const excerpt = () => props.b.excerpt?.replace(/\s+/g, " ").trim() ?? "";
  return (
    <View
      class="overflow-hidden px-4 pt-3 bg-paper-deep"
      style={{
        height: props.height,
        borderTopLeftRadius: props.radius,
        borderTopRightRadius: props.radius,
      }}
    >
      <View
        // The catalog card's rule, in the stamp's red, faded.
        class="flex-row items-center gap-1.5 border-b border-stamp/40 pb-2"
      >
        <Favicon url={props.b.faviconUrl} domain={props.b.domain} size={12} />
        <Text
          class="flex-1 truncate text-ink-faint"
          style={{
            fontSize: 10.5,
            fontFamily: fonts.mono,
            letterSpacing: 0.4,
          }}
        >
          {props.b.domain.replace(/^www\./, "").toUpperCase()}
        </Text>
      </View>
      <If
        when={excerpt()}
        else={
          // No text to show: the card's blank ruled lines.
          <View class="gap-[18px] pt-[22px]">
            <View class="bg-rule" style={{ height: 1 }} />
            <View class="bg-rule" style={{ height: 1 }} />
            <View class="bg-rule" style={{ height: 1 }} />
            <View class="bg-rule" style={{ height: 1 }} />
          </View>
        }
      >
        <Text
          class="text-ink-soft"
          style={{
            fontFamily: fonts.serif,
            fontSize: 13,
            lineHeight: 19,
            marginTop: 6,
            numberOfLines: 4,
          }}
        >
          {excerpt()}
        </Text>
      </If>
    </View>
  );
}

function Cover(props: { b: Bookmark; height: number; radius?: number }) {
  // Rows are recycled: remember which URL failed, not just that one did.
  const failedUrl = signal<string | null>(null);
  const url = () => props.b.coverUrl;
  return (
    <If when={url() && failedUrl() !== url()} else={<PaperCover {...props} />}>
      <Image
        class="bg-paper-deep"
        src={url() ?? ""}
        onError={() => failedUrl.set(url())}
        fadeDuration={150}
        style={{
          height: props.height,
          width: "100%",
          objectFit: "cover",
          borderTopLeftRadius: props.radius,
          borderTopRightRadius: props.radius,
        }}
      />
    </If>
  );
}

/** Favorite, highlights and fetch status: small marks at the end of the meta line. */
function Marks(props: {
  b: Bookmark;
  highlights?: boolean;
  /** At most this much of the system's text size (`maxFontSizeMultiplier`). */
  maxScale?: number;
}) {
  const hl = () => highlightCount(props.b.id);
  // A site opened as a page is never read: it's neither fetching nor unreadable.
  const status = () => (opensAsPage(props.b) ? "skipped" : props.b.contentStatus);
  // Offline, what can't be read without the server (the web keeps nothing, so says nothing).
  const onlineOnly = () =>
    onDisk && offline() && status() === "ok" && !props.b.archived && !isKept(props.b.id);
  return (
    <>
      <If when={onlineOnly()}>
        <Text
          class="text-ink-faint"
          testID={`online-only-${props.b.id}`}
          style={{ fontSize: 11.5 }}
          maxFontSizeMultiplier={props.maxScale}
        >
          Online only
        </Text>
      </If>
      <If when={props.b.favorite}>
        <Icon name="starFill" size={12} class="tint-favorite" />
      </If>
      <If when={props.highlights !== false && hl() > 0}>
        <View class="flex-row items-center gap-0.5">
          <Icon name="highlighter" size={12} class="tint-ink-faint" />
          <Text
            class="text-ink-faint"
            maxFontSizeMultiplier={props.maxScale}
            style={{ fontSize: 11.5 }}
          >
            {hl()}
          </Text>
        </View>
      </If>
      <If when={props.b.readProgress >= 0.98}>
        <View class="flex-row items-center gap-0.5">
          <Icon name="check" size={12} class="tint-ink-faint" />
          <Text
            class="text-ink-faint"
            maxFontSizeMultiplier={props.maxScale}
            style={{ fontSize: 11.5 }}
          >
            Read
          </Text>
        </View>
      </If>
      <If when={props.b.readProgress > 0.02 && props.b.readProgress < 0.98}>
        <Text
          class="text-ink-faint"
          maxFontSizeMultiplier={props.maxScale}
          style={{ fontSize: 11.5, fontVariant: ["tabular-nums"] }}
        >
          {`${Math.round(props.b.readProgress * 100)}%`}
        </Text>
      </If>
      <If when={status() === "failed" || status() === "pending"}>
        <View class="flex-row items-center gap-1">
          <Icon name={status() === "failed" ? "alert" : "clock"} size={12} class="tint-stamp" />
          <Text
            class="text-stamp"
            maxFontSizeMultiplier={props.maxScale}
            style={{ fontSize: 11.5 }}
          >
            {status() === "failed" ? "Unreadable" : "Fetching"}
          </Text>
        </View>
      </If>
    </>
  );
}

/** "domain · collection · date" in one run, so it truncates as a whole. */
function MetaLine(props: { b: Bookmark; showCollection: boolean; highlights?: boolean }) {
  const text = () =>
    [
      props.b.domain.replace(/^www\./, ""),
      props.showCollection ? collectionName(props.b.collectionId) : "",
      shortDate(props.b.createdAt, undefined, timeFormat()),
    ]
      .filter(Boolean)
      .join("  ·  ");
  return (
    <View class="flex-row items-center gap-2">
      <Text class="min-w-0 flex-1 truncate text-ink-faint" style={{ fontSize: 12 }}>
        {text()}
      </Text>
      <Marks b={props.b} highlights={props.highlights} />
    </View>
  );
}

function Snippet(props: { text: string; lines: number }) {
  return (
    <Text
      class="text-ink-soft"
      style={{ fontSize: 13, lineHeight: 18, numberOfLines: props.lines }}
    >
      <Each of={markRuns(props.text)}>
        {(r) => <Text class={r().hit ? "bg-highlight text-ink" : "text-ink-soft"}>{r().text}</Text>}
      </Each>
    </Text>
  );
}

/** Which of *Show in …*'s fields a view shows (`lib/prefs.ts`). */
export type Shows = (f: ShowField) => boolean;

/** The props every view's bookmark takes. */
interface ItemProps {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  /** A search's snippet, the matches marked. */
  snippet?: string | null;
  /** Draggable into place (manual order). */
  drag?: DragProps;
  /** What it shows; everything without it. */
  show?: Shows;
  /** A phone's: a long press opens the bookmark's menu, as the rows' does. */
  touch?: boolean;
}

/** The menu from a long press, on phones. */
const longPress = (b: () => Bookmark, touch?: boolean) =>
  touch && nativeMenus
    ? (e: { pagePosition: { x: number; y: number } }) =>
        void showBookmarkMenu(b(), { at: e.pagePosition })
    : undefined;

const tagLine = (b: Bookmark) => b.tags.map((t) => `#${t}`).join("  ");
const excerptOf = (b: Bookmark) => b.excerpt?.replace(/\s+/g, " ").trim() ?? "";

/** *Highlights* without *Bookmark info*: the count on its own, where the meta line would be. */
function HighlightCount(props: { b: Bookmark; on: (f: ShowField) => boolean }) {
  const n = () => highlightCount(props.b.id);
  return (
    <If when={props.on("highlights") && n() > 0}>
      <View class="flex-row items-center gap-0.5">
        <Icon name="highlighter" size={12} class="tint-ink-faint" />
        <Text class="text-ink-faint" style={{ fontSize: 11.5 }}>
          {n()}
        </Text>
      </View>
    </If>
  );
}

/** The bookmark's note, set apart by a rule in the accent colour. */
function Note(props: { text: string; lines: number }) {
  return (
    <View class="flex-row gap-2">
      <View class="rounded-[1px] bg-stamp/53" style={{ width: 2 }} />
      <Text
        class="min-w-0 flex-1 text-ink-soft"
        style={{ fontSize: 13, lineHeight: 18, numberOfLines: props.lines }}
      >
        {props.text}
      </Text>
    </View>
  );
}

/**
 * The text of a bookmark under its title, as its view's *Show in …* asks:
 * the search's snippet (in place of the description), description, note,
 * tags and the meta line. `lines` caps each of the text's.
 */
function Details(props: ItemProps & { lines: number }) {
  const on = (f: ShowField) => !props.show || props.show(f);
  const b = () => props.b;
  return (
    <>
      <If
        when={props.snippet}
        else={
          <If when={on("description") && excerptOf(b())}>
            <Text
              class="text-ink-soft"
              style={{
                fontSize: 13,
                lineHeight: 18,
                numberOfLines: props.lines,
              }}
            >
              {excerptOf(b())}
            </Text>
          </If>
        }
      >
        <Snippet text={props.snippet ?? ""} lines={props.lines} />
      </If>
      <If when={on("note") && b().note}>
        <Note text={b().note ?? ""} lines={props.lines} />
      </If>
      <If when={on("tags") && b().tags.length}>
        <Text class="truncate text-tag" style={{ fontSize: 12, lineHeight: 17 }}>
          {tagLine(b())}
        </Text>
      </If>
      <If when={on("info")} else={<HighlightCount b={b()} on={on} />}>
        <MetaLine b={b()} showCollection={props.showCollection} highlights={on("highlights")} />
      </If>
    </>
  );
}

/** The card grid's cover height and card width for a *Cover* size (1–5). */
export const cardCover = (size: number) => 96 + (size - 1) * 36;
export const cardWidth = (size: number) => 180 + (size - 1) * 50;

/**
 * A card's body height: the cards of a row line up, so each is as tall as
 * the fields its view shows need, whether a bookmark has them or not.
 */
export function cardBody(show: Shows) {
  const parts = [
    show("title") ? 38 : 0,
    show("description") ? 36 : 0,
    show("note") ? 36 : 0,
    show("tags") ? 17 : 0,
    show("info") || show("highlights") ? 17 : 0,
  ].filter(Boolean);
  return parts.length ? 24 + parts.reduce((a, x) => a + x, 0) + 6 * (parts.length - 1) : 0;
}

/** A card in the desktop grid: cover, title, and what *Show in Cards* asks for. */
export function BookmarkCard(
  props: ItemProps & {
    coverHeight?: number;
    /** The text's scale (phones: Dynamic Type), which the body's fixed height follows. */
    bodyScale?: number;
  },
) {
  const b = () => props.b;
  const on = (f: ShowField) => !props.show || props.show(f);
  const body = () =>
    Math.round((props.show ? cardBody(props.show) : CARD_BODY) * (props.bodyScale ?? 1));
  const hover = cardHover(props.drag);
  const card = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`card-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onLongPress={longPress(b, props.touch)}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="overflow-hidden rounded-[16px] active:opacity-80 bg-card border-rule-soft hover:bg-card-hover hover:border-rule-strong"
      style={{
        borderWidth: 1,
        borderCurve: "continuous",
        boxShadow: look().shadow,
        ...hover.style(),
        ...props.drag?.style(),
      }}
      hoverStyle={hover.hoverStyle()}
    >
      <If when={on("cover")}>
        <Cover b={b()} height={props.coverHeight ?? CARD_COVER} radius={15} />
      </If>
      <If when={body() > 0}>
        <View class="gap-1.5 overflow-hidden px-3.5 pt-3 pb-3" style={{ height: body() }}>
          <If when={on("title")}>
            <Text
              class="text-ink"
              style={{
                fontSize: 14.5,
                lineHeight: 19,
                fontWeight: "600",
                numberOfLines: 2,
              }}
            >
              {displayTitle(b())}
            </Text>
          </If>
          <View class="flex-1" />
          <Details {...props} lines={2} />
        </View>
      </If>
    </View>
  );
  return nativeMenus ? card : <BookmarkContextMenu b={b()} trigger={card} />;
}

/**
 * A row in the phone list: title, excerpt and meta beside a thumbnail, or
 * what *Show in List* asks for, the thumbnail on the side *Cover position* says.
 */
export function BookmarkRow(props: {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  snippet?: string | null;
  /** Draggable into place (manual order). */
  drag?: DragProps;
  /** What it shows; the title, excerpt, meta and thumbnail without it. */
  show?: Shows;
  coverLeft?: boolean;
}) {
  const b = () => props.b;
  const on = (f: ShowField) =>
    props.show ? props.show(f) : f !== "note" && f !== "tags" && f !== "highlights";
  const thumbFailed = signal<string | null>(null);
  const excerpt = () => (on("description") ? excerptOf(b()) : "");
  const thumb = () => (
    <If when={on("cover") && b().coverUrl && thumbFailed() !== b().coverUrl}>
      <Image
        class="bg-paper-deep"
        src={b().coverUrl ?? ""}
        onError={() => thumbFailed.set(b().coverUrl)}
        style={{
          width: 76,
          height: 76,
          borderRadius: 12,
          borderCurve: "continuous",
          objectFit: "cover",
          marginTop: 2,
        }}
      />
    </If>
  );
  const row = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`row-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onLongPress={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="flex-row gap-3 px-4 py-3.5 hover:bg-card-hover active:bg-selected"
      style={props.drag?.style()}
    >
      {/* iOS's inset hairline, from the text's leading edge. */}
      <View class="absolute right-0 bottom-0 left-4 bg-rule" style={{ height: 1 / pixelRatio() }} />
      <If when={props.coverLeft}>{thumb()}</If>
      <View class="min-w-0 flex-1 gap-1">
        <If when={on("title")}>
          <Text
            class="text-ink"
            style={{
              fontSize: 16,
              lineHeight: 21,
              fontWeight: "600",
              numberOfLines: 2,
            }}
          >
            {displayTitle(b())}
          </Text>
        </If>
        <If
          when={props.snippet}
          else={
            <If when={excerpt()}>
              <Text
                class="text-ink-soft"
                style={{ fontSize: 13.5, lineHeight: 18, numberOfLines: 2 }}
              >
                {excerpt()}
              </Text>
            </If>
          }
        >
          <Snippet text={props.snippet ?? ""} lines={3} />
        </If>
        <If when={on("note") && b().note}>
          <Note text={b().note ?? ""} lines={2} />
        </If>
        <If when={on("tags") && b().tags.length}>
          <Text class="truncate text-tag" style={{ fontSize: 12.5, lineHeight: 17 }}>
            {tagLine(b())}
          </Text>
        </If>
        <If when={on("info")} else={<HighlightCount b={b()} on={on} />}>
          <View class="mt-1 flex-row items-center gap-1.5">
            <Favicon url={b().faviconUrl} domain={b().domain} size={13} />
            <View class="min-w-0 flex-1">
              <MetaLine
                b={b()}
                showCollection={props.showCollection}
                highlights={props.show ? on("highlights") : undefined}
              />
            </View>
          </View>
        </If>
      </View>
      <If when={!props.coverLeft}>{thumb()}</If>
    </View>
  );
  return nativeMenus ? row : <BookmarkContextMenu b={b()} trigger={row} />;
}

/**
 * A row of the wide window's *List*: the cover beside the title and what
 * *Show in List* asks for, on whichever side *Cover position* says.
 */
export function BookmarkListRow(props: ItemProps & { coverLeft?: boolean }) {
  const b = () => props.b;
  const on = (f: ShowField) => !props.show || props.show(f);
  const thumbFailed = signal<string | null>(null);
  const thumb = () => (
    <If when={on("cover")}>
      <View
        class="overflow-hidden bg-paper-deep"
        style={{
          width: 96,
          height: 72,
          borderRadius: 10,
          borderCurve: "continuous",
        }}
      >
        <If when={b().coverUrl && thumbFailed() !== b().coverUrl}>
          <Image
            src={b().coverUrl ?? ""}
            onError={() => thumbFailed.set(b().coverUrl)}
            style={{ width: 96, height: 72, objectFit: "cover" }}
          />
        </If>
      </View>
    </If>
  );
  const row = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`row-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="flex-row gap-4 rounded-xl px-4 py-3.5 hover:bg-card-hover active:bg-selected"
      style={props.drag?.style()}
    >
      <If when={props.coverLeft}>{thumb()}</If>
      <View class="min-w-0 flex-1 gap-1.5">
        <If when={on("title")}>
          <Text
            class="text-ink"
            style={{
              fontSize: 15.5,
              lineHeight: 21,
              fontWeight: "600",
              numberOfLines: 2,
            }}
          >
            {displayTitle(b())}
          </Text>
        </If>
        <Details {...props} lines={2} />
      </View>
      <If when={!props.coverLeft}>{thumb()}</If>
    </View>
  );
  return nativeMenus ? row : <BookmarkContextMenu b={b()} trigger={row} />;
}

/**
 * A headline: one line of favicon (or the cover, small), title and what
 * *Show in Headlines* asks for, for the densest view.
 */
export function BookmarkHeadline(props: ItemProps) {
  const b = () => props.b;
  const on = (f: ShowField) => !props.show || props.show(f);
  const failed = signal<string | null>(null);
  const row = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`headline-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onLongPress={longPress(b, props.touch)}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      // 48 points on phones: a finger's target is 44 at the least.
      // grows with the text (Dynamic Type) rather than crowd it.
      class={`${props.touch ? "min-h-12 py-2" : "h-10"} flex-row items-center gap-2.5 rounded-lg px-3 hover:bg-card-hover active:bg-selected ${focusRing}`}
      style={props.drag?.style()}
    >
      <If
        when={on("cover") && b().coverUrl && failed() !== b().coverUrl}
        else={<Favicon url={b().faviconUrl} domain={b().domain} size={14} />}
      >
        <Image
          src={b().coverUrl ?? ""}
          onError={() => failed.set(b().coverUrl)}
          style={{ width: 28, height: 20, borderRadius: 4, objectFit: "cover" }}
        />
      </If>
      <If when={on("title")}>
        <Text
          class="min-w-0 truncate text-ink"
          style={{
            fontSize: props.touch ? 15 : 14,
            fontWeight: "500",
            flexShrink: 1,
            // Phones: the title takes the row, the date and marks what it leaves.
            ...(props.touch ? { flexGrow: 1 } : {}),
          }}
        >
          {displayTitle(b())}
        </Text>
      </If>
      <If when={props.snippet || (on("description") && excerptOf(b()))}>
        <Text class="min-w-0 truncate text-ink-faint" style={{ fontSize: 13, flexShrink: 2 }}>
          {props.snippet
            ? markRuns(props.snippet)
                .map((r) => r.text)
                .join("")
            : excerptOf(b())}
        </Text>
      </If>
      <If when={on("note") && b().note}>
        <Text class="min-w-0 truncate text-ink-soft" style={{ fontSize: 13, flexShrink: 2 }}>
          {b().note}
        </Text>
      </If>
      <If when={on("tags") && b().tags.length}>
        <Text class="truncate text-tag" style={{ fontSize: 12, flexShrink: 3 }}>
          {tagLine(b())}
        </Text>
      </If>
      <If
        when={props.touch}
        else={
          <View class="min-w-[120px] flex-1">
            <If when={on("info")} else={<HighlightCount b={b()} on={on} />}>
              <MetaLine
                b={b()}
                showCollection={props.showCollection}
                highlights={on("highlights")}
              />
            </If>
          </View>
        }
      >
        {/* A phone's row is too narrow for the site (its icon is there) and
            the collection: the date and the marks. */}
        <View class="shrink-0 flex-row items-center gap-2">
          <If when={on("info")} else={<HighlightCount b={b()} on={on} />}>
            {/* Secondary: it grows less than the title, which keeps the row. */}
            <Text class="text-ink-faint" maxFontSizeMultiplier={1.5} style={{ fontSize: 12 }}>
              {shortDate(b().createdAt, undefined, timeFormat())}
            </Text>
            <Marks b={b()} highlights={on("highlights")} maxScale={1.5} />
          </If>
        </View>
      </If>
    </View>
  );
  return nativeMenus ? row : <BookmarkContextMenu b={b()} trigger={row} />;
}

/**
 * The covers' shapes (width over height), by URL: kept out of the tiles, whose
 * cells are recycled, so a tile scrolled back into view, or a column made
 * again, is laid out at its cover's shape at once instead of jumping from
 * 4:3 once the picture loads. Bounded: the shapes seen longest ago go first.
 */
const SHAPES = 2000;
const shapes = new Map<string, number>();
function rememberShape(url: string, ratio: number) {
  if (shapes.get(url) === ratio) return;
  shapes.delete(url);
  shapes.set(url, ratio);
  if (shapes.size > SHAPES) shapes.delete(shapes.keys().next().value as string);
}

/**
 * A tile of *Moodboard*: the cover at its own shape (a page's catalog card
 * without one), and what *Show in Moodboard* asks for under it. Tiles of a
 * column stack with no gaps between their heights, as Raindrop's masonry.
 */
export function MoodboardTile(props: ItemProps) {
  const b = () => props.b;
  const on = (f: ShowField) => !props.show || props.show(f);
  // Recycled cells: remember which cover failed, not just that one did.
  const failedUrl = signal<string | null>(null);
  // Only this tile updates when its cover loads; recycled tiles read `shapes` at once.
  const loadedShape = signal<{ url: string; ratio: number } | null>(null);
  const url = () => b().coverUrl;
  const ratio = () => {
    const u = url();
    if (!u) return 4 / 3;
    const cached = shapes.get(u);
    if (cached !== undefined) return cached;
    const s = loadedShape();
    return s && s.url === u ? s.ratio : 4 / 3;
  };
  const text = () =>
    on("title") ||
    !!props.snippet ||
    (on("description") && !!excerptOf(b())) ||
    (on("note") && !!b().note) ||
    (on("tags") && b().tags.length > 0) ||
    on("info") ||
    (on("highlights") && highlightCount(b().id) > 0);
  const hover = cardHover(props.drag);
  const tile = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`tile-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onLongPress={longPress(b, props.touch)}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class={`overflow-hidden rounded-[14px] active:opacity-80 bg-card border-rule-soft hover:bg-card-hover hover:border-rule-strong ${focusRing}`}
      style={{
        borderWidth: 1,
        borderCurve: "continuous",
        boxShadow: look().shadow,
        ...hover.style(),
        ...props.drag?.style(),
      }}
      hoverStyle={hover.hoverStyle()}
    >
      <If when={on("cover")}>
        <If
          when={url() && failedUrl() !== url()}
          else={<PaperCover b={b()} height={150} radius={13} />}
        >
          <Image
            class="bg-paper-deep"
            src={url() ?? ""}
            onError={() => failedUrl.set(url())}
            onLoad={(e) => {
              const u = url();
              if (u && e.size.width > 0 && e.size.height > 0) {
                const r = Math.min(3, Math.max(0.5, e.size.width / e.size.height));
                rememberShape(u, r);
                loadedShape.set({ url: u, ratio: r });
              }
            }}
            fadeDuration={150}
            style={{
              width: "100%",
              aspectRatio: ratio(),
              objectFit: "cover",
              borderTopLeftRadius: 13,
              borderTopRightRadius: 13,
            }}
          />
        </If>
      </If>
      <If when={text()}>
        <View class="gap-1.5 px-3 pt-2.5 pb-3">
          <If when={on("title")}>
            <Text
              class="text-ink"
              style={{
                fontSize: 13.5,
                lineHeight: 18,
                fontWeight: "600",
                numberOfLines: 3,
              }}
            >
              {displayTitle(b())}
            </Text>
          </If>
          <Details {...props} lines={4} />
        </View>
      </If>
    </View>
  );
  return nativeMenus ? tile : <BookmarkContextMenu b={b()} trigger={tile} />;
}
