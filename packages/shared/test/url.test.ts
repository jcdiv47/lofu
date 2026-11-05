import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "../src/url.ts";

describe("normalizeUrl", () => {
  test.each([
    ["https://www.Example.com/", "example.com"],
    ["http://example.com:80/a?b=1", "example.com/a?b=1"],
    ["https://example.com:8443/a", "example.com:8443/a"],
    ["https://example.com/a?utm_source=x&b=2&a=1&fbclid=z", "example.com/a?a=1&b=2"],
    ["https://example.com/a#section", "example.com/a"],
    ["https://example.com/#/route", "example.com#/route"],
    ["https://m.example.com/post", "example.com/post"],
    ["https://youtu.be/abc?si=tracking", "youtu.be/abc"],
    ["https://www.youtube.com/watch?v=abc&si=x&t=10", "youtube.com/watch?t=10&v=abc"],
    ["https://example.com/Path/Keep/", "example.com/Path/Keep/"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  test("http and https collapse to one key", () => {
    expect(normalizeUrl("http://a.com/x")).toBe(normalizeUrl("https://a.com/x"));
  });

  test("rejects non-http schemes", () => {
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
    expect(() => normalizeUrl("ftp://a.com")).toThrow();
  });
});
