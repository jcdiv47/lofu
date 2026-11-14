import { host, platform, signal } from "nsh";

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
