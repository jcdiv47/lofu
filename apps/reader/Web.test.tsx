import { expect, test } from "nsh/test";
import { isAppLinkRefusal } from "./lib/web";

const denied = (url: string) => ({
  message: `navigation to ${url} is not granted`,
  code: "ERR_ACCESS_DENIED",
});

test("a page handing off to its app is not a failed load", () => {
  expect(
    isAppLinkRefusal(
      denied(
        "zhihu://articles/1903759269918118959?share_code=5xPuEAFwgKuH&callback_source=search_main",
      ),
    ),
  ).toBe(true);
  expect(isAppLinkRefusal(denied("intent://scan/#Intent;scheme=zxing;end"))).toBe(true);
  expect(isAppLinkRefusal(denied("weixin://dl/business"))).toBe(true);
});

test("other errors still show", () => {
  expect(isAppLinkRefusal(denied("https://example.com/"))).toBe(false);
  expect(isAppLinkRefusal(denied("http://example.com/"))).toBe(false);
  expect(isAppLinkRefusal({ message: "The Internet connection appears to be offline." })).toBe(
    false,
  );
  expect(isAppLinkRefusal({ message: "zhihu://articles/1 failed", code: "ERR_NETWORK" })).toBe(
    false,
  );
});
