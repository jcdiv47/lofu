import { Image, pixelRatio, signal, Text, View } from "nsh";
import { nativeMenus, showBookmarkMenu } from "../lib/actions";
import type { Bookmark } from "../lib/api";
import { isKept } from "../lib/articles";
import { onDisk } from "../lib/files";
import { markRuns, shortDate } from "../lib/format";
import { fonts, look } from "../lib/look";
import { displayTitle } from "../lib/prefs";
import { collectionName, highlightCount, offline } from "../lib/store";
import { BookmarkContextMenu } from "./BookmarkMenu";
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
function Marks(props: { b: Bookmark }) {
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
      <If when={hl() > 0}>
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
function MetaLine(props: { b: Bookmark; showCollection: boolean }) {
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
      <Marks b={props.b} />
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

/** A card in the desktop grid: cover, title, meta. */
export function BookmarkCard(props: {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  snippet?: string | null;
}) {
  const b = () => props.b;
  const card = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`card-${b().id}`}
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
      }}
      hoverStyle={{
        backgroundColor: look().cardHover,
        borderColor: look().rule,
        boxShadow: look().shadowLift,
      }}
    >
      <Cover b={b()} height={CARD_COVER} radius={15} />
      <View class="justify-between gap-2 px-3.5 pt-3 pb-3" style={{ height: CARD_BODY }}>
        <View class="gap-1">
          <Text
            style={{
              color: look().ink,
              fontSize: 14.5,
              lineHeight: 19,
              fontWeight: "600",
              numberOfLines: props.snippet ? 1 : 2,
            }}
          >
            {displayTitle(b())}
          </Text>
          <If when={props.snippet}>
            <Snippet text={props.snippet ?? ""} lines={2} />
          </If>
        </View>
        <MetaLine b={b()} showCollection={props.showCollection} />
      </View>
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
}) {
  const b = () => props.b;
  const thumbFailed = signal<string | null>(null);
  const excerpt = () => b().excerpt?.replace(/\s+/g, " ").trim() ?? "";
  const row = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`row-${b().id}`}
      onPress={props.onOpen}
      onLongPress={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="flex-row gap-3 px-4 py-3.5"
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
 * A headline: one line of favicon, title and meta, for *Headlines* (the
 * densest view, nothing but names).
 */
export function BookmarkHeadline(props: {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  snippet?: string | null;
}) {
  const b = () => props.b;
  const row = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`headline-${b().id}`}
      onPress={props.onOpen}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), { at: e.pagePosition }) : undefined
      }
      class="h-10 flex-row items-center gap-2.5 rounded-lg px-3"
      activeStyle={{ backgroundColor: look().selected }}
      hoverStyle={{ backgroundColor: look().cardHover }}
    >
      <Favicon url={b().faviconUrl} domain={b().domain} size={14} />
      <Text
        class="min-w-0 truncate"
        style={{ color: look().ink, fontSize: 14, fontWeight: "500", flexShrink: 1 }}
      >
        {displayTitle(b())}
      </Text>
      <View class="min-w-[120px] flex-1">
        <MetaLine b={b()} showCollection={props.showCollection} />
      </View>
    </View>
  );
  return nativeMenus ? row : <BookmarkContextMenu b={b()} trigger={row} />;
}

/**
 * A tile of *Moodboard*: the cover at its own shape (a page's catalog card
 * without one), the title and meta under it. Tiles of a column stack with
 * no gaps between their heights, as Raindrop's masonry.
 */
export function MoodboardTile(props: {
  b: Bookmark;
  onOpen: () => void;
  showCollection: boolean;
  snippet?: string | null;
}) {
  const b = () => props.b;
  // Recycled cells: the shape is the cover's, and which cover it was.
  const shape = signal<{ url: string; ratio: number } | null>(null);
  const failedUrl = signal<string | null>(null);
  const url = () => b().coverUrl;
  const ratio = () => {
    const s = shape();
    return s && s.url === url() ? s.ratio : 4 / 3;
  };
  const tile = (
    <View
      role="button"
      accessibilityLabel={displayTitle(b())}
      testID={`tile-${b().id}`}
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
      }}
      hoverStyle={{ backgroundColor: look().cardHover, boxShadow: look().shadowLift }}
    >
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
      <View class="gap-1.5 px-3 pt-2.5 pb-3">
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
        <MetaLine b={b()} showCollection={props.showCollection} />
      </View>
    </View>
  );
  return nativeMenus ? tile : <BookmarkContextMenu b={b()} trigger={tile} />;
}
