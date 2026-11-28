/**
 * URL normalization used as the dedupe key for bookmarks.
 *
 * The original URL is always stored as-is; this key only decides whether two
 * URLs refer to "the same" bookmark. It is deliberately conservative: it never
 * touches path case or trailing slashes, since servers may treat those as
 * distinct resources.
 */

const TRACKING_PARAM_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_", "__hs", "_hs"];
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "oly_anon_id",
  "oly_enc_id",
  "vero_id",
  "wickedid",
  "rb_clickid",
  "s_cid",
  "ref_src",
  "ref_url",
  "spm",
  "scm",
]);

/** Hosts where a param that looks like tracking is actually meaningful. */
const PARAM_ALLOWLIST_BY_HOST: Record<string, Set<string>> = {};

/** Hosts whose share links add a session param that never changes the content. */
const HOST_SPECIFIC_TRACKING: Record<string, Set<string>> = {
  "youtube.com": new Set(["si", "feature", "pp"]),
  "youtu.be": new Set(["si", "feature"]),
  "open.spotify.com": new Set(["si"]),
  "twitter.com": new Set(["s", "t"]),
  "x.com": new Set(["s", "t"]),
  "instagram.com": new Set(["igsh", "utm_source"]),
  "linkedin.com": new Set(["trk", "trackingId", "lipi"]),
};

function isTrackingParam(host: string, key: string): boolean {
  if (PARAM_ALLOWLIST_BY_HOST[host]?.has(key)) return false;
  if (TRACKING_PARAMS.has(key)) return true;
  if (HOST_SPECIFIC_TRACKING[host]?.has(key)) return true;
  for (const p of TRACKING_PARAM_PREFIXES) if (key.startsWith(p)) return true;
  return false;
}

/** Returns a canonical dedupe key, or throws on a non-http(s) / unparsable URL. */
export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }

  // Scheme is folded: http and https of the same page are one bookmark.
  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.startsWith("m.") && host.split(".").length > 2) host = host.slice(2);
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";

  const kept: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (!isTrackingParam(host, k)) kept.push([k, v]);
  }
  kept.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";

  // Fragments are dropped, except hash-routed SPAs (#/ and #!) where they are the route.
  const hash = url.hash.startsWith("#/") || url.hash.startsWith("#!") ? url.hash : "";

  const path = url.pathname === "/" ? "" : url.pathname;
  return `${host}${port}${path}${query}${hash}`;
}

export function domainOf(input: string): string {
  const host = new URL(input).hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * The site a user typed, as `domainOf` writes a bookmark's domain: a bare
 * host, lowercase, without `www.`. Accepts a whole address
 * (`https://www.example.com/a`) as well as `example.com` or `*.example.com`.
 * Null when it isn't a host name.
 */
export function siteDomain(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^\*\./, "");
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  // A name of labels (IDNs arrive as punycode), or an IP address.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) || /^\[[0-9a-f:.]+\]$/.test(host) ? host : null;
}

/** Whether `domain` (a bookmark's) is one of `sites` or under one of them (`m.x.com` is under `x.com`). */
export function onSite(domain: string, sites: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return sites.some((s) => d === s || d.endsWith(`.${s}`));
}
