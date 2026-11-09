import { describe, expect, test } from "bun:test";
import {
  dateRange,
  formatTerm,
  hasQuery,
  type Matchable,
  matchesTerm,
  parseQuery,
  pending,
  tokenize,
} from "../src/query.ts";

describe("parseQuery", () => {
  test("words and conditions", () => {
    expect(parseQuery("#homelab type:link openwrt")).toEqual({
      text: "openwrt",
      terms: [
        { kind: "tag", tag: "homelab", not: false },
        { kind: "type", type: "link", not: false },
      ],
    });
  });

  test("a dash excludes a condition; words keep theirs for Meilisearch", () => {
    expect(parseQuery("-#homelab -type:link -draft")).toEqual({
      text: "-draft",
      terms: [
        { kind: "tag", tag: "homelab", not: true },
        { kind: "type", type: "link", not: true },
      ],
    });
  });

  test("tags are lowercased and may be quoted", () => {
    expect(parseQuery('#MLDL #"two words"').terms).toEqual([
      { kind: "tag", tag: "mldl", not: false },
      { kind: "tag", tag: "two words", not: false },
    ]);
  });

  test("flags; false is the opposite", () => {
    expect(parseQuery("notag:true note:true highlights:true favorite:false").terms).toEqual([
      { kind: "notag", not: false },
      { kind: "note", not: false },
      { kind: "highlights", not: false },
      { kind: "favorite", not: true },
    ]);
  });

  test("dates", () => {
    expect(parseQuery("created:2026-11 created:<2026 created:>2026-11-08").terms).toEqual([
      { kind: "created", date: { op: "=", year: 2026, month: 11 }, not: false },
      { kind: "created", date: { op: "<", year: 2026 }, not: false },
      { kind: "created", date: { op: ">", year: 2026, month: 11, day: 8 }, not: false },
    ]);
  });

  test("title and address", () => {
    expect(parseQuery('info:"deep learning" link:github').terms).toEqual([
      { kind: "info", text: "deep learning", not: false },
      { kind: "link", text: "github", not: false },
    ]);
  });

  test("unfinished conditions narrow nothing and aren't words", () => {
    for (const q of [
      "#",
      "type:",
      "type:pdf",
      "created:",
      "created:<",
      "created:nov",
      "-#",
      "note:",
    ]) {
      expect(parseQuery(q)).toEqual({ text: "", terms: [] });
      expect(hasQuery(q)).toBe(false);
    }
    expect(pending("type:")).toBe(true);
    expect(pending("type:link")).toBe(false);
    expect(pending("homelab")).toBe(false);
  });

  test("an unknown key is a word", () => {
    expect(parseQuery("https://example.com foo:bar")).toEqual({
      text: "https://example.com foo:bar",
      terms: [],
    });
  });
});

test("tokenize keeps quoted spaces and positions", () => {
  expect(tokenize(' #"a b"  x ')).toEqual([
    { raw: '#"a b"', start: 1, end: 7 },
    { raw: "x", start: 9, end: 10 },
  ]);
});

describe("dateRange", () => {
  const day = Date.UTC(2026, 10, 8);
  test("a day, a month, a year (UTC)", () => {
    expect(dateRange({ op: "=", year: 2026, month: 11, day: 8 })).toEqual({
      from: day,
      to: day + 86_400_000,
    });
    expect(dateRange({ op: "=", year: 2026, month: 12 })).toEqual({
      from: Date.UTC(2026, 11, 1),
      to: Date.UTC(2027, 0, 1),
    });
    expect(dateRange({ op: "<", year: 2026 })).toEqual({ to: Date.UTC(2026, 0, 1) });
    expect(dateRange({ op: ">", year: 2026, month: 11 })).toEqual({ from: Date.UTC(2026, 11, 1) });
  });
  test("in the user's time zone", () => {
    // Midnight in Beijing (UTC+8) is 16:00 the day before in UTC.
    expect(dateRange({ op: "=", year: 2026, month: 11, day: 8 }, 480).from).toBe(
      day - 8 * 3_600_000,
    );
  });
});

test("matchesTerm", () => {
  const b: Matchable = {
    url: "https://github.com/x/y",
    title: "Tailscale 基础教程",
    excerpt: null,
    note: " ",
    type: "article",
    tags: ["homelab"],
    favorite: false,
    created: Date.UTC(2026, 1, 24, 12),
    highlights: 0,
  };
  const t = (q: string) => parseQuery(q).terms[0]!;
  expect(matchesTerm(b, t("#homelab"))).toBe(true);
  expect(matchesTerm(b, t("-#homelab"))).toBe(false);
  expect(matchesTerm(b, t("type:article"))).toBe(true);
  expect(matchesTerm(b, t("notag:true"))).toBe(false);
  expect(matchesTerm(b, t("note:true"))).toBe(false); // blank notes don't count
  expect(matchesTerm(b, t("created:2026-02"))).toBe(true);
  expect(matchesTerm(b, t("created:>2026-02"))).toBe(false);
  expect(matchesTerm(b, t("info:tailscale"))).toBe(true);
  expect(matchesTerm(b, t("link:GITHUB"))).toBe(true);
});

test("formatTerm round-trips", () => {
  for (const q of [
    "#homelab",
    '#"two words"',
    "-type:link",
    "notag:true",
    "-note:true",
    "created:<2026-11",
    "created:2026-11-08",
    "info:x",
  ]) {
    expect(formatTerm(parseQuery(q).terms[0]!)).toBe(q);
  }
});
