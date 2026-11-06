/** "3:43 PM" today, "Nov 4" this year, "Nov 4, 2024" before. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Minutes to read at ~230 words a minute (CJK counts as characters, which the server counts as words). */
export function readingTime(words: number | null): string {
  if (!words) return "";
  const min = Math.max(1, Math.round(words / 230));
  return `${min} min`;
}

/** Search snippets come with `<mark>` around hits; split them into runs. */
export function markRuns(snippet: string): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let at = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > at) runs.push({ text: snippet.slice(at, m.index), hit: false });
    runs.push({ text: m[1] ?? "", hit: true });
    at = m.index + m[0].length;
  }
  if (at < snippet.length) runs.push({ text: snippet.slice(at), hit: false });
  return runs.map((r) => ({ ...r, text: decodeEntities(r.text) }));
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => entities[e]);

/**
 * Excerpts saved before the server cleaned them can hold Markdown links and
 * escapes (`[\[email protected\]](…)`); show their text.
 */
export function plainExcerpt(s: string | null): string | null {
  if (!s) return s;
  return s
    .replace(/!\[(?:\\.|[^\]\\])*]\([^)]*\)/g, " ")
    .replace(/\[((?:\\.|[^\]\\])*)]\([^)]*\)/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
