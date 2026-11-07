import {
  Image,
  type JSX,
  type PressEvent,
  safeArea,
  safeAreaInsets,
  signal,
  Text,
  View,
  type ViewStyle,
} from "nsh";
import alertIcon from "../assets/icons/alert.svg";
import allIcon from "../assets/icons/all.svg";
import articleIcon from "../assets/icons/article.svg";
import audioIcon from "../assets/icons/audio.svg";
import backIcon from "../assets/icons/back.svg";
import checkIcon from "../assets/icons/check.svg";
import chevronIcon from "../assets/icons/chevron.svg";
import chevronDownIcon from "../assets/icons/chevron-down.svg";
import clockIcon from "../assets/icons/clock.svg";
import closeIcon from "../assets/icons/close.svg";
import collapseIcon from "../assets/icons/collapse.svg";
import documentIcon from "../assets/icons/document.svg";
import expandIcon from "../assets/icons/expand.svg";
import externalIcon from "../assets/icons/external.svg";
import folderIcon from "../assets/icons/folder.svg";
import forwardIcon from "../assets/icons/forward.svg";
import gridIcon from "../assets/icons/grid.svg";
import hashIcon from "../assets/icons/hash.svg";
import highlighterIcon from "../assets/icons/highlighter.svg";
import imageIcon from "../assets/icons/image.svg";
import inboxIcon from "../assets/icons/inbox.svg";
import linkIcon from "../assets/icons/link.svg";
import listIcon from "../assets/icons/list.svg";
import moreIcon from "../assets/icons/more.svg";
import pencilIcon from "../assets/icons/pencil.svg";
import plusIcon from "../assets/icons/plus.svg";
import refreshIcon from "../assets/icons/refresh.svg";
import restoreIcon from "../assets/icons/restore.svg";
import searchIcon from "../assets/icons/search.svg";
import settingsIcon from "../assets/icons/settings.svg";
import shareIcon from "../assets/icons/share.svg";
import sortIcon from "../assets/icons/sort.svg";
import starIcon from "../assets/icons/star.svg";
import starFillIcon from "../assets/icons/star-fill.svg";
import trashIcon from "../assets/icons/trash.svg";
import videoIcon from "../assets/icons/video.svg";
import { glass, hasGlass, look } from "../lib/look";
import { nativeControls, type SymbolIcon, SystemGlassButton } from "./native";

export const icons = {
  article: articleIcon,
  audio: audioIcon,
  check: checkIcon,
  chevronDown: chevronDownIcon,
  collapse: collapseIcon,
  document: documentIcon,
  expand: expandIcon,
  image: imageIcon,
  sort: sortIcon,
  video: videoIcon,
  alert: alertIcon,
  all: allIcon,
  back: backIcon,
  chevron: chevronIcon,
  clock: clockIcon,
  close: closeIcon,
  external: externalIcon,
  folder: folderIcon,
  forward: forwardIcon,
  grid: gridIcon,
  hash: hashIcon,
  highlighter: highlighterIcon,
  inbox: inboxIcon,
  link: linkIcon,
  list: listIcon,
  more: moreIcon,
  pencil: pencilIcon,
  plus: plusIcon,
  refresh: refreshIcon,
  restore: restoreIcon,
  search: searchIcon,
  settings: settingsIcon,
  share: shareIcon,
  star: starIcon,
  starFill: starFillIcon,
  trash: trashIcon,
};
export type IconName = keyof typeof icons;

/** A one-color icon, tinted to follow the theme. */
export function Icon(props: { name: IconName; size?: number; color?: string }) {
  const size = props.size ?? 16;
  return (
    <Image
      src={icons[props.name]}
      style={{ width: size, height: size, tintColor: props.color ?? look().inkSoft }}
    />
  );
}

/** A square icon button for toolbars; `label` is what screen readers say. */
export function IconButton(props: {
  name: IconName;
  label: string;
  /** Leave it out when a `Menu` around the button opens on the press. */
  onPress?: (e?: PressEvent) => void;
  color?: string;
  size?: number;
  testID?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      class="h-8 w-8 items-center justify-center rounded-full active:opacity-60"
      style={{
        backgroundColor: props.active ? look().selected : undefined,
        opacity: props.disabled ? 0.35 : 1,
      }}
      hoverStyle={{ backgroundColor: look().selected }}
    >
      <Icon name={props.name} size={props.size ?? 17} color={props.color} />
    </View>
  );
}

/** The paper's tint over the system's glass, as its first child (see `glass`). */
export function GlassTint(props: { radius?: number }) {
  return (
    <If when={hasGlass}>
      <View
        class="absolute inset-0"
        style={{
          borderRadius: props.radius ?? 999,
          borderCurve: "continuous",
          backgroundColor: look().glassTint,
          pointerEvents: "none",
        }}
      />
    </If>
  );
}

/**
 * The bottom scroll edge, under controls floating on glass at the foot of a
 * page: TopEdge's progressive blur, easing off upwards. The rows stay faintly
 * visible under the glass, which is what lets it read as glass; an opaque
 * fade leaves it nothing to bend.
 */
export function BottomEdge(props: { height: number }) {
  return (
    <View
      class="absolute right-0 bottom-0 left-0"
      style={{
        height: props.height,
        backgroundColor: `${look().paper}99`,
        backdropFilter: "blur(10px)",
        maskImage: "linear-gradient(to top, #000 0%, #000 45%, #0000 100%)",
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * The scroll edge under a transparent system header (iOS 26's look): the
 * page blurs out under the bar's glass buttons so its title stays legible.
 * Place it last in a page whose `NavPage` has `headerTransparent`.
 */
export function TopEdge(props: {
  /** The page has a large title: blur only under the bar, not over the title. */
  largeTitle?: boolean;
}) {
  // A transparent header leaves the page's inset at the status bar: add the
  // bar's own height (54 points on iOS 26) and room for the fade.
  const insets = safeAreaInsets();
  return (
    <View
      class="absolute top-0 right-0 left-0"
      style={{
        height:
          (props.largeTitle ? safeArea().top + 54 : Math.max(insets().top, safeArea().top + 54)) +
          26,
        // A progressive blur, as the system's scroll edge effect: the page
        // under the bar is blurred and washed with paper, easing off below it.
        backgroundColor: `${look().paper}b3`,
        backdropFilter: "blur(10px)",
        maskImage: "linear-gradient(to bottom, #000 0%, #000 72%, #0000 100%)",
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * Toolbar buttons that belong together, on one capsule of Liquid Glass, as
 * macOS 26 and iOS 26 group a toolbar's items.
 */
export function GlassGroup(props: {
  children: JSX.Element;
  testID?: string;
  /** A round button on its own: the capsule as wide as it is tall. */
  round?: boolean;
  style?: ViewStyle;
}) {
  return (
    <View
      testID={props.testID}
      class={
        props.round
          ? "h-10 w-10 items-center justify-center rounded-full"
          : "h-10 flex-row items-center gap-0.5 rounded-full px-1"
      }
      style={{ ...glass(), borderCurve: "continuous", ...props.style }}
    >
      <GlassTint />
      {props.children}
    </View>
  );
}

/**
 * A round button of glass on its own (+ beside the search, Back): the
 * system's glass button where there is one (`native.tsx`), whose glass
 * answers the touch; elsewhere the app's capsule with its icon.
 */
export function RoundGlassButton(props: {
  name: SymbolIcon & IconName;
  label: string;
  onPress?: (e?: PressEvent) => void;
  /** The button's width and height (40 by default). */
  diameter?: number;
  /** The icon's size. */
  size?: number;
  color?: string;
  /** The primary action: glass filled with `color`, the symbol in white. */
  prominent?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const d = props.diameter ?? 40;
  return (
    <If
      when={nativeControls}
      else={
        <GlassGroup round testID={undefined} style={{ width: d, height: d }}>
          <IconButton
            name={props.name}
            label={props.label}
            testID={props.testID}
            size={props.size}
            color={props.color}
            disabled={props.disabled}
            onPress={props.onPress}
          />
        </GlassGroup>
      }
    >
      <SystemGlassButton
        icon={props.name}
        label={props.label}
        testID={props.testID}
        tint={props.color}
        prominent={props.prominent}
        // SF Symbols draw larger than the app's icons at the same size.
        size={Math.round((props.size ?? 17) * 0.85)}
        weight="medium"
        disabled={props.disabled}
        onPress={props.onPress}
        style={{ width: d, height: d }}
      />
    </If>
  );
}

/** A labelled button on glass ("Open in browser"), or filled with the accent when `prominent`. */
export function GlassButton(props: {
  label: string;
  onPress: () => void;
  prominent?: boolean;
  testID?: string;
}) {
  if (nativeControls) {
    return (
      <SystemGlassButton
        title={props.label}
        label={props.label}
        prominent={props.prominent}
        tint={props.prominent ? look().stamp : look().ink}
        testID={props.testID}
        onPress={props.onPress}
      />
    );
  }
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      class="h-10 items-center justify-center rounded-full px-5 active:opacity-70"
      style={
        props.prominent
          ? { backgroundColor: look().stamp, boxShadow: look().glassShadow }
          : { ...glass(), borderCurve: "continuous" }
      }
    >
      <If when={!props.prominent}>
        <GlassTint />
      </If>
      <Text
        style={{
          color: props.prominent ? "#fff" : look().ink,
          fontSize: 14,
          fontWeight: "600",
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}

const monogramColors = ["#b4654a", "#5f7f6a", "#5b6f93", "#8a6a9a", "#a5803f", "#6b7d7d"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** The site's icon, or its initial on a color picked from the domain. */
export function Favicon(props: { url: string | null; domain: string; size?: number }) {
  const size = props.size ?? 14;
  // Rows are recycled: remember which URL failed, not just that one did.
  const failedUrl = signal<string | null>(null);
  const color = () => monogramColors[hash(props.domain) % monogramColors.length];
  return (
    <If
      when={props.url && failedUrl() !== props.url}
      else={
        <View
          class="items-center justify-center"
          style={{ width: size, height: size, borderRadius: size / 4, backgroundColor: color() }}
        >
          <Text
            style={{ color: "#fff", fontSize: size * 0.62, fontWeight: "700", lineHeight: size }}
          >
            {(props.domain.replace(/^www\./, "")[0] ?? "?").toUpperCase()}
          </Text>
        </View>
      }
    >
      <Image
        src={props.url ?? ""}
        onError={() => failedUrl.set(props.url)}
        style={{ width: size, height: size, borderRadius: size / 4 }}
      />
    </If>
  );
}
