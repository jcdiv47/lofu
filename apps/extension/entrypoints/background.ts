import type { UpdateBookmark } from "@lofu/shared/types";
import { normalizeUrl } from "@lofu/shared/url";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { ApiError, api } from "../lib/api.ts";
import { captureHtml, isSavableUrl } from "../lib/capture.ts";
import type { Ack, Message, SaveResult } from "../lib/messages.ts";
import { forgetSavedBadge, refreshSavedBadge, refreshSavedBadges } from "../lib/saved-badge.ts";
import { getSettings, isConfigured } from "../lib/settings.ts";

/** Statuses where the server already has good content: don't re-send the page. */
const HAS_CONTENT = new Set(["ok", "pending", "skipped"]);
/** Dead links can't be repaired by visiting them. */
const DEAD = /^HTTP (404|410)/;
const REPAIR_DELAY_MS = 2_500;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function flash(tabId: number | undefined, text: string, color: string) {
  if (tabId === undefined) return;
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color });
    await browser.action.setBadgeText({ tabId, text });
    setTimeout(() => void refreshSavedBadge(tabId), 4_000);
  } catch {
    // Tab closed meanwhile.
  }
}

/**
 * Saves a tab. New pages are sent with their rendered HTML. Pages already
 * saved are left alone unless the server failed to read them, in which case
 * this visit's HTML repairs them.
 */
async function saveTab(tabId: number): Promise<SaveResult> {
  const settings = await getSettings();
  if (!isConfigured(settings)) {
    return {
      ok: false,
      error: "Connect the extension to your lofu server first.",
      needsSetup: true,
    };
  }
  const tab = await browser.tabs.get(tabId);
  if (!isSavableUrl(tab.url)) {
    return { ok: false, error: "Only web pages (http/https) can be saved.", needsSetup: false };
  }
  try {
    const existing = await api.lookup(tab.url);
    if (existing && HAS_CONTENT.has(existing.contentStatus)) {
      void refreshSavedBadges();
      return { ok: true, bookmark: existing, created: false, captured: false };
    }
    const html = await captureHtml(tabId);
    const { bookmark, created } = await api.save({
      url: existing?.url ?? tab.url,
      ...(html ? { html } : {}),
    });
    await dropFromRepairQueue(bookmark.url);
    void refreshSavedBadges();
    return { ok: true, bookmark, created, captured: html !== null };
  } catch (e) {
    void flash(tabId, "!", "#c2412d");
    return {
      ok: false,
      error: errorText(e),
      needsSetup: e instanceof ApiError && e.status === 401,
    };
  }
}

// ---- Writes from the popup -------------------------------------------------
// They run here because the background outlives the popup: a note typed right
// before the popup closes still gets saved. Patches to one bookmark coalesce.

const pending = new Map<string, { patch: UpdateBookmark; timer: ReturnType<typeof setTimeout> }>();

function queuePatch(id: string, patch: UpdateBookmark): Promise<Ack> {
  const prev = pending.get(id);
  if (prev) clearTimeout(prev.timer);
  const merged = { ...prev?.patch, ...patch };
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      pending.delete(id);
      try {
        const bookmark = await api.update(id, merged);
        void refreshSavedBadges();
        resolve({ ok: true, bookmark });
      } catch (e) {
        resolve({ ok: false, error: errorText(e) });
      }
    }, 350);
    pending.set(id, { patch: merged, timer });
  });
}

// ---- Auto-repair -------------------------------------------------------------
// The server keeps a list of pages it couldn't read (bot walls, logins). The
// extension mirrors their normalized URLs locally, so checking a visited page
// is a local lookup: no request per navigation, nothing sent unless it matches.

type RepairQueue = Record<string, string>; // normalized URL -> bookmark URL

async function loadRepairQueue(): Promise<RepairQueue> {
  return ((await browser.storage.local.get("repairQueue")).repairQueue as RepairQueue) ?? {};
}

async function refreshRepairQueue(): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoRepair || !isConfigured(settings)) {
    await browser.storage.local.set({ repairQueue: {} });
    return;
  }
  const queue: RepairQueue = {};
  for (const b of await api.failed()) {
    if (DEAD.test(b.contentError ?? "")) continue;
    try {
      queue[normalizeUrl(b.url)] = b.url;
    } catch {}
  }
  await browser.storage.local.set({ repairQueue: queue });
}

async function dropFromRepairQueue(url: string) {
  const queue = await loadRepairQueue();
  try {
    const key = normalizeUrl(url);
    if (key in queue) {
      delete queue[key];
      await browser.storage.local.set({ repairQueue: queue });
    }
  } catch {}
}

const repairing = new Set<string>();

async function maybeRepair(tabId: number, url: string) {
  let key: string;
  try {
    key = normalizeUrl(url);
  } catch {
    return;
  }
  const queue = await loadRepairQueue();
  const bookmarkUrl = queue[key];
  if (!bookmarkUrl || repairing.has(key)) return;
  if (!(await getSettings()).autoRepair) return;
  repairing.add(key);
  try {
    await new Promise((r) => setTimeout(r, REPAIR_DELAY_MS)); // let client-side rendering finish
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.url || normalizeUrl(tab.url) !== key) return; // navigated away
    const html = await captureHtml(tabId);
    if (!html) return;
    await api.save({ url: bookmarkUrl, html });
    await dropFromRepairQueue(bookmarkUrl);
    void flash(tabId, "↻", "#2f6b3a");
  } catch {
    // Try again on the next visit.
  } finally {
    repairing.delete(key);
  }
}

export default defineBackground(() => {
  void refreshSavedBadges();
  browser.runtime.onStartup.addListener(() => void refreshSavedBadges());
  browser.tabs.onActivated.addListener(({ tabId }) => void refreshSavedBadge(tabId));
  browser.tabs.onRemoved.addListener(forgetSavedBadge);
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: "save-page",
      title: "Save page to lofu",
      contexts: ["page"],
    });
    browser.contextMenus.create({
      id: "save-link",
      title: "Save link to lofu",
      contexts: ["link"],
    });
    await browser.alarms.create("refresh-repair", { periodInMinutes: 30 });
    if (reason === "install" && !isConfigured(await getSettings())) {
      await browser.runtime.openOptionsPage();
    }
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "save-page" && tab?.id !== undefined) {
      await saveTab(tab.id);
    } else if (info.menuItemId === "save-link" && isSavableUrl(info.linkUrl)) {
      try {
        await api.save({ url: info.linkUrl });
        void refreshSavedBadges();
      } catch {
        void flash(tab?.id, "!", "#c2412d");
      }
    }
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "refresh-repair") {
      void refreshRepairQueue().catch(() => {});
      void refreshSavedBadges();
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      ("autoRepair" in changes || "serverUrl" in changes || "token" in changes)
    ) {
      void refreshRepairQueue().catch(() => {});
      void refreshSavedBadges();
    }
  });

  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === "loading") void refreshSavedBadge(tabId);
    if (change.status === "complete" && isSavableUrl(tab.url)) void maybeRepair(tabId, tab.url);
  });

  browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as Message;
    const reply = (p: Promise<SaveResult | Ack>) => {
      p.then(sendResponse, (e) =>
        sendResponse({ ok: false, error: errorText(e), needsSetup: false }),
      );
      return true; // keep the channel open for the async reply
    };
    switch (msg.type) {
      case "save-tab":
        return reply(saveTab(msg.tabId));
      case "patch":
        return reply(queuePatch(msg.id, msg.patch));
      case "remove":
        return reply(
          api.remove(msg.id).then(
            (): Ack => {
              void refreshSavedBadges();
              return { ok: true };
            },
            (e): Ack => ({ ok: false, error: errorText(e) }),
          ),
        );
      case "restore": {
        const b = msg.bookmark;
        return reply(
          api
            .save({
              url: b.url,
              tags: b.tags,
              collectionId: b.collectionId,
              ...(b.note ? { note: b.note } : {}),
            })
            .then(
              async ({ bookmark }): Promise<Ack> => {
                void refreshSavedBadges();
                return {
                  ok: true,
                  bookmark: b.favorite
                    ? await api.update(bookmark.id, { favorite: true })
                    : bookmark,
                };
              },
              (e): Ack => ({ ok: false, error: errorText(e) }),
            ),
        );
      }
      case "refresh-repair":
        return reply(
          refreshRepairQueue().then(
            (): Ack => ({ ok: true }),
            (e): Ack => ({ ok: false, error: errorText(e) }),
          ),
        );
    }
    return false;
  });
});
