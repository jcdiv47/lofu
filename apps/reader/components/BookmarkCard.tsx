import { Image, signal, Text, View } from "nsh";
import { nativeMenus, showBookmarkMenu } from "../lib/actions";
import type { Bookmark } from "../lib/api";
import { markRuns, shortDate } from "../lib/format";
import { fonts, look } from "../lib/look";
import { collectionName, highlightCount } from "../lib/store";
import { BookmarkContextMenu } from "./BookmarkMenu";
import { Favicon, Icon } from "./ui";

export const CARD_COVER = 132;
const CARD_BODY = 112;

const displayTitle = (b: Bookmark) => b.title || b.url.replace(/^https?:\/\/(www\.)?/, "");

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
  return (
    <>
      <If when={props.b.favorite}>
        <Icon name="starFill" size={12} color={look().favorite} />
      </If>
      <If when={hl() > 0}>
        <View class="flex-row items-center gap-0.5">
          <Icon name="highlighter" size={12} color={look().inkFaint} />
          <Text style={{ color: look().inkFaint, fontSize: 11.5 }}>{hl()}</Text>
        </View>
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
        nativeMenus ? (e) => void showBookmarkMenu(b(), props.onOpen, e.pagePosition) : undefined
      }
      class="overflow-hidden rounded-xl active:opacity-80"
      style={{
        backgroundColor: look().card,
        borderWidth: 1,
        borderColor: look().ruleSoft,
        boxShadow: look().shadow,
      }}
      hoverStyle={{ backgroundColor: look().cardHover, borderColor: look().rule }}
    >
      <Cover b={b()} height={CARD_COVER} radius={11} />
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
  return nativeMenus ? card : <BookmarkContextMenu b={b()} open={props.onOpen} trigger={card} />;
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
      onLongPress={nativeMenus ? () => void showBookmarkMenu(b(), props.onOpen) : undefined}
      onContextMenu={
        nativeMenus ? (e) => void showBookmarkMenu(b(), props.onOpen, e.pagePosition) : undefined
      }
      class="flex-row gap-3 px-4 py-3.5"
      activeStyle={{ backgroundColor: look().selected }}
      style={{ borderBottomWidth: 1, borderColor: look().ruleSoft }}
    >
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
            borderRadius: 8,
            objectFit: "cover",
            backgroundColor: look().paperDeep,
            marginTop: 2,
          }}
        />
      </If>
    </View>
  );
  return nativeMenus ? row : <BookmarkContextMenu b={b()} open={props.onOpen} trigger={row} />;
}
