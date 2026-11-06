/**
 * Runs the app's real-platform tests against a lofu server:
 *   LOFU_URL=http://127.0.0.1:8787 LOFU_TOKEN=lofu_… bun e2e/apps/run.ts macos [light|dark]
 *   … bun e2e/apps/run.ts ios
 * The server needs some bookmarks: see README "Checks".
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const platform = process.argv[2] ?? "macos";
const scheme = process.argv[3] ?? "dark";
const server = process.env.LOFU_URL;
const token = process.env.LOFU_TOKEN;
if (!server || !token) throw new Error("Set LOFU_URL and LOFU_TOKEN.");

const app = join(dirname(import.meta.path), "../..");
mkdirSync(join(app, "e2e/screens"), { recursive: true });
writeFileSync(
  join(dirname(import.meta.path), "target.ts"),
  `export const target = ${JSON.stringify({
    server,
    token,
    shots: "e2e/screens",
    name: `${platform}-${scheme}`,
    ios: platform === "ios",
    scheme,
  })} as const;\n`,
);
// Named *.e2e.tsx so a plain `nsh test` (headless) leaves it alone; nsh runs
// *.test.tsx files, so it runs from a copy.
const here = dirname(import.meta.path);
const copy = join(here, "library.test.tsx");
copyFileSync(join(here, "library.e2e.tsx"), copy);
const nsh = Bun.which("nsh") ?? join(process.env.HOME ?? "", ".local/bin/nsh");
const run = Bun.spawnSync([nsh, "test", "e2e/apps/library.test.tsx", "--target", platform], {
  cwd: app,
  stdout: "inherit",
  stderr: "inherit",
});
rmSync(copy, { force: true });
process.exit(run.exitCode ?? 1);
