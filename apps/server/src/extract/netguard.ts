import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Keeps the server's own requests (page fetches, image probes, the image
 * proxy, short-link hops, the browser fallback) off private networks. A
 * saved page chooses what it redirects to and which images it holds, so
 * without this a bookmark could make the server send requests to the LAN it
 * runs on: the router, other services on the box, the tailnet, the Docker
 * network.
 *
 * Every hop is checked: redirects are followed here, one at a time, rather
 * than by `fetch`. A hostname must resolve only to public addresses. `fetch`
 * resolves the name again, so a DNS server that answers differently the
 * second time (rebinding) can still get one request through; that takes a
 * hostile DNS server and still yields only a blind GET.
 *
 * Off for tests and for setups that bookmark pages on their own network
 * (`LOFU_FETCH_PRIVATE=1`).
 */

let allowPrivate = false;

/** Lets requests reach private and loopback addresses (tests, LAN-only setups). */
export function allowPrivateNetworks(on: boolean) {
  allowPrivate = on;
}

export class BlockedAddressError extends Error {}

const MAX_REDIRECTS = 10;

/** IPv4 ranges that aren't the public internet (RFC 6890 and friends), as [network, prefix]. */
const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, and Tailscale's addresses
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

const v4Int = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

const V4_RANGES = PRIVATE_V4.map(([net, bits]) => {
  const size = 2 ** (32 - bits);
  const start = v4Int(net);
  return [start, start + size] as const;
});

function privateV4(ip: string): boolean {
  const n = v4Int(ip);
  return V4_RANGES.some(([start, end]) => n >= start && n < end);
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail becomes two). */
function v6Groups(ip: string): number[] {
  let s = ip.toLowerCase().split("%")[0]!;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4Int(tail[1]!);
    s = `${s.slice(0, tail.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(":").map((g) => Number.parseInt(g, 16)) : []);
  const a = parse(head);
  if (rest === undefined) return a;
  const b = parse(rest);
  return [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
}

function privateV6(ip: string): boolean {
  const g = v6Groups(ip);
  const v4 = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if (zeros(5) && g[5] === 0xffff) return privateV4(v4()); // ::ffff:a.b.c.d
  if (zeros(6)) return privateV4(v4()); // ::a.b.c.d (deprecated, compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return privateV4(v4()); // NAT64
  }
  if (g[0] === 0x2002) {
    // 6to4 carries an IPv4 address in its second and third groups.
    return privateV4(`${g[1]! >> 8}.${g[1]! & 255}.${g[2]! >> 8}.${g[2]! & 255}`);
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if (first >= 0xfe80 && first <= 0xfeff) return true; // link-local, old site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  return false;
}

/** Whether `ip` (v4 or v6) is outside the public internet. Not an IP at all counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v = isIP(bare.split("%")[0]!);
  if (v === 4) return privateV4(bare);
  if (v === 6) return privateV6(bare);
  return true;
}

/** Throws `BlockedAddressError` unless `url` is http(s) on a host with only public addresses. */
export async function assertPublicUrl(url: string | URL): Promise<void> {
  if (allowPrivate) return;
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedAddressError(`refusing to fetch ${u.protocol} URLs`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedAddressError(`refusing private address ${host}`);
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new BlockedAddressError(`refusing private address ${host}`);
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new BlockedAddressError(`refusing ${host}: it resolves to ${bad.address}`);
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `fetch` for addresses a saved page chose: every hop, redirects included,
 * must be on the public internet. `init.redirect` is ignored (redirects are
 * followed here); the response's `url` is the last hop's. `fetchFn` makes
 * one request (no redirects) and defaults to `fetch`.
 */
export async function publicFetch(
  url: string,
  init: RequestInit = {},
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  if (allowPrivate) return fetchFn(url, { ...init, redirect: "follow" });
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetchFn(current, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current).href;
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
}
