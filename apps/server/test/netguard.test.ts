import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ImageProxy } from "../src/extract/images.ts";
import {
  allowPrivateNetworks,
  assertPublicUrl,
  BlockedAddressError,
  isPrivateAddress,
  publicFetch,
} from "../src/extract/netguard.ts";
import { setupServer } from "./harness.ts";

test.each([
  ["127.0.0.1", true],
  ["10.1.2.3", true],
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["172.32.0.1", false],
  ["192.168.1.1", true],
  ["100.100.100.100", true], // Tailscale
  ["169.254.169.254", true],
  ["0.0.0.0", true],
  ["224.0.0.1", true],
  ["255.255.255.255", true],
  ["8.8.8.8", false],
  ["93.184.215.14", false],
  ["::", true],
  ["::1", true],
  ["[::1]", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:8.8.8.8", false],
  ["64:ff9b::a00:1", true], // NAT64 of 10.0.0.1
  ["2002:c0a8:101::1", true], // 6to4 of 192.168.1.1
  ["fd7a:115c:a1e0::1", true], // Tailscale ULA
  ["fe80::1%en0", true],
  ["ff02::1", true],
  ["2606:4700:4700::1111", false],
  ["not-an-ip", true],
])("isPrivateAddress(%p) is %p", (ip, want) => {
  expect(isPrivateAddress(ip)).toBe(want);
});

describe("with private networks refused", () => {
  beforeAll(() => allowPrivateNetworks(false));
  afterAll(() => allowPrivateNetworks(true));

  test.each([
    "http://127.0.0.1:8787/v1/bookmarks",
    "http://localhost/",
    "http://app.localhost/",
    "http://[::1]/",
    "http://2130706433/", // 127.0.0.1 as one number
    "http://0x7f.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/admin",
    "file:///etc/passwd",
  ])("%s is refused", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  test("a public IP passes without a DNS lookup", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });

  test("every redirect hop is checked", async () => {
    const seen: string[] = [];
    const fake = async (url: string, init: RequestInit) => {
      seen.push(url);
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/secret" } });
    };
    await expect(publicFetch("https://8.8.8.8/start", {}, fake)).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
    expect(seen).toEqual(["https://8.8.8.8/start"]);
  });

  test("redirects between public hosts are followed", async () => {
    const fake = async (url: string) =>
      url.endsWith("/start")
        ? new Response(null, { status: 301, headers: { location: "/end" } })
        : new Response("done");
    const res = await publicFetch("https://8.8.8.8/start", {}, fake);
    expect(await res.text()).toBe("done");
  });

  test("the image proxy won't fetch a private address it signed", async () => {
    const proxy = new ImageProxy(new Uint8Array(32));
    const path = proxy.path("http://127.0.0.1:1/a.png")!;
    const u = new URL(path, "http://x");
    const res = await proxy.serve(u.pathname.split("/")[2]!, u.searchParams.get("u")!);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("refusing private address");
  });
});

describe("saving a page on a private network", () => {
  const { sys, api, base } = setupServer({ fetchPrivate: false });
  // The setting is process-wide: set it again after the block above restored it.
  beforeAll(() => allowPrivateNetworks(false));

  test("fails for good instead of fetching it", async () => {
    const r = await api("POST", "/v1/bookmarks", { url: `${base}/article` });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}`)).data;
    expect(b.contentStatus).toBe("failed");
    expect(b.contentError).toContain("refusing");
  });

  test("images in HTML a client sent aren't probed on the LAN", async () => {
    const r = await api("POST", "/v1/bookmarks", {
      url: "https://example.com/lan-image",
      html: `<html><head><title>LAN image</title></head><body><article><p>${"Words about a picture. ".repeat(40)}</p><img src="${base}/photo.png" alt="lan"></article></body></html>`,
    });
    await sys.runner.idle();
    const b = (await api("GET", `/v1/bookmarks/${r.data.id}?content=markdown`)).data;
    expect(b.contentStatus).toBe("ok");
    const img = b.images.find((i: { src: string }) => i.src.includes("/photo.png"));
    expect(img?.width ?? null).toBeNull();
  });

  afterAll(() => allowPrivateNetworks(true));
});
