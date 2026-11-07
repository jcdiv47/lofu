import { Files } from "lofu/native";
import { Storage } from "nsh";

/**
 * Text kept on the device beyond `Storage`'s 5 MB: files in the app's data
 * directory (`src/files.rs`). The web has no files, so there `onDisk` is
 * false and the snapshot goes to `Storage` as before, and nothing is kept
 * for reading offline.
 */
export const onDisk = (() => {
  try {
    return Files.available();
  } catch {
    return false; // No native module (headless tests).
  }
})();

export async function readText(name: string): Promise<string | null> {
  if (onDisk) return (await Files.read(name).catch(() => null)) ?? null;
  return Storage.getItem(name).catch(() => null);
}

/** Resolves with whether it was kept. */
export async function writeText(name: string, text: string): Promise<boolean> {
  if (onDisk) return Files.write(name, text).catch(() => false);
  try {
    await Storage.setItem(name, text);
    return true;
  } catch {
    return false;
  }
}

export async function removeText(name: string): Promise<void> {
  if (onDisk) await Files.remove(name).catch(() => false);
  else await Storage.removeItem(name).catch(() => {});
}

/** Names of the kept files that start with `prefix` (files only). */
export async function listText(prefix: string): Promise<string[]> {
  if (onDisk) return Files.list(prefix).catch(() => []);
  return [];
}

/** The bytes the kept files whose names start with `prefix` take (files only). */
export async function sizeOf(prefix: string): Promise<number> {
  if (onDisk) return Files.size(prefix).catch(() => 0);
  return 0;
}

/** Writes `bytes` to the file `name` (files only). Resolves with whether it was kept. */
export async function writeBytes(name: string, bytes: Uint8Array): Promise<boolean> {
  if (onDisk) return Files.writeBytes(name, bytes).catch(() => false);
  return false;
}

/** The absolute path of the kept file `name`, which an image can show (files only). */
export function filePath(name: string): string | null {
  return onDisk ? Files.path(name) : null;
}
