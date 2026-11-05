import { expect, open, test } from "nsh/test";

test("first launch asks for the server", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("text:Your server");
  expect(app.texts()).toContain("SERVER ADDRESS");
  expect(app.texts()).toContain("API TOKEN");
});

test("saving settings opens the library, which reports an unreachable server", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("text:Your server");
  await app.type("id:server", "http://127.0.0.1:9");
  await app.type("id:token", "lofu_test");
  await app.press("text:Save");
  await app.waitFor("text:lofu");
  await app.waitFor("text:Settings");
});
