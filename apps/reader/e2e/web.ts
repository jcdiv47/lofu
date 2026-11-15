/**
 * The highlight loop on the web target, with real input in Chrome for
 * Testing: a mouse drag selects text in the read-only RichEditor, the bubble
 * menu's "Highlight" saves a text-quote anchor to the server, a reload puts
 * it back in place, a press inside it offers "Remove".
 *
 * Needs `nsh run App.tsx --target web` and a lofu server (LOFU_URL,
 * LOFU_TOKEN; LOFU_CORS_ORIGINS=http://127.0.0.1:8790) with the test articles:
 *   lofu add https://www.paulgraham.com/greatwork.html
 *   lofu add https://www.ruanyifeng.com/blog/2019/09/react-hooks.html
 * The first needs a highlight saved without context, as Raindrop imports
 * them: POST /v1/bookmarks/{id}/highlights {"quote":"the shape of the intersection"}.
 *
 *   bun e2e/web.ts
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { connect, launch, openByTitle } from "./cdp.ts";

const SERVER = process.env.LOFU_URL ?? "http://127.0.0.1:8797";
const TOKEN = process.env.LOFU_TOKEN ?? "";
const APP = process.env.READER_URL ?? "http://127.0.0.1:8790/";
const SHOTS = resolve(import.meta.dir, "screens");
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
  if (!ok) failures++;
}
type Highlight = { id: string; quote: string; prefix: string; suffix: string };
async function api<T>(method: string, path: string): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await res.json().catch(() => null)) as T;
}
const bookmarkId = async (title: string) =>
  (
    await api<{ items: { id: string; title: string }[] }>("GET", "/v1/bookmarks?limit=100")
  ).items.find((b) => b.title.includes(title))!.id;

/**
 * Is `quote` drawn as its own run (the decoration splits the text there)? A
 * quote that wraps is split again at the line break, so consecutive runs that
 * spell it count too.
 */
const isDecorated = (quote: string) => `(() => {
  // Line breaks drop the space between the runs: compare without whitespace.
  const want = ${JSON.stringify(quote)}.replace(/\\s+/g, "");
  const runs = [...document.querySelectorAll("span.nsh-run")].map(s => s.textContent);
  for (let i = 0; i < runs.length; i++) {
    let text = "";
    for (let j = i; j < runs.length && text.length < want.length; j++) {
      text += runs[j].replace(/\\s+/g, "");
      if (text === want) return true;
    }
  }
  return false;
})()`;

// Wide enough for the library's title beside its controls, as the Mac's window keeps.
const page = await launch({
  profile: process.env.READER_PROFILE ?? "/tmp/lofu-reader-e2e",
  width: 1100,
  height: 1000,
});
try {
  await page.goto(APP);
  await connect(page, SERVER, TOKEN);

  // ---- English: the long essay ----
  const pg = await bookmarkId("How to Do Great Work");
  for (const h of await api<Highlight[]>("GET", `/v1/bookmarks/${pg}/highlights`)) {
    if (h.quote !== "the shape of the intersection") await api("DELETE", `/v1/highlights/${h.id}`);
  }
  await openByTitle(page, "How to Do Great Work");
  const opened = Date.now();
  await page.waitForText("The following recipe assumes");
  console.log(`  article shown ${Date.now() - opened} ms after the tap`);
  await page.waitForText("1 highlight", 5000).catch(() => null);
  await Bun.sleep(200);
  check(
    "a saved highlight (no context) is drawn in place",
    await page.eval<boolean>(isDecorated("the shape of the intersection")),
  );

  // A mouse drag selects (nsh 0.5; in 0.4 it didn't: longbridge/nsh#1004).
  const target = "decide what to work on";
  const box = await page.waitForText(target);
  await page.drag(box.x + 1, box.y + box.h / 2, box.x + box.w - 1, box.y + box.h / 2);
  const bubble = await page.waitForText("=Highlight", 3000).catch(() => null);
  check("a mouse drag selects text and shows the Highlight bubble", Boolean(bubble));
  console.log(`  screenshot: ${await page.screenshot(SHOTS, "web-selection")}`);
  if (bubble) await page.clickText("=Highlight");
  await page.waitForText("2 highlights", 5000).catch(() => null);
  const saved = (await api<Highlight[]>("GET", `/v1/bookmarks/${pg}/highlights`)).find((h) =>
    h.quote.includes("what to work"),
  );
  check(
    "the server got a text-quote anchor with context",
    Boolean(saved && saved.prefix.length > 10 && saved.suffix.length > 10),
    JSON.stringify(saved),
  );
  check("the new highlight is drawn", await page.eval<boolean>(isDecorated(saved?.quote ?? "?")));
  console.log(`  screenshot: ${await page.screenshot(SHOTS, "web-highlighted")}`);

  // Reload: it must come back in the same place.
  await page.goto(APP);
  await openByTitle(page, "How to Do Great Work");
  await page.waitForText("2 highlights");
  await Bun.sleep(300);
  check(
    "after a reload the highlight is back in place",
    await page.eval<boolean>(isDecorated(saved?.quote ?? "?")),
  );

  // A press inside it offers Remove.
  const inside = await page.waitForText(saved?.quote ?? target);
  await page.click(inside.x + inside.w / 2, inside.y + inside.h / 2);
  const remove = await page.waitForText("Remove highlight", 3000).catch(() => null);
  check("a press inside a highlight offers Remove", Boolean(remove));
  if (remove) await page.clickText("Remove highlight");
  await page.waitForText("1 highlight", 5000).catch(() => null);
  const left = await api<Highlight[]>("GET", `/v1/bookmarks/${pg}/highlights`);
  check(
    "Remove deletes it on the server",
    left.length === 1,
    JSON.stringify(left.map((h) => h.quote)),
  );

  // ---- Chinese ----
  await page.goto(APP);
  const zh = await bookmarkId("React Hooks");
  for (const h of await api<Highlight[]>("GET", `/v1/bookmarks/${zh}/highlights`)) {
    await api("DELETE", `/v1/highlights/${h.id}`);
  }
  await openByTitle(page, "React Hooks 入门教程");
  const zhText = "组件尽量写成纯函数";
  const zhBox = await page.scrollTo(zhText);
  await page.drag(zhBox.x + 1, zhBox.y + zhBox.h / 2, zhBox.x + zhBox.w - 1, zhBox.y + zhBox.h / 2);
  if (await page.waitForText("=Highlight", 3000).catch(() => null))
    await page.clickText("=Highlight");
  await page.waitForText("1 highlight", 5000).catch(() => null);
  const zhSaved = (await api<Highlight[]>("GET", `/v1/bookmarks/${zh}/highlights`))[0];
  check(
    "Chinese text highlights too",
    Boolean(zhSaved?.quote.includes("纯函数")),
    JSON.stringify(zhSaved),
  );
  check("and is drawn", await page.eval<boolean>(isDecorated(zhSaved?.quote ?? "?")));
  console.log(`  screenshot: ${await page.screenshot(SHOTS, "web-chinese")}`);

  if (page.console.length) console.log("  console:", page.console.slice(0, 10));
} catch (e) {
  check("web e2e run", false, (e as Error).stack ?? String(e));
  console.log(`  screenshot: ${await page.screenshot(SHOTS, "web-failure").catch(() => "-")}`);
} finally {
  await page.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
