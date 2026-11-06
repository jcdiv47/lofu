import { expect, test } from "bun:test";
import { markdownToText } from "../src/extract/text.ts";

test("links keep their text, escaped brackets included", () => {
  expect(markdownToText("mail ( [\\[email protected\\]](https://x.test/cdn-cgi/l) ) now")).toBe(
    "mail ( [email protected] ) now",
  );
  expect(markdownToText("see [the docs](https://x.test) and ![a](b.png) here")).toBe(
    "see the docs and here",
  );
});

test("backslash escapes are removed", () => {
  expect(markdownToText("1\\. not a list, a\\_b, \\*star\\*")).toBe("1. not a list, a_b, *star*");
});
