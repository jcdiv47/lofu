import type { SiteAdapter } from "./types.ts";

/**
 * Zhihu answers, questions and columns (zhuanlan). Every server-side route
 * (page, `appview`, `api/v4`) answers 403 "请求存在异常" without a logged-in
 * session, and headless Chromium gets the same wall, so skip the browser and
 * say what works instead. Pages saved by the extension extract normally.
 */
export const zhihu: SiteAdapter = {
  name: "zhihu",
  hosts: ["zhihu.com"],
  noBrowser: "Zhihu needs a login: save it from your browser with the extension",
};
