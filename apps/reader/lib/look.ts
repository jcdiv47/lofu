import { colorScheme } from "nsh";

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
};

/** Reactive: read inside JSX or a computed so it follows the system appearance. */
export const look = () => (colorScheme() === "dark" ? dark : light);

/** The system font for the interface; serif for reading and the wordmark. */
export const fonts = {
  ui: undefined,
  serif: "ui-serif, serif",
  mono: "ui-monospace, 'SF Mono', monospace",
};
