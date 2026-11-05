import type { UpdateBookmark } from "@lofu/shared/types";
import { browser } from "wxt/browser";
import type { Bookmark } from "./api.ts";

export type Message =
  | { type: "save-tab"; tabId: number }
  | { type: "patch"; id: string; patch: UpdateBookmark }
  | { type: "remove"; id: string }
  | { type: "restore"; bookmark: Bookmark }
  | { type: "refresh-repair" };

export type SaveResult =
  | { ok: true; bookmark: Bookmark; created: boolean; captured: boolean }
  | { ok: false; error: string; needsSetup: boolean };

export type Ack = { ok: true; bookmark?: Bookmark } | { ok: false; error: string };

export function send(msg: Extract<Message, { type: "save-tab" }>): Promise<SaveResult>;
export function send(msg: Exclude<Message, { type: "save-tab" }>): Promise<Ack>;
export function send(msg: Message): Promise<SaveResult | Ack> {
  return browser.runtime.sendMessage(msg);
}
