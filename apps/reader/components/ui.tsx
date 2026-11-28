import {
  Image,
  type JSX,
  type PressEvent,
  safeArea,
  safeAreaInsets,
  signal,
  Text,
  View,
  type ViewRef,
  type ViewStyle,
} from "nsh";
import { Button } from "nsh/base";
import alertIcon from "../assets/icons/alert.svg";
import allIcon from "../assets/icons/all.svg";
import articleIcon from "../assets/icons/article.svg";
import audioIcon from "../assets/icons/audio.svg";
import backIcon from "../assets/icons/back.svg";
import calendarIcon from "../assets/icons/calendar.svg";
import checkIcon from "../assets/icons/check.svg";
import chevronIcon from "../assets/icons/chevron.svg";
import chevronDownIcon from "../assets/icons/chevron-down.svg";
import clockIcon from "../assets/icons/clock.svg";
import closeIcon from "../assets/icons/close.svg";
import collapseIcon from "../assets/icons/collapse.svg";
import compassIcon from "../assets/icons/compass.svg";
import documentIcon from "../assets/icons/document.svg";
import expandIcon from "../assets/icons/expand.svg";
import filterIcon from "../assets/icons/filter.svg";
import folderIcon from "../assets/icons/folder.svg";
import forwardIcon from "../assets/icons/forward.svg";
import globeIcon from "../assets/icons/globe.svg";
import gridIcon from "../assets/icons/grid.svg";
import hashIcon from "../assets/icons/hash.svg";
import headlinesIcon from "../assets/icons/headlines.svg";
import highlighterIcon from "../assets/icons/highlighter.svg";
import imageIcon from "../assets/icons/image.svg";
import inboxIcon from "../assets/icons/inbox.svg";
import infoIcon from "../assets/icons/info.svg";
import linkIcon from "../assets/icons/link.svg";
import listIcon from "../assets/icons/list.svg";
import minusIcon from "../assets/icons/minus.svg";
import moodboardIcon from "../assets/icons/moodboard.svg";
import moreIcon from "../assets/icons/more.svg";
import noteIcon from "../assets/icons/note.svg";
import pencilIcon from "../assets/icons/pencil.svg";
import plusIcon from "../assets/icons/plus.svg";
import refreshIcon from "../assets/icons/refresh.svg";
import restoreIcon from "../assets/icons/restore.svg";
import returnIcon from "../assets/icons/return.svg";
import searchIcon from "../assets/icons/search.svg";
import settingsIcon from "../assets/icons/settings.svg";
import shareIcon from "../assets/icons/share.svg";
import slidersIcon from "../assets/icons/sliders.svg";
import sortIcon from "../assets/icons/sort.svg";
import sortAzIcon from "../assets/icons/sort-az.svg";
import sortZaIcon from "../assets/icons/sort-za.svg";
import starIcon from "../assets/icons/star.svg";
import starFillIcon from "../assets/icons/star-fill.svg";
import trashIcon from "../assets/icons/trash.svg";
import upDownIcon from "../assets/icons/updown.svg";
import videoIcon from "../assets/icons/video.svg";
import windowIcon from "../assets/icons/window.svg";
import { backdropBlur, glass, hasGlass, look, monogramColors } from "../lib/look";
import { offline, outbox, syncError, syncing } from "../lib/store";
import {
  nativeControls,
  nativeScrollEdges,
  ScrollEdge,
  type SymbolIcon,
  SystemGlassButton,
} from "./native";

export const icons = {
  article: articleIcon,
  audio: audioIcon,
  check: checkIcon,
  chevronDown: chevronDownIcon,
  /** A pop-up button's arrows. */
  upDown: upDownIcon,
  collapse: collapseIcon,
  document: documentIcon,
  expand: expandIcon,
  image: imageIcon,
  sort: sortIcon,
  sortAz: sortAzIcon,
  sortZa: sortZaIcon,
  /** A site (a browser window). */
  window: windowIcon,
  headlines: headlinesIcon,
  moodboard: moodboardIcon,
  video: videoIcon,
  alert: alertIcon,
  calendar: calendarIcon,
  filter: filterIcon,
  info: infoIcon,
  note: noteIcon,
  sliders: slidersIcon,
  enter: returnIcon,
  all: allIcon,
  back: backIcon,
  chevron: chevronIcon,
  clock: clockIcon,
  close: closeIcon,
  /** The system's browser (Safari's compass). */
  compass: compassIcon,
  folder: folderIcon,
  forward: forwardIcon,
  /** The original page, shown in the app. */
  globe: globeIcon,
  grid: gridIcon,
  hash: hashIcon,
  highlighter: highlighterIcon,
  inbox: inboxIcon,
  link: linkIcon,
  list: listIcon,
  minus: minusIcon,
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

/**
 * The keyboard's ring (`focus-visible:`: not after a click or a tap), on every
 * control of the app's that takes the focus.
 */
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp";

/**
 * A one-color icon, tinted to follow the theme: a token's `tint-*` class
 * (`tint-ink-soft` by default), or `color` for a data color (a collection's).
 */
export function Icon(props: { name: IconName; size?: number; color?: string; class?: string }) {
  const size = props.size ?? 16;
  return (
    <Image
      src={icons[props.name]}
      class={props.class ?? "tint-ink-soft"}
      style={
        props.color
          ? { width: size, height: size, tintColor: props.color }
          : { width: size, height: size }
      }
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
  /** The icon's tint, as a token's `tint-*` class. */
  iconClass?: string;
  size?: number;
  testID?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled, selected: !!props.active }}
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      class={`h-8 w-8 items-center justify-center rounded-full hover:bg-selected active:opacity-60 ${focusRing} ${
        props.active ? "bg-selected" : ""
      } ${props.disabled ? "opacity-35" : ""}`}
    >
      <Icon name={props.name} size={props.size ?? 17} color={props.color} class={props.iconClass} />
    </View>
  );
}

/**
 * The app's text buttons: `primary` (ink filled: Save, Connect), `secondary`
 * (a capsule on the glass of Settings' groups), `destructive` (that capsule,
 * its title red) and `cancel` (text only).
 */
export function ActionButton(props: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "destructive" | "cancel";
  /** Its action runs: screen readers say so, and it shows dimmed. */
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
  ref?: (r: ViewRef) => void;
}) {
  const variant = () => props.variant ?? "primary";
  const box = () => {
    switch (variant()) {
      case "primary":
        return "rounded-full bg-ink px-5 py-2.5 active:opacity-70";
      case "secondary":
      case "destructive":
        return "rounded-full border border-group-edge bg-control px-4 py-2 active:opacity-60";
      default:
        return "rounded-full px-4 py-2.5 active:opacity-60";
    }
  };
  return (
    <Button
      ref={props.ref}
      testID={props.testID}
      accessibilityLabel={props.label}
      busy={props.busy}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`${box()} ${focusRing} disabled:opacity-50 ${props.busy ? "opacity-60" : ""}`}
    >
      <Text
        class={
          variant() === "primary"
            ? "text-paper"
            : variant() === "secondary"
              ? "text-ink"
              : variant() === "destructive"
                ? "text-stamp"
                : "text-ink-soft"
        }
        style={{
          fontSize: variant() === "secondary" || variant() === "destructive" ? 13.5 : 14.5,
          fontWeight: variant() === "primary" ? "600" : "500",
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

/** A form's text field: on the card, ruled, in the theme's ink (`<Input class={fieldClass}>`). */
export const fieldClass =
  "rounded-xl border border-rule bg-card px-3.5 text-ink placeholder:text-ink-faint";

/** A form field's label, over it. */
export function FieldLabel(props: { text: string }) {
  return (
    <Text class="text-ink-soft" style={{ fontSize: 12.5, fontWeight: "600" }}>
      {props.text}
    </Text>
  );
}

/** What went wrong, under a form. */
export function ErrorText(props: { text: string; testID?: string }) {
  return (
    <Text testID={props.testID} class="text-stamp" style={{ fontSize: 13.5, lineHeight: 19 }}>
      {props.text}
    </Text>
  );
}

/**
 * The surface of the app's drawn popups (the web's menus, the search box's
 * suggestions): the raised card, ruled, with a lifted shadow. Reactive
 * (the shadow reads `look()`).
 */
export const popupSurface = () => ({
  popupClass: `rounded-xl border border-rule bg-card-hover p-1.5 transition duration-100 ease-out motion-reduce:transition-none`,
  popupStyle: { boxShadow: look().popupShadow },
  popupStartingClass: "opacity-0 scale-95",
  popupEndingClass: "opacity-0",
});

/**
 * The sync line: a dot (red offline or failing, amber sending or syncing,
 * green up to date) and what it says (`syncStatus`).
 */
export function SyncStatus(props: { size?: "small" | "regular"; class?: string }) {
  const regular = () => props.size === "regular";
  const tone = () =>
    syncError() || offline() ? "bg-stamp" : syncing() || outbox().length ? "bg-favorite" : "bg-ok";
  return (
    <View class={`flex-row items-center ${regular() ? "gap-1.5" : "gap-2"} ${props.class ?? ""}`}>
      <View class={`rounded-full ${tone()}`} style={{ width: 7, height: 7 }} />
      <Text class="flex-1 truncate text-ink-faint" style={{ fontSize: regular() ? 13 : 12 }}>
        {syncStatus()}
      </Text>
    </View>
  );
}

/** The sync line's words: phones' Library page and the desktop's sidebar say the same. */
export const syncStatus = () => {
  const waiting = outbox().length;
  const pending = waiting ? ` · ${waiting} change${waiting === 1 ? "" : "s"} waiting` : "";
  if (offline()) return `Offline${pending}`;
  if (syncError()) return syncError();
  if (syncing()) return "Syncing…";
  return waiting ? `Sending${pending}` : "Up to date";
};

/**
 * The paper's tint over the system's glass, as its first child (see `glass`).
 * A view of its own, not the glass's `glassTintColor`: the system tints the
 * material toward the color, which on macOS 26 came out grey and cool, where
 * the paper laid over it keeps the glass warm.
 */
export function GlassTint(props: { radius?: number; color?: string }) {
  return (
    <If when={hasGlass}>
      <View
        class={props.color ? "absolute inset-0" : "absolute inset-0 bg-glass-tint"}
        style={{
          borderRadius: props.radius ?? 999,
          borderCurve: "continuous",
          backgroundColor: props.color,
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
 *
 * Where UIKit draws the edge itself (`nativeScrollEdges`), this draws
 * nothing: the row of controls holds a `ScrollEdge edge="bottom"` instead.
 */
export function BottomEdge(props: { height: number }) {
  if (nativeScrollEdges) return null;
  return (
    <View
      class={`absolute right-0 bottom-0 left-0 ${backdropBlur ? "bg-paper/60" : "bg-paper/88"}`}
      style={{
        height: props.height,
        backdropFilter: backdropBlur ? "blur(10px)" : undefined,
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
  // iOS 26: the system's own edge, under the navigation bar.
  if (nativeScrollEdges) return <ScrollEdge edge="top" />;
  const insets = safeAreaInsets();
  return (
    <View
      // A progressive blur, as the system's scroll edge effect: the page
      // under the bar is blurred and washed with paper, easing off below it.
      class={`absolute top-0 right-0 left-0 ${backdropBlur ? "bg-paper/70" : "bg-paper/90"}`}
      style={{
        height:
          (props.largeTitle ? safeArea().top + 54 : Math.max(insets().top, safeArea().top + 54)) +
          26,
        backdropFilter: backdropBlur ? "blur(10px)" : undefined,
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
    <Button
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      class={`h-10 items-center justify-center rounded-full px-5 active:opacity-70 ${focusRing} ${
        props.prominent ? "bg-stamp" : ""
      }`}
      style={
        props.prominent
          ? { boxShadow: look().glassShadow }
          : { ...glass(), borderCurve: "continuous" }
      }
    >
      <If when={!props.prominent}>
        <GlassTint />
      </If>
      <Text
        class={props.prominent ? "text-on-fill" : "text-ink"}
        style={{ fontSize: 14, fontWeight: "600" }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

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
            class="text-on-fill"
            style={{ fontSize: size * 0.62, fontWeight: "700", lineHeight: size }}
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
