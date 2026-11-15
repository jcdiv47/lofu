/** Physical-device smoke test. Only resets app.lofu.reader.e2e, never the real app. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../server/src/app";
import { config } from "../../server/src/config";
import { wire } from "../../server/src/wire";

const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Set ANDROID_SERIAL to the unlocked test phone's adb serial.");
const pkg = "app.lofu.reader.e2e";
const activity = `${pkg}/com.longbridge.nsh.LofuActivity`;
const root = resolve(import.meta.dir, "../../..");
const shots = join(import.meta.dir, "screens");
await mkdir(shots, { recursive: true });
const dataDir = await mkdtemp(join(tmpdir(), "lofu-android-test-"));
function adb(...args: string[]) {
  const r = Bun.spawnSync(["adb", "-s", serial!, ...args]);
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
  console.log(`✓ ${message}`);
}
const sys = wire({
  ...config,
  dataDir,
  dbPath: join(dataDir, "lofu.db"),
  imageCacheDir: join(dataDir, "images"),
  meiliUrl: "",
  browser: "off",
  authDisabled: false,
  extractWorkers: 1,
});
const app = createApp(sys.ctx);
const { token } = sys.ctx.tokens.create("android-device-test");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const port = String(server.port);
type FixtureBookmark = { id: string; url: string; contentStatus: string; favorite: boolean };
async function api<T = FixtureBookmark>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`API ${method} ${path}: ${response.status}`);
  return response.json() as Promise<T>;
}
function decode(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function nodes() {
  adb("shell", "uiautomator", "dump", "/sdcard/lofu-test-ui.xml");
  const xml = adb("shell", "cat", "/sdcard/lofu-test-ui.xml");
  return [...xml.matchAll(/<node\s+([^>]+)>?/g)].map((match) => {
    const attrs: Record<string, string> = {};
    for (const a of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    return attrs;
  });
}
async function wait(text: string, timeout = 20000) {
  const end = Date.now() + timeout;
  do {
    const all = nodes();
    const found =
      all.find((n) => n["resource-id"] === text) ??
      all.find((n) => n.text === text || n["content-desc"] === text) ??
      all.find((n) => n.text?.includes(text));
    if (found) return found;
    await Bun.sleep(250);
  } while (Date.now() < end);
  throw new Error(`UI not found: ${text}`);
}
async function tap(text: string) {
  const n = await wait(text);
  const bounds = n.bounds!.match(/\d+/g)!.map(Number);
  adb(
    "shell",
    "input",
    "tap",
    String((bounds[0]! + bounds[2]!) / 2),
    String((bounds[1]! + bounds[3]!) / 2),
  );
  await Bun.sleep(800);
}
async function shot(name: string) {
  const p = Bun.spawnSync(["adb", "-s", serial!, "exec-out", "screencap", "-p"]);
  if (p.exitCode) throw new Error("Screenshot failed");
  await Bun.write(join(shots, `${name}.png`), p.stdout);
}
try {
  await sys.start();
  const b = await api("POST", "/v1/bookmarks", {
    url: "https://android-fixture.invalid/reading",
    title: "Nothing phone reading test",
    tags: ["android"],
    html: `<html><head><title>Nothing phone reading test</title></head><body><article><h1>Reading on Android</h1><p>This saved article demonstrates offline reading on a Nothing phone. The library belongs to you, and your bookmarks stay on your own server.</p><p>Highlight a passage, save another page, and return to this article whenever you want. This fixture never touches your real library.</p></article></body></html>`,
  });
  await sys.runner.idle();
  check(
    (await api("GET", `/v1/bookmarks/${b.id}`)).contentStatus === "ok",
    "fixture article extracted",
  );
  adb("reverse", `tcp:${port}`, `tcp:${port}`);
  adb("install", "-r", join(root, ".nsh/out/lofu-android-test.apk"));
  // Explicitly isolated package: safe even if a real lofu install already exists.
  adb("shell", "pm", "clear", pkg);
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb(
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    activity,
    "-a",
    "android.intent.action.SEND",
    "-t",
    "text/plain",
    "--es",
    "android.intent.extra.TEXT",
    "https://android-fixture.invalid/cancelled",
  );
  await wait("Server address");
  await Bun.sleep(700);
  await tap("server");
  adb("shell", "input", "text", `http://127.0.0.1:${port}`);
  await tap("token");
  adb("shell", "input", "text", token);
  await tap("connect");
  await wait("Save shared link");
  await tap("Cancel");
  check(
    (await api<{ items: FixtureBookmark[] }>("GET", "/v1/bookmarks?limit=10")).items.length === 1,
    "cold-launch share survives setup and cancellation saves nothing",
  );
  await wait("All bookmarks");
  await Bun.sleep(700);
  check(true, "connect with a real bearer token");
  await shot("01-library");
  await tap("home-menu");
  await wait("home-menu-panel");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await Bun.sleep(600);
  check(
    !nodes().some((n) => n["resource-id"] === "home-menu-panel") &&
      nodes().some((n) => n["resource-id"] === "source-all"),
    "Android back closes the Library menu, not the app",
  );
  await tap("All bookmarks");
  await tap("list-menu");
  await wait("list-menu-panel");
  await shot("07-list-menu");
  await tap("menu-sort-by");
  await tap("menu-sort:name-asc");
  await tap("list-menu");
  await wait("Sort by, By name (A-Z)");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await Bun.sleep(600);
  check(
    !nodes().some((n) => n["resource-id"] === "sort-button"),
    "no Sort/View/Filter row on Android: the ••• menu has them",
  );
  check(true, "the list's ••• menu opens and its Sort by applies");
  await tap("list-menu");
  await tap("menu-view:moodboard");
  await wait("Nothing phone reading test");
  await tap("list-menu");
  await tap("menu-view:list");
  await tap("list-menu");
  await wait("list-menu-panel");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await Bun.sleep(600);
  check(
    !nodes().some((n) => n["resource-id"] === "list-menu-panel") &&
      nodes().some((n) => n["resource-id"] === "list-menu"),
    "the ••• menu switches views, and Android back closes it",
  );
  await tap("Nothing phone reading test");
  await wait("article");
  await wait("This saved article");
  await Bun.sleep(700);
  check(true, "open and render saved article");
  await shot("02-reader");
  {
    const a = (await wait("article")).bounds!.match(/\d+/g)!.map(Number);
    adb("shell", "input", "tap", String((a[0]! + a[2]!) / 2), String(a[1]! + 400));
    await Bun.sleep(1200);
    check(
      !adb("shell", "dumpsys", "input_method").includes("mInputShown=true"),
      "a press on the read-only article raises no keyboard",
    );
  }
  await tap("reader-menu");
  await tap("Add to Favorites");
  await Bun.sleep(500);
  check((await api("GET", `/v1/bookmarks/${b.id}`)).favorite, "favorite changes reach the server");
  await tap("reader-menu");
  await tap("Share…");
  await wait("https://android-fixture.invalid/reading");
  await shot("06-outgoing-share");
  check(true, "outgoing share opens Android's chooser");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  adb("shell", "am", "force-stop", pkg);
  adb("shell", "am", "start", "-W", "-n", activity);
  await wait("All bookmarks");
  check(true, "Keystore token survives a cold launch");
  await tap("home-search");
  adb("shell", "input", "text", "Nothing");
  await tap("search-bookmarks");
  await wait("Nothing phone reading test");
  check(true, "search finds the fixture bookmark (local fallback without Meilisearch)");
  await shot("05-search");
  adb("shell", "am", "force-stop", pkg);
  adb("shell", "am", "start", "-W", "-n", activity);
  await wait("All bookmarks");
  adb(
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    activity,
    "-a",
    "android.intent.action.SEND",
    "-t",
    "text/plain",
    "--es",
    "android.intent.extra.TEXT",
    "https://android-fixture.invalid/shared",
  );
  await wait("https://android-fixture.invalid/shared");
  await shot("03-incoming-share");
  await tap("Save");
  await Bun.sleep(1500);
  check(
    (await api<{ items: FixtureBookmark[] }>("GET", "/v1/bookmarks?limit=10")).items.some((x) =>
      x.url.includes("/shared"),
    ),
    "Android share confirmation saves through the API",
  );
  adb("reverse", "--remove", `tcp:${port}`);
  adb("shell", "am", "force-stop", pkg);
  adb("shell", "am", "start", "-W", "-n", activity);
  await wait("All bookmarks");
  await tap("All bookmarks");
  await tap("Nothing phone reading test");
  await wait("article");
  await wait("This saved article");
  await Bun.sleep(700);
  check(true, "cached library and article open offline");
  await shot("04-offline-reader");
  console.log(`Screenshots: ${shots}`);
} catch (e) {
  await shot("failure");
  console.error(
    nodes()
      .filter((n) => n.text && n.package === pkg)
      .map((n) => n.text)
      .join("\n")
      .replaceAll(token, "[redacted]"),
  );
  throw e;
} finally {
  Bun.spawnSync(["adb", "-s", serial!, "reverse", "--remove", `tcp:${port}`]);
  await server.stop(true);
  await sys.stop();
  await rm(dataDir, { recursive: true, force: true });
}
