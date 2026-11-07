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

test("terms mark whole words or word starts, never the inside of a word", () => {
  expect(makeSnippet("Machine Learning in practice", queryMatcher("in")!)).toBe(
    "Machine Learning <mark>in</mark> practice",
  );
  // Prefixes still count: the query may be the start of a longer word.
  expect(makeSnippet("Machine Learning, unlearn, learned", queryMatcher("learn")!)).toBe(
    "Machine <mark>Learn</mark>ing, unlearn, <mark>learn</mark>ed",
  );
  expect(makeSnippet("snake_case and Case", queryMatcher("case")!)).toBe(
    "snake_case and <mark>Case</mark>",
  );
  expect(makeSnippet("Grüße überall, Hüber", queryMatcher("über")!)).toBe(
    "Grüße <mark>über</mark>all, Hüber",
  );
  // Only matches inside words: no snippet rather than a misleading one.
  expect(makeSnippet("Machine only", queryMatcher("in")!)).toBeNull();
});

test("CJK has no spaces: CJK terms match anywhere, Latin words next to CJK still match", () => {
  expect(makeSnippet("函数式编程里的副作用", queryMatcher("作用")!)).toBe(
    "函数式编程里的副<mark>作用</mark>",
  );
  expect(makeSnippet("使用React开发组件，不是preact", queryMatcher("react")!)).toBe(
    "使用<mark>React</mark>开发组件，不是preact",
  );
  expect(makeSnippet("新しいコンポーネント", queryMatcher("コンポ")!)).toBe(
    "新しい<mark>コンポ</mark>ーネント",
  );
});
