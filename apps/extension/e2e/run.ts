/**
 * End-to-end test: the built extension in Chrome for Testing, a real lofu
 * server (in-process, in-memory DB) and the server's fixture site.
 *
 *   bun run e2e      (builds with LOFU_E2E=1, then runs this)
 *
 * Covers: saving from the popup sends the rendered page (a 403 bot wall the
 * server itself can't fetch), edits autosave, re-opening shows "already saved"
 * without re-uploading, the Trash button moves the bookmark there and back,
 * auto-repair fixes a failed bookmark when its page is visited. Writes
 * screenshots to e2e/screens.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../../server/src/app.ts";
import { config } from "../../server/src/config.ts";
import { findChromium } from "../../server/src/extract/browser.ts";
import { wire } from "../../server/src/wire.ts";
import { startFixtureServer } from "../../server/test/fixtures.ts";

const EXT_DIR = resolve(import.meta.dir, "../.output/chrome-mv3");
const SCREENS = resolve(import.meta.dir, "screens");
mkdirSync(SCREENS, { recursive: true });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 10_000,
): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  return null;
}

// ---- servers ----------------------------------------------------------------
const site = startFixtureServer();
const fixture = `http://localhost:${site.port}`;
const sys = wire({
  ...config,
  dbPath: ":memory:",
  browser: "off",
  meiliUrl: "",
  fetchHostIntervalMs: 0,
  fetchPrivate: true, // the fixture site is on localhost
  authDisabled: false,
});
const app = createApp(sys.ctx);
const { token } = sys.ctx.tokens.create("e2e");
await sys.start();
const server = Bun.serve({ port: 0, fetch: app.fetch });
const lofu = `http://127.0.0.1:${server.port}`;
const bookmarkFor = (url: string) => {
  try {
    return sys.ctx.bookmarks.findByUrl(url, { includeTrashed: true });
  } catch {
    return null;
  }
};

// ---- chrome -----------------------------------------------------------------
const exe = findChromium(process.env.LOFU_CHROME_PATH || undefined);
if (!exe) throw new Error("no Chromium found (set LOFU_CHROME_PATH)");
const profile = mkdtempSync(join(tmpdir(), "lofu-e2e-"));
const chrome = Bun.spawn(
  [
    exe,
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stderr: "pipe", stdout: "ignore" },
);
const reader = (chrome.stderr as ReadableStream<Uint8Array>).getReader();
let log = "";
let wsUrl = "";
while (!wsUrl) {
  const { value, done } = await reader.read();
  if (done) throw new Error(`chrome exited: ${log}`);
  log += new TextDecoder().decode(value);
  wsUrl = /DevTools listening on (ws:\/\/\S+)/.exec(log)?.[1] ?? "";
}
void (async () => {
  while (!(await reader.read()).done) {}
})();

// Minimal CDP client.
const ws = new WebSocket(wsUrl);
await new Promise((r) => {
  ws.onopen = r;
});
let nextId = 0;
// biome-ignore lint/suspicious/noExplicitAny: CDP messages are untyped JSON
const waiting = new Map<number, (m: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id !== undefined) waiting.get(m.id)?.(m);
};
// biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON
async function cdp(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const id = ++nextId;
  // biome-ignore lint/suspicious/noExplicitAny: CDP messages are untyped JSON
  const m = await new Promise<any>((r) => {
    waiting.set(id, r);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  waiting.delete(id);
  if (m.error) throw new Error(`${method}: ${m.error.message}`);
  return m.result;
}
async function open(url: string) {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  return { targetId, sessionId };
}
async function evaluate(sessionId: string, expression: string) {
  const r = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return r.result.value;
}
async function screenshot(sessionId: string, name: string, width: number, dark: boolean) {
  await cdp(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] },
    sessionId,
  );
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width, height: 400, deviceScaleFactor: 2, mobile: false },
    sessionId,
  );
  await sleep(600); // fonts, layout, and the stamp animation
  // The body's own height: the popup sizes to it, not to the 400px viewport.
  const height = await evaluate(
    sessionId,
    "Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight))",
  );
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 2, mobile: false },
    sessionId,
  );
  const { data } = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  const path = join(SCREENS, `${name}${dark ? "-dark" : ""}.png`);
  await Bun.write(path, Buffer.from(data, "base64"));
  return path;
}

try {
  // Unpacked extension ids are derived from the path: sha256 hex, digits
  // mapped 0-f -> a-p, first 32.
  const extId = [...new Bun.CryptoHasher("sha256").update(EXT_DIR).digest("hex").slice(0, 32)]
    .map((h) => String.fromCharCode(97 + Number.parseInt(h, 16)))
    .join("");
  const base = `chrome-extension://${extId}`;
  const sw = await until(async () => {
    const { targetInfos } = await cdp("Target.getTargets");
    return targetInfos.some((t: { url: string }) => t.url.startsWith(`${base}/background.js`));
  });
  if (!sw) throw new Error(`extension ${extId} did not start`);

  // Configure through the options page context.
  const options = await open(`${base}/options.html`);
  const ready = await until(() =>
    evaluate(
      options.sessionId,
      "location.protocol === 'chrome-extension:' && !!chrome.storage?.local",
    ),
  );
  if (!ready) {
    const info = await evaluate(
      options.sessionId,
      "JSON.stringify({ href: location.href, chrome: typeof chrome, keys: Object.keys(globalThis.chrome ?? {}) })",
    ).catch((e: Error) => e.message);
    throw new Error(`options page never got extension APIs: ${info}`);
  }
  await evaluate(
    options.sessionId,
    `chrome.storage.local.set(${JSON.stringify({ serverUrl: lofu, token })}).then(() => true)`,
  );
  const tabIdOf = (url: string) =>
    evaluate(
      options.sessionId,
      `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(url)})?.id ?? null)`,
    );
  const badgeIs = async (tabId: number, text: string) =>
    Boolean(
      await until(() =>
        evaluate(
          options.sessionId,
          `chrome.action.getBadgeText({ tabId: ${tabId} }).then(t => t === ${JSON.stringify(text)})`,
        ),
      ),
    );
  const cardState = (sessionId: string) =>
    evaluate(sessionId, "document.getElementById('card').dataset.state");

  // 1. Popup save of a page the server can't fetch (403 unless a real browser).
  const wallUrl = `${fixture}/bot-wall`;
  check("fixture: the server alone gets 403", (await fetch(wallUrl)).status === 403);
  await open(wallUrl);
  const tabId = await until(() => tabIdOf(wallUrl));
  check("unsaved page has no badge", await badgeIs(tabId, ""));
  const popup = await open(`${base}/popup.html?tab=${tabId}`);
  check("popup saves the page", Boolean(await until(async () => bookmarkFor(wallUrl))));
  check("saved page has a check badge", await badgeIs(tabId, "✓"));
  await sleep(4_500);
  check("saved badge persists beyond the old flash timeout", await badgeIs(tabId, "✓"));
  await sys.runner.idle();
  const after = bookmarkFor(wallUrl);
  check(
    "content came from the browser's DOM",
    after?.contentStatus === "ok" && after.title === "Sourdough Science",
    JSON.stringify({
      status: after?.contentStatus,
      title: after?.title,
      error: after?.contentError,
    }),
  );
  check(
    "popup shows the saved stamp",
    (await until(async () => (await cardState(popup.sessionId)) === "saved")) === true,
  );
  await until(
    () =>
      evaluate(
        popup.sessionId,
        "!document.getElementById('status-line').textContent.includes('Reading')",
      ),
    8_000,
  );

  // Edits autosave via the background worker.
  await evaluate(
    popup.sessionId,
    `(() => {
      const i = document.getElementById('tag-input');
      i.focus(); i.value = 'baking'; i.dispatchEvent(new Event('input'));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      const n = document.getElementById('note');
      n.value = 'Try the 75% hydration'; n.dispatchEvent(new Event('input'));
      document.getElementById('fav').click();
      return true;
    })()`,
  );
  const edited = await until(async () => {
    const b = bookmarkFor(wallUrl);
    return b?.favorite && b.note === "Try the 75% hydration" && b.tags.includes("baking")
      ? b
      : null;
  });
  check("tags, note and favorite autosave", Boolean(edited), JSON.stringify(bookmarkFor(wallUrl)));
  await evaluate(popup.sessionId, "document.activeElement?.blur(), true");
  console.log(`  screenshot: ${await screenshot(popup.sessionId, "popup-saved", 360, false)}`);

  // 2. Re-opening on a saved page: "already saved", no re-upload.
  const seqBefore = bookmarkFor(wallUrl)?.seq;
  const again = await open(`${base}/popup.html?tab=${tabId}`);
  check(
    "re-opening shows 'already saved'",
    (await until(async () => (await cardState(again.sessionId)) === "existing")) === true,
  );
  check("re-opening doesn't re-send the page", bookmarkFor(wallUrl)?.seq === seqBefore);
  console.log(`  screenshot: ${await screenshot(again.sessionId, "popup-existing", 360, true)}`);

  // The Trash toggle (the API's `trashed`): moves the bookmark there and back.
  const trashButton = () =>
    evaluate(
      again.sessionId,
      `(() => { const b = document.getElementById('trash');
        return b.textContent.trim() + '|' + b.getAttribute('aria-pressed'); })()`,
    );
  check("the Trash button offers to move there", (await trashButton()) === "Move to Trash|false");
  await evaluate(again.sessionId, "document.getElementById('trash').click(), true");
  check(
    "Move to Trash sets trashed",
    Boolean(await until(async () => bookmarkFor(wallUrl)?.trashed === true)),
  );
  check("Trash clears the saved badge", await badgeIs(tabId, ""));
  check("the button then says In Trash", (await trashButton()) === "In Trash|true");
  await evaluate(again.sessionId, "document.activeElement?.blur(), true");
  console.log(`  screenshot: ${await screenshot(again.sessionId, "popup-in-trash", 360, false)}`);
  await evaluate(again.sessionId, "document.getElementById('trash').click(), true");
  check(
    "pressing it again restores it",
    Boolean(await until(async () => bookmarkFor(wallUrl)?.trashed === false)),
  );

  check("restoring from Trash restores the badge", await badgeIs(tabId, "✓"));

  // A new tab recognizes an existing bookmark without opening the popup.
  const variantUrl = `${wallUrl}#already-saved`;
  const visited = await open(variantUrl);
  const visitedId = await until(() => tabIdOf(variantUrl));
  check("visiting a saved URL variant sets the badge", await badgeIs(visitedId, "✓"));
  await cdp("Page.navigate", { url: `${fixture}/article?unsaved=1` }, visited.sessionId);
  check("navigation to an unsaved page clears the badge", await badgeIs(visitedId, ""));
  await cdp("Page.navigate", { url: wallUrl }, visited.sessionId);
  check("navigation back restores the badge", await badgeIs(visitedId, "✓"));
  await evaluate(
    options.sessionId,
    `chrome.runtime.sendMessage({ type: 'remove', id: ${JSON.stringify(after?.id)} })`,
  );
  check(
    "removing a bookmark clears badges in every tab",
    (await badgeIs(tabId, "")) && (await badgeIs(visitedId, "")),
  );
  await evaluate(
    options.sessionId,
    `chrome.runtime.sendMessage({ type: 'restore', bookmark: ${JSON.stringify(edited)} })`,
  );
  check(
    "undoing removal restores badges in every tab",
    (await badgeIs(tabId, "✓")) && (await badgeIs(visitedId, "✓")),
  );

  await evaluate(options.sessionId, "chrome.storage.local.set({ token: '' }).then(() => true)");
  check("disconnecting clears saved badges", await badgeIs(tabId, ""));
  await evaluate(
    options.sessionId,
    `chrome.storage.local.set({ token: ${JSON.stringify(token)} }).then(() => true)`,
  );
  check("reconnecting restores saved badges", await badgeIs(tabId, "✓"));
  await cdp("Page.navigate", { url: "about:blank" }, visited.sessionId);
  check("non-web pages have no saved badge", await badgeIs(visitedId, ""));

  // 3. Auto-repair: a bookmark the server couldn't read gets fixed on visit.
  const repairUrl = `${fixture}/bot-wall?article=2`;
  sys.ctx.bookmarks.create({ url: repairUrl });
  sys.ctx.bookmarks.create({ url: `${fixture}/forbidden` }); // stays failed: shown in the options list
  await sys.runner.idle();
  check("server alone fails on the wall", bookmarkFor(repairUrl)?.contentStatus === "failed");
  await evaluate(
    options.sessionId,
    "chrome.storage.local.set({ autoRepair: true }).then(() => true)",
  );
  await until(() =>
    evaluate(
      options.sessionId,
      "chrome.storage.local.get('repairQueue').then(r => Object.keys(r.repairQueue ?? {}).length > 0)",
    ),
  );
  await open(repairUrl);
  const repaired = await until(async () => {
    await sys.runner.idle();
    return bookmarkFor(repairUrl)?.contentStatus === "ok";
  }, 15_000);
  check(
    "auto-repair re-captures the page on visit",
    Boolean(repaired),
    JSON.stringify(bookmarkFor(repairUrl)),
  );

  // Options page with the "needs your browser" list.
  await cdp("Page.reload", {}, options.sessionId);
  await until(() =>
    evaluate(options.sessionId, "document.querySelectorAll('#needs-list li').length > 0"),
  );
  console.log(`  screenshot: ${await screenshot(options.sessionId, "options", 760, false)}`);
} catch (e) {
  check("e2e run", false, (e as Error).stack ?? String(e));
} finally {
  ws.close();
  chrome.kill();
  server.stop(true);
  site.stop(true);
  await sys.stop();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
