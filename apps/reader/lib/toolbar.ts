import { Toolbar } from "lofu/native";
import { cleanup, effect, platform, signal, untracked } from "nsh";
import { nativeControls } from "../components/native";

/**
 * The window's toolbar on the Mac: a real `NSToolbar` (`src/toolbar.rs`),
 * whose items AppKit draws in Liquid Glass on macOS 26 and groups into
 * capsules itself, with the system's search field. Its items get clicks as
 * any AppKit control does: they sit in the title bar, outside the root view
 * where nsh 0.4 loses clicks on native views (`components/native.tsx`).
 * Elsewhere, and on older systems, pages draw their own bars.
 */
export const nativeToolbar = nativeControls && platform.os === "macos" && Toolbar.available();

/** A toolbar item's frame, from the window's top left. */
export type Frame = { x: number; y: number; width: number; height: number };

export type ToolbarItem =
  | {
      kind: "button";
      id: string;
      /** An SF Symbol. */
      symbol: string;
      label: string;
      /** The symbol's color, or for a `prominent` item, its glass's. */
      tint?: string;
      prominent?: boolean;
      disabled?: boolean;
      /** `at`: the pointer, from the window's top left; `search`: the search field's frame then, if there is one. */
      onPress: (at: { x: number; y: number }, search: Frame | null) => void;
    }
  | {
      kind: "search";
      id: string;
      label: string;
      placeholder: string;
      value: string;
      width?: number;
      disabled?: boolean;
      onChange: (value: string) => void;
      /** It took the keyboard: its frame, from the window's top left (where suggestions go). */
      onFocus?: (frame: Frame) => void;
      onBlur?: () => void;
      /** Return, and while `setSuggesting(true)` the arrows and Escape. */
      onKey?: (key: "up" | "down" | "enter" | "escape") => void;
    }
  /** Leading room: the next item starts `x` points from the window's left edge. */
  | { kind: "space"; id: string; x: number }
  /**
   * An invisible point: `onPlace` hears how far it is from the window's right
   * edge when that changes (after a `flex`, where the trailing items start).
   */
  | { kind: "mark"; id: string; onPlace: (right: number) => void }
  /** Pushes what follows to the trailing end. */
  | { kind: "flex" }
  /** Parts two capsules of glass. */
  | { kind: "gap" };

/**
 * A dialog of the app's is open: the toolbar is outside nsh's modal scope,
 * so its items are greyed out and their clicks dropped until it closes.
 */
export const toolbarBlocked = signal(false);

/** Where the content beside the sidebar starts, from the window's left edge (the desktop layout sets it). */
export const contentLeft = signal(0);

/** The pages that asked for the toolbar, the newest last: its items are the ones shown. */
const askers: object[] = [];
/** Bumped when `askers` changes, so the pages' effects look again. */
const turn = signal(0);
const bump = () => untracked(() => turn.set(turn() + 1));
let handlers = new Map<string, ToolbarItem>();
let listening = false;

/** Carries out the toolbar's clicks and search edits as they come ("" is a second without one). */
async function listen() {
  if (listening) return;
  listening = true;
  for (;;) {
    const raw = await Toolbar.next();
    let e: {
      type: string;
      id: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      value?: string;
      key?: "up" | "down" | "enter" | "escape";
      search?: Frame | null;
      right?: number;
    };
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    const item = handlers.get(e.id);
    // Where an item is, not a click: a dialog doesn't hold it back.
    if (e.type === "mark") {
      if (item?.kind === "mark" && e.right != null) item.onPlace(e.right);
      continue;
    }
    if (toolbarBlocked()) continue;
    if (e.type === "press" && item?.kind === "button")
      item.onPress({ x: e.x ?? -1, y: e.y ?? -1 }, e.search ?? null);
    else if (item?.kind !== "search") continue;
    else if (e.type === "search") item.onChange(e.value ?? "");
    else if (e.type === "searchFocus")
      item.onFocus?.({ x: e.x ?? 0, y: e.y ?? 0, width: e.width ?? 0, height: e.height ?? 0 });
    else if (e.type === "searchBlur") item.onBlur?.();
    else if (e.type === "searchKey" && e.key) item.onKey?.(e.key);
  }
}

function show(items: ToolbarItem[]) {
  handlers = new Map(items.flatMap((i) => ("id" in i ? [[i.id, i] as const] : [])));
  // The handlers stay here; the toolbar gets what it draws.
  const drawn = items.map((i) => {
    const rest: Record<string, unknown> = { ...i };
    if (toolbarBlocked() && "id" in i) rest.disabled = true;
    delete rest.onPress;
    delete rest.onChange;
    delete rest.onFocus;
    delete rest.onBlur;
    delete rest.onKey;
    delete rest.onPlace;
    return rest;
  });
  Toolbar.set(JSON.stringify(drawn));
}

/**
 * Shows `items` (reactive) in the window's toolbar while the calling page
 * is the newest to ask: a reader pushed over the library shows its own, and
 * the library's come back when it closes. Does nothing unless `nativeToolbar`.
 */
export function useToolbar(items: () => ToolbarItem[]) {
  if (!nativeToolbar) return;
  void listen();
  const me = {};
  askers.push(me);
  bump();
  effect(() => {
    turn();
    toolbarBlocked();
    if (askers.at(-1) === me) show(items());
  });
  cleanup(() => {
    const i = askers.indexOf(me);
    if (i >= 0) askers.splice(i, 1);
    if (!askers.length) show([]);
    bump();
  });
}

/** Puts the keyboard in the toolbar's search field. */
export const focusToolbarSearch = () => Toolbar.search();

/** Whether the app's suggestions are open under the toolbar's search field (it then hands over the arrows and Escape). */
export const setToolbarSuggesting = (on: boolean) => {
  if (nativeToolbar) Toolbar.suggesting(on);
};
