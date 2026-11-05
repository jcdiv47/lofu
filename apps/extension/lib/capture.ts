import { browser } from "wxt/browser";

/** Larger pages are saved by URL only; the server fetches them itself. */
const MAX_HTML_CHARS = 15 * 1024 * 1024;

/**
 * Serializes the tab's live DOM: the page exactly as you see it, including
 * content behind logins, paywalls you've passed and JS-rendered text.
 * Returns null for non-HTML documents (PDF viewer, images) and pages
 * extensions may not touch (browser settings, web stores).
 */
export async function captureHtml(tabId: number): Promise<string | null> {
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (
          document.contentType !== "text/html" &&
          document.contentType !== "application/xhtml+xml"
        ) {
          return null;
        }
        const doctype = document.doctype
          ? new XMLSerializer().serializeToString(document.doctype)
          : "";
        return doctype + document.documentElement.outerHTML;
      },
    });
    const html = res?.result;
    return typeof html === "string" && html.length <= MAX_HTML_CHARS ? html : null;
  } catch {
    return null;
  }
}

export const isSavableUrl = (url: string | undefined): url is string =>
  !!url && /^https?:\/\//.test(url);
