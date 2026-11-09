/**
 * The search box's little language, as Raindrop's: words, plus conditions
 * that narrow by a bookmark's fields. The server turns the conditions into
 * filters (`apps/server/src/search/search.ts`); the app uses the same parse
 * for its suggestions and their counts. A `-` in front of a condition
 * excludes what it matches.
 *
 *   #tag  #"two words"     tagged so
 *   type:article           link, article, video, image, audio, document
 *   notag:true             without tags
 *   note:true              with a note
 *   highlights:true        with highlights
 *   favorite:true          a favorite
 *   created:2026-11-08     saved that day; 2026-11 a month, 2026 a year;
 *   created:<2026-11       before it, created:>2026-11 after it
 *   info:word              the word in the title or the description
 *   link:word              the word in the address
 *
 * Anything else is a word to search for (a `-word` excludes it, a "quoted
 * phrase" is matched whole). A condition that isn't finished (`#`, `type:`,
 * `type:nonsense`) narrows nothing, so typing one doesn't empty the results.
 */

/** The kinds of page (`BookmarkType` in schemas.ts, kept free of zod for the app). */
export const QUERY_TYPES = ["link", "article", "video", "image", "audio", "document"] as const;
export type QueryType = (typeof QUERY_TYPES)[number];

/** A `created:` date: a year, a month or a day, and whether before or after it. */
export interface DateSpec {
  op: "=" | "<" | ">";
  year: number;
  /** 1-12. */
  month?: number;
  day?: number;
}

export type Condition =
  | { kind: "tag"; tag: string }
  | { kind: "type"; type: QueryType }
  | { kind: "notag" }
  | { kind: "note" }
  | { kind: "highlights" }
  | { kind: "favorite" }
  | { kind: "created"; date: DateSpec }
  | { kind: "info"; text: string }
  | { kind: "link"; text: string };

export type Term = Condition & { not: boolean };

export interface ParsedQuery {
  /** The words to search for, as typed (`-word` and "phrases" kept for Meilisearch). */
  text: string;
  terms: Term[];
}

/** A token of the query and where it is (for replacing the one being typed). */
export interface Token {
  raw: string;
  start: number;
  end: number;
}

/** Splits at spaces outside quotes. An unclosed quote runs to the end. */
export function tokenize(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q.charAt(i))) i++;
    if (i >= q.length) break;
    const start = i;
    let quoted = false;
    while (i < q.length && (quoted || !/\s/.test(q.charAt(i)))) {
      if (q.charAt(i) === '"') quoted = !quoted;
      i++;
    }
    out.push({ raw: q.slice(start, i), start, end: i });
  }
  return out;
}

const unquote = (s: string) => {
  const t = s.startsWith('"') ? s.slice(1, s.endsWith('"') && s.length > 1 ? -1 : undefined) : s;
  return t.trim();
};

/** "2026", "2026-11", "2026-11-08", with `<` or `>` in front. */
export function parseDate(raw: string): DateSpec | null {
  const m = /^([<>]?)(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[2]);
  const month = m[3] ? Number(m[3]) : undefined;
  const day = m[4] ? Number(m[4]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && (day < 1 || day > 31)) return null;
  const op = (m[1] || "=") as DateSpec["op"];
  return { op, year, ...(month ? { month } : {}), ...(day ? { day } : {}) };
}

const truthy = (v: string) => (v === "true" ? true : v === "false" ? false : null);

/** One token as a condition, or null for a word (or an unfinished condition: see `pending`). */
export function parseCondition(raw: string): Term | null {
  const not = raw.startsWith("-") && raw.length > 1;
  const body = not ? raw.slice(1) : raw;
  if (body.startsWith("#")) {
    const tag = unquote(body.slice(1)).toLowerCase();
    return tag ? { kind: "tag", tag, not } : null;
  }
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  const key = body.slice(0, colon).toLowerCase();
  const value = unquote(body.slice(colon + 1));
  switch (key) {
    case "type": {
      const t = value.toLowerCase();
      return (QUERY_TYPES as readonly string[]).includes(t)
        ? { kind: "type", type: t as QueryType, not }
        : null;
    }
    case "notag":
    case "note":
    case "highlights":
    case "favorite": {
      const v = truthy(value.toLowerCase());
      if (v === null) return null;
      // `note:false` is `-note:true`.
      return { kind: key, not: v ? not : !not };
    }
    case "created": {
      const date = parseDate(value);
      return date ? { kind: "created", date, not } : null;
    }
    case "info":
    case "link":
      return value ? { kind: key, text: value, not } : null;
    default:
      return null;
  }
}

/** The keys a condition starts with; a token starting so is never a word. */
const KEYS = ["type", "notag", "note", "highlights", "favorite", "created", "info", "link"];

/** Whether a token is a condition being typed (`#`, `type:`, `created:<`) that narrows nothing yet. */
export function pending(raw: string): boolean {
  const body = raw.startsWith("-") ? raw.slice(1) : raw;
  if (body === "#" || body === '#"') return true;
  const colon = body.indexOf(":");
  return colon > 0 && KEYS.includes(body.slice(0, colon).toLowerCase()) && !parseCondition(raw);
}

export function parseQuery(q: string): ParsedQuery {
  const words: string[] = [];
  const terms: Term[] = [];
  for (const { raw } of tokenize(q)) {
    const term = parseCondition(raw);
    if (term) terms.push(term);
    else if (!pending(raw) && raw !== "-") words.push(raw);
  }
  return { text: words.join(" "), terms };
}

/** Whether a query asks for anything: words, or a finished condition. */
export const hasQuery = (q: string) => {
  const p = parseQuery(q);
  return p.text.length > 0 || p.terms.length > 0;
};

/**
 * The milliseconds a `created:` date covers, `[from, to)`, in the time zone
 * `offsetMinutes` east of UTC (+480 for Beijing, -300 for New York in
 * winter). `<` is everything before the period, `>` everything after it.
 */
export function dateRange(d: DateSpec, offsetMinutes = 0): { from?: number; to?: number } {
  const shift = offsetMinutes * 60_000;
  const start = Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1) - shift;
  const end =
    (d.day
      ? Date.UTC(d.year, (d.month ?? 1) - 1, d.day + 1)
      : d.month
        ? Date.UTC(d.year, d.month, 1)
        : Date.UTC(d.year + 1, 0, 1)) - shift;
  if (d.op === "<") return { to: start };
  if (d.op === ">") return { from: end };
  return { from: start, to: end };
}

/** What `matchesTerm` needs of a bookmark. */
export interface Matchable {
  url: string;
  title: string;
  excerpt: string | null;
  note: string | null;
  type: string;
  tags: string[];
  favorite: boolean;
  /** Milliseconds since 1970. */
  created: number;
  highlights: number;
}

const contains = (hay: string | null, needle: string) =>
  !!hay && hay.toLowerCase().includes(needle.toLowerCase());

/** Whether a bookmark meets a condition, as the server's filter decides it. */
export function matchesTerm(b: Matchable, t: Term, offsetMinutes = 0): boolean {
  let hit: boolean;
  switch (t.kind) {
    case "tag":
      hit = b.tags.includes(t.tag);
      break;
    case "type":
      hit = b.type === t.type;
      break;
    case "notag":
      hit = b.tags.length === 0;
      break;
    case "note":
      hit = !!b.note?.trim();
      break;
    case "highlights":
      hit = b.highlights > 0;
      break;
    case "favorite":
      hit = b.favorite;
      break;
    case "created": {
      const r = dateRange(t.date, offsetMinutes);
      hit =
        (r.from === undefined || b.created >= r.from) && (r.to === undefined || b.created < r.to);
      break;
    }
    case "info":
      hit = contains(b.title, t.text) || contains(b.excerpt, t.text);
      break;
    case "link":
      hit = contains(b.url, t.text);
      break;
  }
  return t.not ? !hit : hit;
}

/** A condition written back as the search box shows it. */
export function formatTerm(t: Term): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const not = t.not ? "-" : "";
  switch (t.kind) {
    case "tag":
      return `${not}#${quote(t.tag)}`;
    case "type":
      return `${not}type:${t.type}`;
    case "notag":
    case "note":
    case "highlights":
    case "favorite":
      return `${not}${t.kind}:true`;
    case "created": {
      const d = t.date;
      const pad = (n: number) => String(n).padStart(2, "0");
      const date = `${d.year}${d.month ? `-${pad(d.month)}` : ""}${d.day ? `-${pad(d.day)}` : ""}`;
      return `${not}created:${d.op === "=" ? "" : d.op}${date}`;
    }
    case "info":
    case "link":
      return `${not}${t.kind}:${quote(t.text)}`;
  }
}
