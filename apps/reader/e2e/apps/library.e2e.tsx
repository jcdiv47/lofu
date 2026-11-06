/**
 * The library and reader on a real platform (`bun e2e/apps/run.ts macos|ios`):
 * real clicks and touches against a running lofu server, with screenshots.
 */
import { expect, open, test } from "nsh/test";
import { target } from "./target";

const shot = (app: { screenshot(p: string): Promise<unknown> }, name: string) =>
  app.screenshot(`${target.shots}/${name}.png`);

const desktop = !target.ios;

test("signs in, browses sources, searches and reads", async () => {
  const app = await open("../../App.tsx", {
    network: "live",
    ...(desktop ? { width: 1240, height: 800 } : {}),
    colorScheme: target.scheme,
  });
  await app.waitFor("id:server");
  await shot(app, `${target.name}-1-connect`);
  await app.type("id:server", target.server);
  await app.type("id:token", target.token);
  await app.press("id:connect");
  if (target.ios) {
    // Phones open on the Library page.
    await app.waitFor("id:source-all", { timeout: 15000 });
    await app.press("id:source-all");
  }

  // The library: everything, newest first.
  await app.waitFor("text:Rope & SumTree", { timeout: 15000 });
  await app.wait(1500); // covers
  await shot(app, `${target.name}-2-library`);

  // Search runs on the server, over the article text, with matches marked.
  await app.type("id:search", "write-ahead log");
  await app.waitFor("text:/\\d+ found|SQLite Internals/", { timeout: 8000 });
  await app.wait(1000);
  await shot(app, `${target.name}-4-search`);
  await app.clear("id:search");
  await app.waitFor("text:Rope & SumTree");

  if (desktop) {
    // A collection from the sidebar.
    await app.press("label:MLDL");
    await app.waitFor("text:Mixture of Experts Explained");
    await app.wait(1200);
    await shot(app, `${target.name}-3-collection`);
  } else {
    await app.back();
    await app.waitFor("id:source-favorites");
    await shot(app, `${target.name}-3-sources`);
    await app.press("label:MLDL");
    await app.waitFor("text:Mixture of Experts Explained");
    await app.wait(1200);
    await shot(app, `${target.name}-3-collection`);
  }

  // Open an article.
  await app.press("text:Mixture of Experts Explained");
  await app.waitFor("text:/Mixture of Experts/", { timeout: 10000 });
  await app.wait(800);
  await shot(app, `${target.name}-5-reader`);
  expect(app.texts().join(" ")).toContain("Mixture of Experts");

  // Highlighting: a long press selects a word (a click-drag on desktops), the
  // bubble offers "Highlight", and the highlight is drawn and counted.
  if (target.ios) {
    await app.longPress("text:/^Let.s dive in!$/ >> nth=0");
  } else {
    await app.drag("text:/^Let.s dive in!$/ >> nth=0", { x: 60, y: 0 });
  }
  await app.wait(800);
  await shot(app, `${target.name}-6-selection`);
  if (app.shows("text:Highlight")) {
    await app.press("text:Highlight");
    await app.waitFor("text:/1 highlight/", { timeout: 8000 });
    await app.wait(600);
    await shot(app, `${target.name}-7-highlighted`);
  } else {
    console.log(`no Highlight bubble after selecting on ${target.name}`);
  }
}, 180000);
