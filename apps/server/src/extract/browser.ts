import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Semaphore } from "../util/semaphore.ts";
import { detectBlockPage } from "./blocked.ts";
import { assertPublicUrl } from "./netguard.ts";

/**
 * Headless-Chromium fallback for pages a plain fetch can't get: JavaScript
 * apps (Weibo, many SPAs) and JS challenges a real browser passes
 * (Weibo's visitor check, some Cloudflare setups). Talks the Chrome DevTools
 * Protocol directly over Bun's WebSocket: no Playwright/Puppeteer, one
 * long-lived browser, only the handful of CDP calls needed.
 *
 * - Launched on first use and shut down after `idleMs`, so it costs no memory
 *   while nothing needs rendering. Or point it at an external CDP endpoint.
 * - Each render gets a fresh browser context (no cookies shared across sites).
 * - Images, media and fonts are blocked at the network layer, and no request
 *   reaches a private network (netguard.ts).
 * - Instead of a fixed delay, it polls until the page no longer looks like
 *   a challenge/interstitial, then waits briefly for the network to settle.
 *
 * Measured: Weibo's visitor check clears in ~3 s and linux.do's Cloudflare
 * check passes; Medium/V2EX (Turnstile) and Zhihu (login wall) do not. Those
 * need HTML from the user's own browser (the `html` field on save).
 */

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const BLOCKED_RESOURCES = ["Image", "Media", "Font"] as const;
const POLL_MS = 500;
/** Once the page looks real, wait at most this long for network idle. */
const SETTLE_MS = 2_500;
/** Text shorter than this keeps us polling (the SPA hasn't rendered yet). */
const MIN_TEXT = 200;
/** Stop waiting once a not-yet-real page has been unchanged (and the network idle) this long. */
const STABLE_MS = 3_000;
/** Recognized challenge pages get longer: Cloudflare/Weibo checks redirect after ~3-5 s. */
const CHALLENGE_STABLE_MS = 8_000;

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
};

class CdpConnection {
  private nextId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: CdpMessage) => void>();
  closed = false;

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP: ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
      } else {
        for (const l of this.listeners) l(msg);
      }
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CdpConnection(ws));
      ws.onerror = () => reject(new Error(`cannot connect to browser at ${url}`));
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: CDP results are untyped JSON
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(fn: (m: CdpMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.ws.close();
  }
}

export interface RenderResult {
  html: string;
  finalUrl: string;
  status: number | null;
  /**
   * Whether the page ever looked real (enough text, no challenge). When
   * false, `html` is whatever was showing at the deadline: an error page,
   * a challenge, or an app that never rendered.
   */
  ready: boolean;
  /** The challenge/interstitial still showing, if any. */
  challenge: string | null;
}

export type BrowserSource =
  | { kind: "launch"; executable: string; args: string[] }
  | { kind: "connect"; endpoint: string };

/**
 * Finds a Chromium build: explicit path, PATH, the macOS app bundles, then
 * Playwright's download cache (~/.cache on Linux, ~/Library/Caches on macOS).
 */
export function findChromium(explicit?: string): string | null {
  if (explicit) return explicit;
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const p = Bun.which(name);
    if (p) return p;
  }
  if (process.platform === "darwin") {
    for (const app of ["Chromium", "Google Chrome"]) {
      const p = `/Applications/${app}.app/Contents/MacOS/${app}`;
      if (existsSync(p)) return p;
    }
  }
  const home = process.env.HOME;
  if (home) {
    const caches = [
      { dir: ".cache/ms-playwright", glob: "chromium-*/chrome-linux*/chrome" },
      {
        dir: "Library/Caches/ms-playwright",
        glob: "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
      },
    ];
    for (const c of caches) {
      const cwd = join(home, c.dir);
      if (!existsSync(cwd)) continue;
      const found = [...new Bun.Glob(c.glob).scanSync({ cwd, absolute: true })].sort().pop();
      if (found) return found;
    }
  }
  return null;
}

export class Browser {
  private conn: Promise<CdpConnection> | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private profileDir: string | null = null;
  private sem: Semaphore;
  private active = 0;
  private idleTimer: Timer | null = null;

  constructor(
    private source: BrowserSource,
    private opts: { concurrency: number; timeoutMs: number; idleMs: number },
  ) {
    this.sem = new Semaphore(opts.concurrency);
  }

  get description(): string {
    return this.source.kind === "launch" ? this.source.executable : this.source.endpoint;
  }

  private async launch(): Promise<string> {
    if (this.source.kind !== "launch") throw new Error("unreachable");
    this.profileDir = mkdtempSync(join(tmpdir(), "lofu-chrome-"));
    const proc = Bun.spawn(
      [
        this.source.executable,
        "--headless",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--mute-audio",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-extensions",
        ...this.source.args,
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    this.proc = proc;
    // Chromium prints "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/ID".
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        // Keep draining stderr so the pipe never fills and blocks Chromium.
        void (async () => {
          while (!(await reader.read()).done) {}
        })().catch(() => {});
        return m[1]!;
      }
    }
    proc.kill();
    throw new Error(`chromium did not start: ${buf.slice(-300)}`);
  }

  private async connection(): Promise<CdpConnection> {
    if (this.conn) {
      const c = await this.conn.catch(() => null);
      if (c && !c.closed) return c;
      this.shutdown();
    }
    const pending = (async () => {
      let wsUrl: string;
      if (this.source.kind === "launch") {
        wsUrl = await this.launch();
      } else {
        // Chromium answers DevTools requests only for an IP or `localhost` in
        // the Host header (DNS rebinding protection), so a name such as a
        // compose service (`http://browser:9222`) is resolved here first.
        const endpoint = new URL(this.source.endpoint);
        const name = endpoint.hostname.replace(/^\[|\]$/g, "");
        if (!isIP(name) && name !== "localhost") {
          const { address, family } = await lookup(name);
          endpoint.hostname = family === 6 ? `[${address}]` : address;
        }
        const res = await fetch(new URL("/json/version", endpoint), {
          signal: AbortSignal.timeout(5000),
        });
        const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
        // Containers report their internal address; keep the host we were given.
        const ws = new URL(webSocketDebuggerUrl);
        ws.host = endpoint.host;
        wsUrl = ws.toString();
      }
      return CdpConnection.connect(wsUrl);
    })();
    this.conn = pending;
    pending.catch(() => {
      if (this.conn === pending) this.conn = null;
    });
    return pending;
  }

  async render(url: string): Promise<RenderResult> {
    const release = await this.sem.acquire();
    this.active++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      return await this.renderOnce(url);
    } finally {
      release();
      if (--this.active === 0) {
        this.idleTimer = setTimeout(() => this.shutdown(), this.opts.idleMs);
      }
    }
  }

  private async renderOnce(url: string): Promise<RenderResult> {
    const screen = async (p: Record<string, unknown>): Promise<boolean> => {
      if ((BLOCKED_RESOURCES as readonly unknown[]).includes(p.resourceType)) return false;
      const reqUrl = (p.request as { url: string }).url;
      if (!/^https?:/i.test(reqUrl)) return true; // data:, blob: never touch the network
      return assertPublicUrl(reqUrl).then(
        () => true,
        () => false,
      );
    };
    const conn = await this.connection();
    const { browserContextId } = await conn.send("Target.createBrowserContext", {
      disposeOnDetach: true,
    });
    let unlisten = () => {};
    const deadline = Date.now() + this.opts.timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    try {
      const { targetId } = await conn.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      });
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method: string, params: object = {}) => conn.send(method, params, sessionId);

      // In Chromium the main frame's id is the target id, so events that
      // arrive before Page.navigate returns can still be matched.
      const mainFrame = targetId;
      let status: number | null = null;
      let idleAt = 0;
      unlisten = conn.on((m) => {
        if (m.sessionId !== sessionId || !m.method) return;
        const p = m.params ?? {};
        if (m.method === "Fetch.requestPaused") {
          void screen(p)
            .then((ok) =>
              ok
                ? s("Fetch.continueRequest", { requestId: p.requestId })
                : s("Fetch.failRequest", {
                    requestId: p.requestId,
                    errorReason: "BlockedByClient",
                  }),
            )
            .catch(() => {});
        } else if (m.method === "Network.responseReceived") {
          // Last main-document response wins (challenge 403 → redirect → 200).
          if (p.type === "Document" && p.frameId === mainFrame) {
            status = (p.response as { status: number }).status;
          }
        } else if (m.method === "Page.lifecycleEvent" && p.frameId === mainFrame) {
          if (p.name === "networkAlmostIdle") idleAt = Date.now();
          if (p.name === "init") idleAt = 0; // a new document started loading
        }
      });

      await Promise.all([
        s("Network.enable"),
        s("Network.setUserAgentOverride", {
          userAgent: BROWSER_USER_AGENT,
          acceptLanguage: "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          platform: "MacIntel",
        }),
        // Every request pauses here: images, media and fonts are dropped, and
        // the rest must stay off private networks (netguard.ts), redirects
        // included (each hop pauses again).
        s("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
        s("Page.enable"),
        s("Page.setLifecycleEventsEnabled", { enabled: true }),
      ]);

      const nav = await s("Page.navigate", { url });
      if (nav.errorText) throw new Error(`browser navigation failed: ${nav.errorText}`);

      // Poll until the page stops looking like a challenge and has rendered
      // some text, then give the network a moment to settle.
      let lastProbe: { title: string; text: string } | null = null;
      let readyAt = 0;
      let changedAt = Date.now();
      let challenge: string | null = null;
      while (remaining() > 0) {
        await Bun.sleep(POLL_MS);
        const probe = await s("Runtime.evaluate", {
          expression:
            "({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 2000) })",
          returnByValue: true,
        }).catch(() => null);
        const v = probe?.result?.value as { title: string; text: string } | undefined;
        if (!v) continue; // navigating: the execution context is being replaced
        const sig = `${v.title}\n${v.text}`;
        if (sig !== `${lastProbe?.title}\n${lastProbe?.text}`) changedAt = Date.now();
        lastProbe = v;
        challenge = detectBlockPage(v.title, v.text);
        const looksReal = !challenge && v.text.trim().length >= MIN_TEXT;
        if (!looksReal) {
          readyAt = 0;
          // Give up early on a page that has stopped changing: a plain error
          // page never becomes real, while challenges redirect within seconds.
          const stableFor = Date.now() - changedAt;
          if (idleAt > 0 && stableFor >= (challenge ? CHALLENGE_STABLE_MS : STABLE_MS)) break;
          continue;
        }
        if (!readyAt) readyAt = Date.now();
        if (idleAt >= readyAt || Date.now() - readyAt >= SETTLE_MS) break;
      }

      const { result } = await s("Runtime.evaluate", {
        expression: "[document.documentElement.outerHTML, location.href]",
        returnByValue: true,
      });
      if (!Array.isArray(result?.value)) {
        throw new Error(`browser could not read the page (${lastProbe?.title ?? "no title"})`);
      }
      const [html, finalUrl] = result.value as [string, string];
      return { html, finalUrl, status, ready: readyAt > 0, challenge };
    } finally {
      unlisten();
      await conn.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    }
  }

  /** Closes the connection and, if we launched it, the browser process. */
  shutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const conn = this.conn;
    this.conn = null;
    void conn?.then((c) => c.close()).catch(() => {});
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    if (this.profileDir) {
      rmSync(this.profileDir, { recursive: true, force: true });
      this.profileDir = null;
    }
  }
}
