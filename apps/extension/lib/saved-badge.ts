import { browser } from "wxt/browser";
import { api } from "./api.ts";
import { isSavableUrl } from "./capture.ts";
import { getSettings, isConfigured } from "./settings.ts";

// Tokens prevent a slow lookup for an old navigation/account from painting
// over a newer result. No browsing history or lookup cache is persisted.
const requests = new Map<number, object>();

export function forgetSavedBadge(tabId: number) {
  requests.delete(tabId);
}

export async function refreshSavedBadge(tabId: number): Promise<void> {
  const token = {};
  requests.set(tabId, token);
  const current = () => requests.get(tabId) === token;
  try {
    await browser.action.setBadgeText({ tabId, text: "" });
    if (!current()) return;
    await browser.action.setTitle({ tabId, title: "Save to lofu" });
    const [tab, settings] = await Promise.all([browser.tabs.get(tabId), getSettings()]);
    if (!current() || !isConfigured(settings) || !isSavableUrl(tab.url)) return;
    const bookmark = await api.lookup(tab.url);
    if (!current()) return;
    if (bookmark && !bookmark.archived) {
      await browser.action.setBadgeBackgroundColor({ tabId, color: "#315cf5" });
      if (!current()) return;
      await browser.action.setBadgeText({ tabId, text: "✓" });
      if (!current()) return;
      await browser.action.setTitle({ tabId, title: "Saved to lofu" });
    }
  } catch {
    // Offline, unconfigured or closed tab: leave the neutral icon, not a
    // stale saved indicator. Passive lookups must never show error flashes.
  }
}

export async function refreshSavedBadges(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((tab) => (tab.id === undefined ? [] : [refreshSavedBadge(tab.id)])),
  );
}
