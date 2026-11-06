import { Controls } from "lofu/native";
import { nativeComponent, type PressEvent, platform, View, type ViewStyle } from "nsh";
import { hasGlass } from "../lib/look";

/**
 * The system's own Liquid Glass controls (`src/controls.rs`): `UIButton`
 * with a glass configuration and `UISearchTextField` on interactive glass
 * on iOS 26, `NSButton` with the glass bezel and `NSSearchField` on macOS
 * 26. nsh's `glassEffect` draws the material, but not how the system's
 * controls answer a touch (the glass swells and lights up under the
 * finger), nor the system's field. Elsewhere, and in headless tests, the
 * app's own controls stand in (`ui.tsx`, `SearchField.tsx`).
 */
export const nativeControls = hasGlass && Controls.available();

/**
 * The system's search field: iOS only. On macOS, nsh 0.4 never hands a
 * click to a component's own view, so `NSSearchField` couldn't be clicked
 * into; the app's field stands in there.
 */
export const nativeSearchField = nativeControls && platform.os === "ios";

/**
 * nsh 0.4's macOS backend loses a click on a native component's own view:
 * its picking finds the hosted view, but the root's `hitTest:` doesn't hand
 * it the event, and the root then drops it as the hosted view's. Clicks on
 * the app's own views are delivered, so buttons there take them through a
 * clear view laid over them.
 */
const pressThrough = platform.os === "macos";

/** The SF Symbol for each of the app's icons that a glass button shows. */
export const symbols = {
  back: "chevron.left",
  close: "xmark",
  external: "safari",
  forward: "chevron.right",
  more: "ellipsis",
  plus: "plus",
  refresh: "arrow.clockwise",
  search: "magnifyingglass",
  settings: "gearshape",
  share: "square.and.arrow.up",
  star: "star",
  starFill: "star.fill",
  trash: "trash",
} as const;
export type SymbolIcon = keyof typeof symbols;

const NativeGlassButton = nativeComponent<
  {
    symbol?: string;
    title?: string;
    variant?: "glass" | "prominent" | "clear" | "plain";
    tint?: string;
    size?: number;
    weight?: "regular" | "medium" | "semibold" | "bold";
    label?: string;
    disabled?: boolean;
  },
  { tap: { x: number; y: number } }
>("lofu.glassButton", {
  props: ["symbol", "title", "variant", "tint", "size", "weight", "label", "disabled"],
  events: ["tap"],
});

/**
 * A system glass button: an SF Symbol (`icon`), a `title`, or both.
 * `prominent` fills it with `tint`. Only where `nativeControls` is true.
 */
export function SystemGlassButton(props: {
  icon?: SymbolIcon;
  title?: string;
  label: string;
  onPress?: (e?: PressEvent) => void;
  prominent?: boolean;
  tint?: string;
  /** The symbol's point size. */
  size?: number;
  weight?: "regular" | "medium" | "semibold" | "bold";
  disabled?: boolean;
  testID?: string;
  style?: ViewStyle;
}) {
  const button = (overlaid: boolean) => (
    <NativeGlassButton
      testID={overlaid ? undefined : props.testID}
      accessibilityLabel={props.label}
      role="button"
      symbol={props.icon ? symbols[props.icon] : undefined}
      title={props.title}
      variant={props.prominent ? "prominent" : "glass"}
      tint={props.tint}
      size={props.size}
      weight={props.weight}
      label={props.label}
      disabled={props.disabled ?? false}
      style={overlaid ? undefined : props.style}
      class={overlaid ? "flex-1" : undefined}
      onTap={(at) => props.onPress?.({ pagePosition: at } as PressEvent)}
    />
  );
  if (!pressThrough) return button(false);
  // macOS: a click on a component's own view is lost (see `pressThrough`),
  // so a clear view of the app's lies over the button and takes it. The
  // button itself still answers VoiceOver and the keyboard.
  return (
    <View style={props.style}>
      {button(true)}
      <View
        testID={props.testID}
        accessibilityElementsHidden
        class="absolute inset-0 rounded-full"
        onPress={props.disabled ? undefined : (e) => props.onPress?.(e)}
      />
    </View>
  );
}

/** What the native search field sends: the text as it is now. */
type FieldEvent = { value: string };

export const NativeSearchField = nativeComponent<
  {
    value?: string;
    placeholder?: string;
    fontSize?: number;
    tint?: string;
    textColor?: string;
    glassTint?: string;
    label?: string;
    autoFocus?: boolean;
  },
  { change: FieldEvent; submit: FieldEvent; editing: { focused: boolean } }
>("lofu.searchField", {
  props: [
    "value",
    "placeholder",
    "fontSize",
    "tint",
    "textColor",
    "glassTint",
    "label",
    "autoFocus",
  ],
  events: ["change", "submit", "editing"],
});
