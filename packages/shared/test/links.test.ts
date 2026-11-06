import { describe, expect, test } from "bun:test";
import { extractUrl, isRedirectLink, unwrapUrl } from "../src/links.ts";

describe("extractUrl", () => {
  test.each([
    ["https://example.com/a", "https://example.com/a"],
    ["  https://zh.wikipedia.org/wiki/中文  ", "https://zh.wikipedia.org/wiki/中文"],
    [
      "【好物分享】 http://xhslink.com/a/AbC123 复制本条信息，打开【小红书】App查看精彩内容！",
      "http://xhslink.com/a/AbC123",
    ],
    [
      "7.43 复制打开抖音 https://v.douyin.com/iRxYz12/ 看看【作品】",
      "https://v.douyin.com/iRxYz12/",
    ],
    ["Read this: https://example.com/post.", "https://example.com/post"],
    ["(see https://en.wikipedia.org/wiki/Foo_(bar))", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["链接：https://example.com/x，快看", "https://example.com/x"],
    ["Great thread https://t.co/AbCdEf via @someone", "https://t.co/AbCdEf"],
    ["example.com", "https://example.com"],
    ["www.example.com", "https://www.example.com"],
    ["check xhslink.com/a/xyz now", "https://xhslink.com/a/xyz"],
    ["I use Node.js, e.g. daily", null],
    ["no link here", null],
    ["", null],
    ["javascript:alert(1)", null],
  ])("%s", (input, expected) => {
    expect(extractUrl(input)).toBe(expected);
  });
});

describe("unwrapUrl", () => {
  test.each([
    [
      "https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1",
      "https://example.com/a?b=1",
    ],
    ["https://weibo.cn/sinaurl?toasturl=https%3A%2F%2Fexample.com%2F", "https://example.com/"],
    ["https://link.zhihu.com/?target=https%3A//github.com/x/y", "https://github.com/x/y"],
    ["https://www.google.com/url?q=https://example.com/&sa=D", "https://example.com/"],
    ["https://l.facebook.com/l.php?u=https%253A%252F%252Fexample.com%252F", "https://example.com/"],
    ["https://weibo.cn/status/123", "https://weibo.cn/status/123"],
    [
      "https://link.zhihu.com/?target=javascript:alert(1)",
      "https://link.zhihu.com/?target=javascript:alert(1)",
    ],
    ["https://example.com/?u=https://other.com", "https://example.com/?u=https://other.com"],
  ])("%s", (input, expected) => {
    expect(unwrapUrl(input)).toBe(expected);
  });
});

test("isRedirectLink", () => {
  expect(isRedirectLink("https://t.co/abc")).toBe(true);
  expect(isRedirectLink("http://t.cn/A6xyz")).toBe(true);
  expect(isRedirectLink("https://weibo.cn/sinaurl?u=https%3A%2F%2Fexample.com")).toBe(true);
  expect(isRedirectLink("https://x.com/user/status/1")).toBe(false);
  expect(isRedirectLink("not a url")).toBe(false);
});
