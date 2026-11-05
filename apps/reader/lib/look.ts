import { colorScheme } from "nsh";

/**
 * The catalog-card palette shared with the browser extension: warm paper,
 * iron-gall ink, a red stamp, highlighter yellow.
 */
const light = {
  paper: "#f3ece0",
  paperDeep: "#e9e0d0",
  ink: "#1f1b16",
  inkSoft: "#5d554a",
  inkFaint: "#9a9081",
  rule: "#d8cdbb",
  stamp: "#c2412d",
  highlight: "#f2d37a",
  /** Decorations take classes, not inline styles (nsh ignores a decoration's `style`). */
  highlightClass: "bg-[#f2d37a] rounded-sm",
};
const dark: typeof light = {
  paper: "#1b1915",
  paperDeep: "#24211c",
  ink: "#ece4d6",
  inkSoft: "#b3a998",
  inkFaint: "#7a7264",
  rule: "#39332b",
  stamp: "#f0694f",
  highlight: "#6e5a24",
  highlightClass: "bg-[#6e5a24] rounded-sm",
};

/** Reactive: read inside JSX or a computed so it follows the system appearance. */
export const look = () => (colorScheme() === "dark" ? dark : light);
