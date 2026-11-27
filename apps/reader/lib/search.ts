import { Storage, signal } from "nsh";
import {
  formatTerm,
  type Matchable,
  matchesTerm,
  parseQuery,
  pending,
  type Token,
  tokenize,
} from "../../../packages/shared/src/query";
import type { IconName } from "../components/ui";
import type { Bookmark } from "./api";
import { shortDate } from "./format";
import { glyphColors } from "./look";
import { timeFormat } from "./prefs";
import { type BookmarkType, highlightCount, type Source, typeTitles } from "./store";

/*
 * The search box's suggestions, as Raindrop's: with nothing typed, the
 * conditions that narrow the list (with how many each would leave) and the
 * recent searches; while a condition is typed (`#`, `type:`, `created:`),
 * its values; while a word is, a row that searches for it and the
 * collections and tags it names. The language itself is
 * packages/shared/src/query.ts, which the server understands too.
 */

/** Minutes east of UTC, for the server's `created:` days. */
export const tzOffset = () => -new Date().getTimezoneOffset();

export const asMatchable = (b: Bookmark): Matchable => ({
  url: b.url,
  title: b.title,
  excerpt: b.excerpt,
  note: b.note,
  type: b.type,
  tags: b.tags,
  favorite: b.favorite,
  created: Date.parse(b.createdAt),
  highlights: highlightCount(b.id),
});

/** The bookmarks of `list` that meet every condition of `q` (its words aside). */
export function narrowed(list: Bookmark[], q: string): Bookmark[] {
  const { terms } = parseQuery(q);
  if (!terms.length) return list;
  const tz = tzOffset();
  return list.filter((b) => {
    const m = asMatchable(b);
    return terms.every((t) => matchesTerm(m, t, tz));
  });
}

// ---------------------------------------------------------------------------
// Recent searches, kept on the device, the newest first.

export interface Recent {
  query: string;
  /** Milliseconds since 1970. */
  at: number;
}

const RECENT_KEY = "search.recent.v1";
const RECENT_MAX = 10;
export const recent = signal<Recent[]>([]);

void Storage.getItem(RECENT_KEY)
  .then((raw) => {
    if (!raw) return;
    const list = JSON.parse(raw) as Recent[];
    if (Array.isArray(list)) recent.set(list.filter((r) => typeof r?.query === "string"));
  })
  .catch(() => {});

/** Puts a search at the top of the recent ones. */
export function remember(query: string, now = Date.now()) {
  const q = query.trim();
  if (!q) return;
  const next = [{ query: q, at: now }, ...recent().filter((r) => r.query !== q)].slice(
    0,
    RECENT_MAX,
  );
  recent.set(next);
  void Storage.setItem(RECENT_KEY, JSON.stringify(next)).catch(() => {});
}

// ---------------------------------------------------------------------------
// The suggestions.

export type SuggestAction =
  /** Replaces the token being typed (or follows the query); `commit` searches. */
  | { kind: "replace"; text: string; commit: boolean }
  /** Adds a condition after the query. */
  | { kind: "append"; text: string; commit: boolean }
  /** Searches for this query. */
  | { kind: "query"; query: string }
  /** Searches for what's typed. */
  | { kind: "submit" }
  /** Opens a collection. */
  | { kind: "source"; source: Source };

export interface SuggestRow {
  key: string;
  icon: IconName;
  /** The icon's own color (Notes yellow, Highlights purple), else the text's. */
  tint?: string;
  label: string;
  /** On the right: a count, a time, where it is. */
  detail?: string;
  /** A row that runs with Return (`Search "…"`), drawn with ↵. */
  enter?: boolean;
  action: SuggestAction;
}

export interface SuggestSection {
  title?: string;
  /** A paragraph under the title (the date's format). */
  help?: string;
  rows: SuggestRow[];
}

export interface SuggestInput {
  /** The field's text. */
  query: string;
  /** `narrow`: the filter button's list, of what narrows the results shown. */
  mode: "suggest" | "narrow";
  /** The bookmarks the counts are of: the source's, or the results. */
  base: Bookmark[];
  collections: { id: string; name: string }[];
  recent: Recent[];
  now?: Date;
}

export const NOTE_TINT = glyphColors.note;
export const HIGHLIGHT_TINT = glyphColors.highlight;

export const TYPE_ICONS: Record<BookmarkType, IconName> = {
  link: "link",
  article: "article",
  video: "video",
  image: "image",
  audio: "audio",
  document: "document",
};

/** The token being typed: the last, unless a space follows it. */
export function typing(query: string): Token | null {
  if (!query || /\s$/.test(query)) return null;
  return tokenize(query).at(-1) ?? null;
}

/** The query once a suggestion's text is put in; a committed one ends with a space. */
export function applySuggestion(
  query: string,
  action: Extract<SuggestAction, { kind: "replace" | "append" }>,
): string {
  const t = action.kind === "replace" ? typing(query) : null;
  const tail = action.commit ? " " : "";
  if (t) return `${query.slice(0, t.start)}${action.text}${tail}${query.slice(t.end)}`;
  const lead = query.trim() ? `${query.trimEnd()} ` : "";
  return `${lead}${action.text}${tail}`;
}

const quoted = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

const tagCounts = (list: Bookmark[]) => {
  const c = new Map<string, number>();
  for (const b of list) for (const t of b.tags) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
};

const monthKey = (b: Bookmark) => {
  const d = new Date(b.createdAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const monthTitle = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

const recentRows = (list: Recent[], now: Date): SuggestRow[] =>
  list.map((r) => ({
    key: `recent:${r.query}`,
    icon: "search",
    label: r.query,
    detail: shortDate(new Date(r.at).toISOString(), now, timeFormat()),
    action: { kind: "query", query: r.query },
  }));

/** Raindrop's *Suggested* (or, for the filter button, *Narrow your search*) rows. */
function conditionRows(input: SuggestInput): SuggestRow[] {
  const { base, mode } = input;
  const narrowing = mode === "narrow";
  const words = parseQuery(input.query).text;
  const tags = tagCounts(base).size;
  const notes = base.filter((b) => !!b.note?.trim()).length;
  const highlights = base.filter((b) => highlightCount(b.id) > 0).length;
  const types = new Set(base.map((b) => b.type)).size;
  const months = new Set(base.map(monthKey)).size;
  const untagged = base.filter((b) => b.tags.length === 0).length;
  // `info:` and `link:` take the words typed, when there are some.
  const rest = parseQuery(input.query).terms.map(formatTerm).join(" ");
  const within = (kind: "info" | "link") => {
    if (!words)
      return { count: undefined, action: { kind: "append", text: `${kind}:`, commit: false } };
    const term = { kind, text: words, not: false } as const;
    const count = base.filter((b) => matchesTerm(asMatchable(b), term)).length;
    const query = `${rest ? `${rest} ` : ""}${kind}:${quoted(words)}`;
    return { count, action: { kind: "query", query } };
  };
  const info = within("info");
  const link = within("link");
  const rows: (SuggestRow & { count?: number })[] = [
    {
      key: "tag",
      icon: "hash",
      label: "Tag",
      count: tags,
      action: { kind: "append", text: "#", commit: false },
    },
    {
      key: "note",
      icon: "note",
      tint: NOTE_TINT,
      label: "Notes",
      count: notes,
      action: { kind: "append", text: "note:true", commit: true },
    },
    {
      key: "highlights",
      icon: "highlighter",
      tint: HIGHLIGHT_TINT,
      label: "Highlights",
      count: highlights,
      action: { kind: "append", text: "highlights:true", commit: true },
    },
    {
      key: "type",
      icon: "filter",
      label: "Type",
      count: types,
      action: { kind: "append", text: "type:", commit: false },
    },
    {
      key: "created",
      icon: "calendar",
      label: "Date of creation",
      count: months,
      action: { kind: "append", text: "created:", commit: false },
    },
    {
      key: "info",
      icon: "info",
      label: "In title/description",
      count: info.count,
      action: info.action as SuggestAction,
    },
    {
      key: "link",
      icon: "link",
      label: "In URL",
      count: link.count,
      action: link.action as SuggestAction,
    },
    {
      key: "notag",
      icon: "hash",
      label: "Without tags",
      count: untagged,
      action: { kind: "append", text: "notag:true", commit: true },
    },
  ];
  return rows
    .filter((r) => !narrowing || (r.count ?? 0) > 0 || r.key === "info" || r.key === "link")
    .filter((r) => !narrowing || words || (r.key !== "info" && r.key !== "link"))
    .map(({ count, ...r }) => ({
      ...r,
      ...(count === undefined ? {} : { detail: String(count) }),
    }));
}

/** What the dropdown under the search box shows. */
export function suggestions(input: SuggestInput): SuggestSection[] {
  const now = input.now ?? new Date();
  const tok = typing(input.query);
  if (input.mode === "narrow" || !tok) {
    const rows = conditionRows(input);
    const sections: SuggestSection[] = [
      { title: input.mode === "narrow" ? "Narrow your search" : "Suggested", rows },
    ];
    if (input.mode === "suggest" && !input.query.trim() && input.recent.length)
      sections.push({ title: "Recent", rows: recentRows(input.recent, now) });
    return sections;
  }

  const raw = tok.raw;
  const neg = raw.startsWith("-") && raw.length > 1 ? "-" : "";
  const body = neg ? raw.slice(1) : raw;
  const lower = body.toLowerCase();
  const matchingRecent = recentRows(
    input.recent.filter((r) => r.query.toLowerCase().includes(raw.toLowerCase())).slice(0, 5),
    now,
  );
  const withRecent = (s: SuggestSection): SuggestSection[] =>
    matchingRecent.length ? [s, { title: "Recent", rows: matchingRecent }] : [s];

  if (body.startsWith("#")) {
    const needle = body.slice(1).replace(/^"/, "").replace(/"$/, "").toLowerCase();
    const rows = [...tagCounts(input.base).entries()]
      .filter(([t]) => t.includes(needle))
      .sort(
        (a, b) =>
          Number(b[0].startsWith(needle)) - Number(a[0].startsWith(needle)) ||
          b[1] - a[1] ||
          a[0].localeCompare(b[0]),
      )
      .slice(0, 50)
      .map(
        ([t, n]): SuggestRow => ({
          key: `tag:${t}`,
          icon: "hash",
          label: t,
          detail: String(n),
          action: { kind: "replace", text: `${neg}#${quoted(t)}`, commit: true },
        }),
      );
    return withRecent({ title: "Narrow your search", rows });
  }

  if (lower.startsWith("type:")) {
    const value = lower.slice(5);
    const counts = new Map<BookmarkType, number>();
    for (const b of input.base) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
    const rows = [...counts.entries()]
      .filter(([t]) => t.startsWith(value) || typeTitles[t].toLowerCase().startsWith(value))
      .sort((a, b) => b[1] - a[1])
      .map(
        ([t, n]): SuggestRow => ({
          key: `type:${t}`,
          icon: TYPE_ICONS[t],
          label: typeTitles[t],
          detail: String(n),
          action: { kind: "replace", text: `${neg}type:${t}`, commit: true },
        }),
      );
    return withRecent({ title: "Narrow your search", rows });
  }

  if (lower.startsWith("created:")) {
    const value = body.slice(8);
    const op = /^[<>]/.test(value) ? value.charAt(0) : "";
    const typed = value.slice(op.length);
    const counts = new Map<string, number>();
    for (const b of input.base) counts.set(monthKey(b), (counts.get(monthKey(b)) ?? 0) + 1);
    const rows = [...counts.entries()]
      .filter(([m]) => m.startsWith(typed))
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(
        ([m, n]): SuggestRow => ({
          key: `created:${m}`,
          icon: "calendar",
          label: monthTitle(m),
          detail: String(n),
          action: { kind: "replace", text: `${neg}created:${op}${m}`, commit: true },
        }),
      );
    return [
      {
        help: "Search for a specific date in the format YYYY-MM-DD, a month (YYYY-MM) or a year (YYYY). Put < or > in front of a date to find what was saved before or after it.",
        rows,
      },
    ];
  }

  // `info:`, `link:` and the like take any words: nothing to pick from.
  if (pending(raw)) return withRecent({ rows: [] });

  // A word (or a finished condition): search for it, or for what it names.
  const word = lower.replace(/^"|"$/g, "");
  const search: SuggestRow = {
    key: "submit",
    icon: "search",
    label: `Search "${input.query.trim()}"`,
    enter: true,
    action: { kind: "submit" },
  };
  const isWord = !parseQuery(raw).terms.length && word.length > 0;
  const collections: SuggestRow[] = isWord
    ? input.collections
        .filter((c) => c.name.toLowerCase().includes(word))
        .slice(0, 5)
        .map((c) => ({
          key: `collection:${c.id}`,
          icon: "folder",
          label: c.name,
          detail: "My Collections",
          action: { kind: "source", source: { kind: "collection", id: c.id } },
        }))
    : [];
  const tags: SuggestRow[] = isWord
    ? [...tagCounts(input.base).entries()]
        .filter(([t]) => t.includes(word))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t, n]) => ({
          key: `tag:${t}`,
          icon: "hash",
          label: t,
          detail: String(n),
          action: { kind: "replace", text: `${neg}#${quoted(t)}`, commit: true },
        }))
    : [];
  return [
    { rows: [search] },
    ...(collections.length || tags.length ? [{ rows: [...collections, ...tags] }] : []),
  ];
}

/** Whether Return picks the first row (typing a condition's value or a word) rather than searching. */
export const firstRowIsDefault = (input: SuggestInput) =>
  input.mode === "suggest" && typing(input.query) !== null;
