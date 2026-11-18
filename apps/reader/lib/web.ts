/**
 * Whether a web view's error is only the page trying to leave the web: a
 * navigation to another app's scheme (`zhihu://articles/…`, `intent:`,
 * `weixin://`…), which nsh refuses as outside the `webview` capability.
 * Mobile pages do this to hand the reader to their app (Zhihu's columns
 * on iOS do it as they load). The navigation is cancelled and the page
 * that asked stays, so it isn't a page that failed to load.
 */
export function isAppLinkRefusal(e: { message: string; code?: string }): boolean {
  if (e.code !== "ERR_ACCESS_DENIED") return false;
  const url = /^navigation to (\S+)/.exec(e.message)?.[1];
  if (!url) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return scheme != null && scheme !== "http" && scheme !== "https";
}
