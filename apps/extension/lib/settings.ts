import { browser } from "wxt/browser";

export interface Settings {
  serverUrl: string;
  token: string;
  /** Re-send pages the server couldn't read when you visit them. Opt-in. */
  autoRepair: boolean;
}

const DEFAULTS: Settings = { serverUrl: "", token: "", autoRepair: false };

export async function getSettings(): Promise<Settings> {
  const s = await browser.storage.local.get(["serverUrl", "token", "autoRepair"]);
  return { ...DEFAULTS, ...(s as Partial<Settings>) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (patch.serverUrl !== undefined) patch.serverUrl = patch.serverUrl.trim().replace(/\/+$/, "");
  if (patch.token !== undefined) patch.token = patch.token.trim();
  await browser.storage.local.set(patch);
}

export const isConfigured = (s: Settings) => Boolean(s.serverUrl && s.token);

/** Small cache for instant popup rendering (tags/collections), refreshed in the background. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return (await browser.storage.local.get(`cache:${key}`))[`cache:${key}`] as T | undefined;
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [`cache:${key}`]: value });
}
