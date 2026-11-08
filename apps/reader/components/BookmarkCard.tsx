import { Image, pixelRatio, signal, Text, View } from "nsh";
import { nativeMenus, showBookmarkMenu } from "../lib/actions";
import type { Bookmark } from "../lib/api";
import { isKept } from "../lib/articles";
import { onDisk } from "../lib/files";
import { markRuns, shortDate } from "../lib/format";
import { fonts, look } from "../lib/look";
import { displayTitle, type ShowField } from "../lib/prefs";
import { collectionName, highlightCount, offline } from "../lib/store";
import { BookmarkContextMenu } from "./BookmarkMenu";
import type { DragProps } from "./ManualDrag";
import { Favicon, Icon } from "./ui";

export const CARD_COVER = 132;
const CARD_BODY = 112;

/**
 * A page with no cover image gets a catalog card instead: its excerpt set in
 * serif under the site's name, on ruled paper.
 */
function PaperCover(props: { b: Bookmark; height: number; radius?: number }) {
  const excerpt = () => props.b.excerpt?.replace(/\s+/g, " ").trim() ?? "";
  return (
    <View
      class="overflow-hidden px-4 pt-3"
      style={{
        height: props.height,
        backgroundColor: look().paperDeep,
        borderTopLeftRadius: props.radius,
        borderTopRightRadius: props.radius,
      }}
    >
      <View
        class="flex-row items-center gap-1.5 pb-2"
        style={{ borderBottomWidth: 1, borderColor: `${look().stamp}66` }}
      >
        <Favicon url={props.b.faviconUrl} domain={props.b.domain} size={12} />
        <Text
          class="flex-1 truncate"
          style={{
            color: look().inkFaint,
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
            <View style={{ height: 1, backgroundColor: look().rule }} />
            <View style={{ height: 1, backgroundColor: look().rule }} />
            <View style={{ height: 1, backgroundColor: look().rule }} />
            <View style={{ height: 1, backgroundColor: look().rule }} />
          </View>
        }
      >
        <Text
          style={{
            color: look().inkSoft,
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
        src={url() ?? ""}
        onError={() => failedUrl.set(url())}
        fadeDuration={150}
        style={{
          height: props.height,
          width: "100%",
          objectFit: "cover",
          backgroundColor: look().paperDeep,
          borderTopLeftRadius: props.radius,
          borderTopRightRadius: props.radius,
        }}
      />
    </If>
  );
}

/** Favorite, highlights and fetch status: small marks at the end of the meta line. */
function Marks(props: { b: Bookmark; highlights?: boolean }) {
  const hl = () => highlightCount(props.b.id);
  const status = () => props.b.contentStatus;
  // Offline, what can't be read without the server (the web keeps nothing, so says nothing).
  const onlineOnly = () =>
    onDisk && offline() && status() === "ok" && !props.b.archived && !isKept(props.b.id);
  return (
    <>
      <If when={onlineOnly()}>
        <Text
          testID={`online-only-${props.b.id}`}
          style={{ color: look().inkFaint, fontSize: 11.5 }}
        >
          Online only
        </Text>
      </If>
      <If when={props.b.favorite}>
        <Icon name="starFill" size={12} color={look().favorite} />
      </If>
      <If when={props.highlights !== false && hl() > 0}>
        <View class="flex-row items-center gap-0.5">
          <Icon name="highlighter" size={12} color={look().inkFaint} />
          <Text style={{ color: look().inkFaint, fontSize: 11.5 }}>{hl()}</Text>
        </View>
      </If>
      <If when={props.b.readProgress >= 0.98}>
        <View class="flex-row items-center gap-0.5">
          <Icon name="check" size={12} color={look().inkFaint} />
          <Text style={{ color: look().inkFaint, fontSize: 11.5 }}>Read</Text>
        </View>
      </If>
      <If when={props.b.readProgress > 0.02 && props.b.readProgress < 0.98}>
        <Text style={{ color: look().inkFaint, fontSize: 11.5, fontVariant: ["tabular-nums"] }}>
          {`${Math.round(props.b.readProgress * 100)}%`}
        </Text>
      </If>
      <If when={status() === "failed" || status() === "pending"}>
        <View class="flex-row items-center gap-1">
          <Icon name={status() === "failed" ? "alert" : "clock"} size={12} color={look().stamp} />
          <Text style={{ color: look().stamp, fontSize: 11.5 }}>
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
      shortDate(props.b.createdAt),
    ]
      .filter(Boolean)
      .join("  ·  ");
  return (
    <View class="flex-row items-center gap-2">
      <Text class="min-w-0 flex-1 truncate" style={{ color: look().inkFaint, fontSize: 12 }}>
        {text()}
      </Text>
      <Marks b={props.b} highlights={props.highlights} />
    </View>
  );
}

function Snippet(props: { text: string; lines: number }) {
  return (
    <Text
      style={{ color: look().inkSoft, fontSize: 13, lineHeight: 18, numberOfLines: props.lines }}
    >
      <Each of={markRuns(props.text)}>
        {(r) => (
          <Text
            style={
              r().hit
                ? { backgroundColor: look().highlight, color: look().ink }
                : { color: look().inkSoft }
            }
          >
            {r().text}
          </Text>
        )}
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
}

const tagLine = (b: Bookmark) => b.tags.map((t) => `#${t}`).join("  ");
const excerptOf = (b: Bookmark) => b.excerpt?.replace(/\s+/g, " ").trim() ?? "";

/** The bookmark's note, set apart by a rule in the accent colour. */
function Note(props: { text: string; lines: number }) {
  return (
    <View class="flex-row gap-2">
      <View style={{ width: 2, borderRadius: 1, backgroundColor: `${look().stamp}88` }} />
      <Text
        class="min-w-0 flex-1"
        style={{ color: look().inkSoft, fontSize: 13, lineHeight: 18, numberOfLines: props.lines }}
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
              style={{
                color: look().inkSoft,
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
        <Text class="truncate" style={{ color: look().stamp, fontSize: 12, lineHeight: 17 }}>
          {tagLine(b())}
        </Text>
      </If>
      <If when={on("info")}>
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
    show("info") ? 17 : 0,
  ].filter(Boolean);
  return parts.length ? 24 + parts.reduce((a, x) => a + x, 0) + 6 * (parts.length - 1) : 0;
}

/** A card in the desktop grid: cover, title, and what *Show in Cards* asks for. */
export function BookmarkCard(props: ItemProps & { coverHeight?: number }) {
  const b = () => props.b;
  const on = (f: ShowField) => !props.show || props.show(f);
  const body = () => (props.show ? cardBody(props.show) : CARD_BODY);
  const card = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`card-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="overflow-hidden rounded-[16px] active:opacity-80"
      style={{
        backgroundColor: look().card,
        borderWidth: 1,
        borderColor: look().ruleSoft,
        borderCurve: "continuous",
        boxShadow: look().shadow,
        transitionProperty: "box-shadow, background-color, border-color",
        transitionDuration: 160,
        transitionTimingFunction: "ease-out",
        ...props.drag?.style(),
      }}
      hoverStyle={{
        backgroundColor: look().cardHover,
        borderColor: look().rule,
        boxShadow: look().shadowLift,
      }}
    >
      <If when={on("cover")}>
        <Cover b={b()} height={props.coverHeight ?? CARD_COVER} radius={15} />
      </If>
      <If when={body() > 0}>
        <View class="gap-1.5 overflow-hidden px-3.5 pt-3 pb-3" style={{ height: body() }}>
          <If when={on("title")}>
            <Text
              style={{
                color: look().ink,
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

/** A row in the phone list: title, excerpt and meta beside a thumbnail. */
export function BookmarkRow(props: {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  snippet?: string | null;
  /** Draggable into place (manual order). */
  drag?: DragProps;
}) {
  const b = () => props.b;
  const thumbFailed = signal<string | null>(null);
  const excerpt = () => b().excerpt?.replace(/\s+/g, " ").trim() ?? "";
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
      class="flex-row gap-3 px-4 py-3.5"
      style={props.drag?.style()}
      activeStyle={{ backgroundColor: look().selected }}
      hoverStyle={{ backgroundColor: look().cardHover }}
    >
      {/* iOS's inset hairline, from the text's leading edge. */}
      <View
        class="absolute right-0 bottom-0 left-4"
        style={{ height: 1 / pixelRatio(), backgroundColor: look().rule }}
      />
      <View class="min-w-0 flex-1 gap-1">
        <Text
          style={{
            color: look().ink,
            fontSize: 16,
            lineHeight: 21,
            fontWeight: "600",
            numberOfLines: 2,
          }}
        >
          {displayTitle(b())}
        </Text>
        <If
          when={props.snippet}
          else={
            <If when={excerpt()}>
              <Text
                style={{ color: look().inkSoft, fontSize: 13.5, lineHeight: 18, numberOfLines: 2 }}
              >
                {excerpt()}
              </Text>
            </If>
          }
        >
          <Snippet text={props.snippet ?? ""} lines={3} />
        </If>
        <View class="mt-1 flex-row items-center gap-1.5">
          <Favicon url={b().faviconUrl} domain={b().domain} size={13} />
          <View class="min-w-0 flex-1">
            <MetaLine b={b()} showCollection={props.showCollection} />
          </View>
        </View>
      </View>
      <If when={b().coverUrl && thumbFailed() !== b().coverUrl}>
        <Image
          src={b().coverUrl ?? ""}
          onError={() => thumbFailed.set(b().coverUrl)}
          style={{
            width: 76,
            height: 76,
            borderRadius: 12,
            borderCurve: "continuous",
            objectFit: "cover",
            backgroundColor: look().paperDeep,
            marginTop: 2,
          }}
        />
      </If>
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
        class="overflow-hidden"
        style={{
          width: 96,
          height: 72,
          borderRadius: 10,
          borderCurve: "continuous",
          backgroundColor: look().paperDeep,
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
      class="flex-row gap-4 rounded-xl px-4 py-3.5"
      style={props.drag?.style()}
      activeStyle={{ backgroundColor: look().selected }}
      hoverStyle={{ backgroundColor: look().cardHover }}
    >
      <If when={props.coverLeft}>{thumb()}</If>
      <View class="min-w-0 flex-1 gap-1.5">
        <If when={on("title")}>
          <Text
            style={{
              color: look().ink,
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
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="h-10 flex-row items-center gap-2.5 rounded-lg px-3"
      style={props.drag?.style()}
      activeStyle={{ backgroundColor: look().selected }}
      hoverStyle={{ backgroundColor: look().cardHover }}
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
          class="min-w-0 truncate"
          style={{ color: look().ink, fontSize: 14, fontWeight: "500", flexShrink: 1 }}
        >
          {displayTitle(b())}
        </Text>
      </If>
      <If when={props.snippet || (on("description") && excerptOf(b())) || (on("note") && b().note)}>
        <Text
          class="min-w-0 truncate"
          style={{ color: look().inkFaint, fontSize: 13, flexShrink: 2 }}
        >
          {(props.snippet &&
            markRuns(props.snippet)
              .map((r) => r.text)
              .join("")) ||
            (on("note") && b().note) ||
            excerptOf(b())}
        </Text>
      </If>
      <If when={on("tags") && b().tags.length}>
        <Text class="truncate" style={{ color: look().stamp, fontSize: 12, flexShrink: 3 }}>
          {tagLine(b())}
        </Text>
      </If>
      <View class="min-w-[120px] flex-1">
        <If when={on("info")}>
          <MetaLine b={b()} showCollection={props.showCollection} highlights={on("highlights")} />
        </If>
      </View>
    </View>
  );
  return nativeMenus ? row : <BookmarkContextMenu b={b()} trigger={row} />;
}

/**
 * A tile of *Moodboard*: the cover at its own shape (a page's catalog card
 * without one), and what *Show in Moodboard* asks for under it. Tiles of a
 * column stack with no gaps between their heights, as Raindrop's masonry.
 */
export function MoodboardTile(props: ItemProps) {
  const b = () => props.b;
  const on = (f: ShowField) => !props.show || props.show(f);
  // Recycled cells: the shape is the cover's, and which cover it was.
  const shape = signal<{ url: string; ratio: number } | null>(null);
  const failedUrl = signal<string | null>(null);
  const url = () => b().coverUrl;
  const ratio = () => {
    const s = shape();
    return s && s.url === url() ? s.ratio : 4 / 3;
  };
  const text = () =>
    on("title") ||
    !!props.snippet ||
    (on("description") && !!excerptOf(b())) ||
    (on("note") && !!b().note) ||
    (on("tags") && b().tags.length > 0) ||
    on("info");
  const tile = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`tile-${b().id}`}
      ref={props.drag?.ref}
      {...(props.drag?.handlers ?? {})}
      onPress={props.onOpen}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="overflow-hidden rounded-[14px] active:opacity-80"
      style={{
        backgroundColor: look().card,
        borderWidth: 1,
        borderColor: look().ruleSoft,
        borderCurve: "continuous",
        boxShadow: look().shadow,
        ...props.drag?.style(),
      }}
      hoverStyle={{ backgroundColor: look().cardHover, boxShadow: look().shadowLift }}
    >
      <If when={on("cover")}>
        <If
          when={url() && failedUrl() !== url()}
          else={<PaperCover b={b()} height={150} radius={13} />}
        >
          <Image
            src={url() ?? ""}
            onError={() => failedUrl.set(url())}
            onLoad={(e) => {
              const u = url();
              if (u && e.size.width > 0 && e.size.height > 0)
                shape.set({
                  url: u,
                  ratio: Math.min(3, Math.max(0.5, e.size.width / e.size.height)),
                });
            }}
            fadeDuration={150}
            style={{
              width: "100%",
              aspectRatio: ratio(),
              objectFit: "cover",
              backgroundColor: look().paperDeep,
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
              style={{
                color: look().ink,
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
