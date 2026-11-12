import { createApp, VERSION } from "./app.ts";
import { config } from "./config.ts";
import { wire } from "./wire.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
if (config.authDisabled && !LOOPBACK.has(config.host)) {
  console.error(
    `LOFU_AUTH_DISABLED=1 leaves the API open to anyone who can reach it; ` +
      `refusing to listen on ${config.host}. Bind to 127.0.0.1 or turn auth back on.`,
  );
  process.exit(1);
}

const sys = wire(config);
const app = createApp(sys.ctx);

if (sys.ctx.tokens.list().length === 0 && !config.authDisabled) {
  console.warn(
    "no API tokens yet — create one with: bun run --cwd apps/server token create <name>",
  );
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 60,
  maxRequestBodySize: 32 * 1024 * 1024,
});
console.log(
  `lofu ${VERSION} listening on http://${server.hostname}:${server.port} ` +
    `(extract workers: ${config.extractWorkers}, search: ${config.meiliUrl || "disabled"}, ` +
    `browser: ${sys.browser?.description ?? "off"})`,
);

sys.start().catch((e) => {
  // The API stays up without search; the indexer retries on its own once set up.
  console.error("background services failed to start:", e);
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await sys.stop();
    process.exit(0);
  });
}
