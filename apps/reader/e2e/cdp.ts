/**
 * Tiny Chrome DevTools Protocol driver for the reader's web-target checks:
 * launches Chrome for Testing (or LOFU_CHROME_PATH), one page, real mouse and
 * keyboard input, screenshots. No Playwright: Bun's WebSocket and ~100 lines.
 */
import { join } from "node:path";
import { findChromium } from "../../server/src/extract/browser.ts";

export async function launch(opts: {
  profile: string;
  width: number;
  height: number;
  headless?: boolean;
}) {
  const exe = findChromium(process.env.LOFU_CHROME_PATH || undefined);
  if (!exe) throw new Error("no Chromium found (set LOFU_CHROME_PATH)");
  const proc = Bun.spawn(
    [
      exe,
      ...(opts.headless === false ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${opts.profile}`,
      `--window-size=${opts.width},${opts.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  // Never leave a browser behind (it would lock the profile for the next run).
  process.on("exit", () => proc.kill());
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
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

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => {
    ws.onopen = r;
  });
  let nextId = 0;
  // biome-ignore lint/suspicious/noExplicitAny: CDP messages are untyped JSON
  const waiting = new Map<number, (m: any) => void>();
  const consoleLines: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id !== undefined) waiting.get(m.id)?.(m);
    else if (m.method === "Runtime.consoleAPICalled") {
      consoleLines.push(
        m.params.args
          .map((a: { value?: unknown; description?: string }) => a.value ?? a.description)
          .join(" "),
      );
    } else if (m.method === "Runtime.exceptionThrown") {
      consoleLines.push(
        `EXCEPTION ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`,
      );
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON
  const send = async (method: string, params: object = {}, sessionId?: string): Promise<any> => {
    const id = ++nextId;
    // biome-ignore lint/suspicious/noExplicitAny: CDP messages are untyped JSON
    const m = await new Promise<any>((r) => {
      waiting.set(id, r);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    waiting.delete(id);
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method: string, params: object = {}) => send(method, params, sessionId);
  await s("Runtime.enable");
  await s("Page.enable");
  await s("Emulation.setDeviceMetricsOverride", {
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const page = {
    console: consoleLines,
    send: s,
    async goto(url: string) {
      await s("Page.navigate", { url });
      await Bun.sleep(1500);
    },
    async eval<T = unknown>(expression: string): Promise<T> {
      const r = await s("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
      return r.result.value as T;
    },
    async screenshot(dir: string, name: string) {
      const { data } = await s("Page.captureScreenshot", { format: "png" });
      const path = join(dir, `${name}.png`);
      await Bun.write(path, Buffer.from(data, "base64"));
      return path;
    },
    async mouse(
      type: "mousePressed" | "mouseReleased" | "mouseMoved",
      x: number,
      y: number,
      buttons = 1,
    ) {
      await s("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mouseReleased" ? 0 : buttons,
        clickCount: 1,
      });
    },
    async click(x: number, y: number) {
      await page.mouse("mouseMoved", x, y, 0);
      await page.mouse("mousePressed", x, y);
      await page.mouse("mouseReleased", x, y);
    },
    /** A real drag, in steps, as a user selecting text. */
    async drag(x1: number, y1: number, x2: number, y2: number, steps = 12) {
      await page.mouse("mouseMoved", x1, y1, 0);
      await page.mouse("mousePressed", x1, y1);
      for (let i = 1; i <= steps; i++) {
        await page.mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
        await Bun.sleep(16);
      }
      await page.mouse("mouseReleased", x2, y2);
    },
    async type(text: string) {
      for (const ch of text) await s("Input.dispatchKeyEvent", { type: "char", text: ch });
    },
    /** A key that types nothing: `Enter`, `Escape`, `ArrowDown`, `ArrowUp`, `Backspace`. */
    async press(key: "Enter" | "Escape" | "ArrowDown" | "ArrowUp" | "Backspace") {
      const code = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 }[key];
      const e = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await s("Input.dispatchKeyEvent", { type: "rawKeyDown", ...e });
      if (key === "Enter") await s("Input.dispatchKeyEvent", { type: "char", text: "\r", ...e });
      await s("Input.dispatchKeyEvent", { type: "keyUp", ...e });
    },
    /** Box of the first rendered text containing `text`, waiting up to `ms` for it. */
    async waitForText(text: string, ms = 10_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const box = await page.eval<{ x: number; y: number; w: number; h: number } | null>(
          locate(text),
        );
        if (box) return box;
        await Bun.sleep(100);
      }
      throw new Error(`text not shown within ${ms} ms: ${text}`);
    },
    /** Scrolls the first text containing `text` to the middle of its scroll view. */
    async scrollTo(text: string) {
      // Wait for it in the page (not necessarily on screen), then bring it into view.
      const end = Date.now() + 10_000;
      while (
        Date.now() < end &&
        !(await page.eval<boolean>(`document.body.textContent.includes(${JSON.stringify(text)})`))
      )
        await Bun.sleep(100);
      await page.eval(`(() => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode())
          if (n.textContent.includes(${JSON.stringify(text)})) { n.parentElement.scrollIntoView({ block: "center" }); return true; }
        return false;
      })()`);
      await Bun.sleep(300);
      return page.waitForText(text);
    },
    async clickText(text: string) {
      const b = await page.waitForText(text);
      await page.click(b.x + Math.min(b.w / 2, 20), b.y + b.h / 2);
    },
    async close() {
      ws.close();
      proc.kill();
    },
  };
  return page;
}

/** Center of the first element whose own text contains `text` (the web target renders text as DOM). */
/** A text's box: the first text containing `text`, or with `=text` the first that is exactly it. */
export const locate = (text: string) => {
  const exact = text.startsWith("=");
  const t = exact ? text.slice(1) : text;
  return `(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = ${exact} ? (n.textContent.trim() === ${JSON.stringify(t)} ? n.textContent.indexOf(${JSON.stringify(t)}) : -1) : n.textContent.indexOf(${JSON.stringify(t)});
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + ${t.length});
    const b = r.getBoundingClientRect();
    // Not drawn, or off-screen (a list's measuring cell, far outside the viewport).
    if (b.width === 0 || b.bottom < 0 || b.top > innerHeight) continue;
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }
  return null;
})()`;
};

/** Fills the reader's settings screen if it is showing (each test run starts from a fresh state). */
export async function connect(
  page: Awaited<ReturnType<typeof launch>>,
  server: string,
  token: string,
) {
  await page.waitForText("lofu", 10_000).catch(() => null);
  if (!(await page.eval<string>("document.body.innerText")).includes("Server address")) return;
  const inputs = await page.eval<{ x: number; y: number }[]>(
    `[...document.querySelectorAll("input,textarea")].map(e => { const b = e.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })`,
  );
  await page.click(inputs[0]!.x, inputs[0]!.y);
  await page.type(server);
  await page.click(inputs[1]!.x, inputs[1]!.y);
  await page.type(token);
  await Bun.sleep(300);
  await page.clickText("Connect");
  // The first click can land while the field still has the focus.
  if (!(await page.waitForText("All bookmarks", 4000).catch(() => null))) {
    await page.clickText("Connect");
    await page.waitForText("All bookmarks");
  }
}

/** Finds a bookmark with the library's search field and opens it. */
export async function openByTitle(page: Awaited<ReturnType<typeof launch>>, title: string) {
  await page.waitForText("All bookmarks");
  const field = await page.eval<{ x: number; y: number }>(
    `(() => { const b = document.querySelector("input").getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`,
  );
  await page.click(field.x, field.y);
  await page.type(title);
  // Wide windows search once the search is committed, as Raindrop's.
  await page.press("Enter");
  await page.waitForText("found");
  await Bun.sleep(500); // the hits render
  await page.clickText(title);
}
