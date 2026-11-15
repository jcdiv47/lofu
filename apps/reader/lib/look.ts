import { colorScheme, platform } from "nsh";

/**
 * The catalog-card palette shared with the browser extension: warm paper,
 * iron-gall ink, a red stamp, highlighter yellow. Surfaces step from the
 * sidebar (deepest) through the page to the cards (lightest in light mode,
 * raised in dark mode).
 */
const light = {
  paper: "#f3ece0",
  paperDeep: "#e9e0d0",
  sidebar: "#ebe3d5",
  card: "#fbf8f2",
  cardHover: "#fffdf9",
  field: "#e4dbca",
  selected: "#ddd2bf",
  ink: "#1f1b16",
  inkSoft: "#5d554a",
  inkFaint: "#968c7d",
  rule: "#d8cdbb",
  ruleSoft: "#e3dacb",
  stamp: "#c2412d",
  stampSoft: "#c2412d1f",
  favorite: "#d4952a",
  highlight: "#f2d37a",
  /** Decorations take classes, not inline styles (nsh ignores a decoration's `style`). */
  highlightClass: "bg-[#f2d37a] rounded-sm",
  shadow: "0px 1px 2px rgb(60 45 25 / 0.08), 0px 4px 14px rgb(60 45 25 / 0.06)",
  shadowLift: "0px 2px 4px rgb(60 45 25 / 0.08), 0px 12px 28px rgb(60 45 25 / 0.12)",
  /** Liquid Glass: the paper's tint over the material, and the blur it falls back to. */
  glassTint: "#efe6d673",
  glassFallback: "#f3ece0d9",
  glassEdge: "#ffffff80",
  glassShadow: "0px 1px 1px rgb(60 45 25 / 0.06), 0px 6px 22px rgb(60 45 25 / 0.12)",
  /** A dialog's tint: enough of the paper over the glass that its text reads over any page. */
  sheetTint: "#f3ece0b8",
  /** Settings' groups of rows on the glass, their rules, and the fields and pop-ups in them. */
  groupFill: "#ffffffa6",
  groupEdge: "#3c2d1914",
  control: "#ffffffb8",
  /** The scroll edge under floating bars: the page fading out under the glass. */
  edgeFade:
    "linear-gradient(to bottom, rgb(243 236 224 / 1) 0%, rgb(243 236 224 / 0.97) 62%, rgb(243 236 224 / 0) 100%)",
};
const dark: typeof light = {
  paper: "#1b1915",
  paperDeep: "#24211c",
  sidebar: "#161411",
  card: "#24211c",
  cardHover: "#2a2620",
  field: "#2a2620",
  selected: "#332e27",
  ink: "#ece4d6",
  inkSoft: "#b3a998",
  inkFaint: "#7d7567",
  rule: "#39332b",
  ruleSoft: "#2e2a24",
  stamp: "#f0694f",
  stampSoft: "#f0694f24",
  favorite: "#e8b04a",
  highlight: "#6e5a24",
  highlightClass: "bg-[#6e5a24] rounded-sm",
  shadow: "0px 1px 2px rgb(0 0 0 / 0.3)",
  shadowLift: "0px 2px 4px rgb(0 0 0 / 0.3), 0px 12px 28px rgb(0 0 0 / 0.35)",
  glassTint: "#4a443bb3",
  glassFallback: "#2f2b25e6",
  glassEdge: "#ffffff1f",
  glassShadow: "0px 1px 1px rgb(0 0 0 / 0.25), 0px 8px 24px rgb(0 0 0 / 0.35)",
  sheetTint: "#1f1c18c4",
  groupFill: "#ffffff12",
  groupEdge: "#ffffff14",
  control: "#ffffff17",
  edgeFade:
    "linear-gradient(to bottom, rgb(27 25 21 / 1) 0%, rgb(27 25 21 / 0.97) 62%, rgb(27 25 21 / 0) 100%)",
};

/** Liquid Glass is drawn on iOS and macOS 26 and later; elsewhere the blur stands in. */
export const hasGlass = (() => {
  if (platform.os !== "ios" && platform.os !== "macos") return false;
  const major = Number.parseInt(String(platform.version ?? "0"), 10);
  return Number.isFinite(major) && major >= 26;
})();

/**
 * Whether views blur what's behind them (`backdropFilter`). Not on Android:
 * nsh 0.5.0 draws it there from a bitmap of the page, uploaded again each
 * frame anything under it moves, and a page transition dropped to ~15 fps on
 * a Nothing Phone (2). There a more opaque paper stands in.
 */
export const backdropBlur = platform.os !== "android";

/**
 * A glass surface: the system's material where there is one, and a blurred,
 * mostly opaque paper where there isn't (the web, older systems), which keeps
 * text over it readable. The system's glass ignores the view's background
 * color, so a glass view tints itself with a `GlassTint` child, which keeps
 * it in the paper's palette. Reactive (reads `look()`).
 */
export const glass = (opts?: { shadow?: boolean; edge?: boolean }) => ({
  glassEffect: "regular" as const,
  backdropFilter: backdropBlur ? "blur(24px) saturate(160%)" : undefined,
  backgroundColor: hasGlass ? undefined : look().glassFallback,
  borderWidth: opts?.edge === false || hasGlass ? 0 : 1,
  borderColor: look().glassEdge,
  boxShadow: opts?.shadow === false ? undefined : look().glassShadow,
});

/** The ink of both appearances (formula pictures are kept in each). */
export const inks = [light.ink, dark.ink];

/** Reactive: read inside JSX or a computed so it follows the system appearance. */
export const look = () => (colorScheme() === "dark" ? dark : light);

/** The system font for the interface; serif for reading and the wordmark. */
export const fonts = {
  ui: undefined,
  serif: "ui-serif, serif",
  mono: "ui-monospace, 'SF Mono', monospace",
};
