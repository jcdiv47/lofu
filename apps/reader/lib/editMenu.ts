import { EditMenu } from "lofu/native";
import { cleanup } from "nsh";

/**
 * Items of the app's in the system's edit menu over a read-only `RichEditor`
 * (iOS, `src/editmenu.rs`): the reader's *Highlight* beside Copy and Select
 * All, instead of a bubble of its own under that menu.
 */
export const nativeEditMenu = EditMenu.available();

const handlers = new Map<string, () => void>();
let listening = false;

/** Carries out the items chosen as they come ("" is a second without one). */
async function listen() {
  if (listening) return;
  listening = true;
  while (handlers.size) {
    const label = await EditMenu.next();
    handlers.get(label)?.();
  }
  listening = false;
}

/**
 * Puts `title` first in the edit menu of the editor labelled `label` while
 * the calling page is open; `onChoose` runs when it's chosen. Call `attach`
 * after the editor mounts and when it takes the focus (nsh may have made its
 * text view again). Does nothing unless `nativeEditMenu`.
 */
export function useEditMenuItem(label: string, title: string, onChoose: () => void) {
  if (!nativeEditMenu) return { attach: () => {} };
  handlers.set(label, onChoose);
  void listen();
  cleanup(() => {
    if (handlers.get(label) === onChoose) handlers.delete(label);
  });
  return { attach: () => EditMenu.offer(label, title) };
}
