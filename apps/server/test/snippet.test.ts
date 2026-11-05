import { expect, test } from "bun:test";
import { makeSnippet, queryMatcher } from "../src/search/snippet.ts";

test("highlights all terms case-insensitively and escapes HTML", () => {
  const re = queryMatcher("Great work")!;
  const s = makeSnippet("Intro <b>text</b>. Doing great WORK needs curiosity; work hard.", re)!;
  expect(s).toBe(
    "Intro &lt;b&gt;text&lt;/b&gt;. Doing <mark>great</mark> <mark>WORK</mark> needs curiosity; <mark>work</mark> hard.",
  );
});

test("windows long text with ellipses", () => {
  const text = `${"lorem ".repeat(200)}needle ${"ipsum ".repeat(200)}`;
  const s = makeSnippet(text, queryMatcher("needle")!)!;
  expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
  expect(s).toContain("<mark>needle</mark>");
  expect(s.length).toBeLessThan(260);
});

test("CJK single characters and regex metacharacters", () => {
  expect(makeSnippet("组件尽量写成纯函数，如果需要副作用", queryMatcher("副作用")!)).toContain(
    "<mark>副作用</mark>",
  );
  expect(makeSnippet("use C++ (and c++)", queryMatcher("c++")!)).toBe(
    "use <mark>C++</mark> (and <mark>c++</mark>)",
  );
  expect(queryMatcher("a")).toBeNull();
  expect(makeSnippet("nothing here", queryMatcher("absent")!)).toBeNull();
});
