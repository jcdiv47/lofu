import { host, platform, signal } from "nsh";
import { BackHandler } from "nsh/mobile";

/** Untrusted share text, held through first-launch connection until confirmed. */
export const incomingShare = signal("");

export function listenForShares() {
  if (platform.os !== "android") return () => {};
  return host.on("lofu.incomingShare", (data) => {
    if (typeof data === "string" && data.length <= 65536) incomingShare.set(data);
  });
}

/** No plaintext fallback if Android's Keystore or the host bridge fails. */
export const readAndroidToken = async () => {
  const token = await host.call("lofu.secret.read");
  if (typeof token !== "string") throw new Error("Cannot read the saved Android token.");
  return token;
};
export const writeAndroidToken = async (token: string) => {
  await host.call("lofu.secret.write", token);
};
export const shareAndroidUrl = async (url: string) => {
  await host.call("lofu.share", url);
};

/**
 * Android's back button takes `handler` while the calling component lives
 * (a menu or card drawn over the page: back closes it, not the page or app).
 */
export function onAndroidBack(handler: () => void) {
  if (platform.os !== "android") return;
  BackHandler.on("press", () => {
    handler();
    return true;
  });
}

/** Android: keeps the keyboard down for the read-only editor labelled `label` (`LofuActivity`). */
export const keepAndroidKeyboardAway = (label: string) => {
  if (platform.os === "android") void host.call("lofu.keyboard.keepAway", label).catch(() => {});
};
