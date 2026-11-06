/**
 * A page's cover image or favicon as an absolute http(s) URL. Pages write
 * them relative to themselves (`/favicon.ico`, `../../favicon.ico`) or as
 * protocol-relative URLs; clients can't load those, and `data:` stubs
 * (`data:;base64,=`, a common way to suppress the favicon request) aren't
 * images worth keeping.
 */
export function assetUrl(raw: string | null | undefined, pageUrl: string): string | null {
  const s = raw?.trim();
  if (!s) return null;
  try {
    const u = new URL(s, pageUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.href;
  } catch {
    return null;
  }
}
