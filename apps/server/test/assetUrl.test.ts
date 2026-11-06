import { expect, test } from "bun:test";
import { assetUrl } from "../src/extract/assetUrl.ts";

const page = "https://colah.github.io/posts/2015-08-Understanding-LSTMs/";

test("relative and protocol-relative image URLs resolve against the page", () => {
  expect(assetUrl("/favicon.ico", page)).toBe("https://colah.github.io/favicon.ico");
  expect(assetUrl("../../favicon.ico", page)).toBe("https://colah.github.io/favicon.ico");
  expect(assetUrl("//cdn.example.com/a.png", page)).toBe("https://cdn.example.com/a.png");
  expect(assetUrl(" https://x.test/a.png ", page)).toBe("https://x.test/a.png");
});

test("data stubs, other schemes and blanks are dropped", () => {
  expect(assetUrl("data:;base64,=", page)).toBeNull();
  expect(assetUrl("javascript:void(0)", page)).toBeNull();
  expect(assetUrl("", page)).toBeNull();
  expect(assetUrl(null, page)).toBeNull();
});
