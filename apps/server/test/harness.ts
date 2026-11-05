import { afterAll, beforeAll } from "bun:test";
import { createApp } from "../src/app.ts";
import { type Config, config } from "../src/config.ts";
import { wire } from "../src/wire.ts";
import { startFixtureServer } from "./fixtures.ts";

/**
 * Boots a full in-memory server (real workers, real Meilisearch when
 * MEILI_URL is set, local fixture site) and tears it down after the file.
 */
export function setupServer(overrides: Partial<Config> = {}) {
  const site = startFixtureServer();
  const base = `http://localhost:${site.port}`;
  const withSearch = Boolean(process.env.MEILI_URL);
  const sys = wire({
    ...config,
    dbPath: ":memory:",
    authDisabled: false,
    extractWorkers: 2,
    fetchHostIntervalMs: 0, // every fixture URL is on one host
    browser: "off",
    meiliUrl: withSearch ? (process.env.MEILI_URL as string) : "",
    meiliIndex: `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  });
  const app = createApp(sys.ctx);
  const { token } = sys.ctx.tokens.create("test");

  async function api(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const raw = typeof body === "string";
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": raw ? "text/csv" : "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, data, res };
  }

  beforeAll(() => sys.start());
  afterAll(async () => {
    if (withSearch && sys.indexer) {
      await fetch(`${process.env.MEILI_URL}/indexes/${sys.indexer.index}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${process.env.MEILI_MASTER_KEY}` },
      });
    }
    await sys.stop();
    site.stop(true);
  });

  return { sys, app, api, base, withSearch };
}
