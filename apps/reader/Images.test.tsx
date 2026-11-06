import { createRichEditor, starterKit } from "nsh/base";
import { expect, test } from "nsh/test";
import type { ArticleImage } from "./lib/api";
import { placeImages } from "./screens/Reader";

const doc = (markdown: string) =>
  createRichEditor({ content: markdown, format: "markdown", plugins: [starterKit()] }).getJSON();

const imageAttrs = (d: ReturnType<typeof doc>) => {
  const out: Record<string, unknown>[] = [];
  const walk = (n: typeof d) => {
    if (n.type === "image") out.push(n.attrs ?? {});
    n.content?.forEach(walk);
  };
  walk(d);
  return out.map(({ src, width, height }) => ({ src, width, height }));
};

const img = (src: string, width: number | null, height: number | null, proxy: string | null) =>
  ({ src, width, height, proxy }) satisfies ArticleImage;

test("images get their size, scaled down to the text, and load through the proxy", () => {
  const d = doc(
    "Text.\n\n![big](https://x.test/big.jpg)\n\n![small](https://x.test/icon.png)\n\n![unknown](https://x.test/gone.png)",
  );
  const placed = placeImages(
    d,
    [
      img("https://x.test/big.jpg", 1728, 1080, "https://lofu.test/img/a?u=big"),
      img("https://x.test/icon.png", 24, 24, "https://lofu.test/img/b?u=icon"),
      img("https://x.test/gone.png", null, null, "https://lofu.test/img/c?u=gone"),
    ],
    600,
  );
  expect(imageAttrs(placed)).toEqual([
    { src: "https://lofu.test/img/a?u=big", width: 600, height: 375 },
    { src: "https://lofu.test/img/b?u=icon", width: 24, height: 24 },
    { src: "https://lofu.test/img/c?u=gone", width: null, height: null },
  ]);
  // The parsed document is kept as it was, for sizing again at another width.
  expect(imageAttrs(d)[0]).toEqual({ src: "https://x.test/big.jpg", width: null, height: null });
});

test("an image whose URL the parser changed is matched by position", () => {
  const d = doc("![a](https://x.test/a%20b.png)");
  const src = String(imageAttrs(d)[0]!.src);
  const placed = placeImages(d, [img(`${src}#other`, 100, 50, null)], 600);
  expect(imageAttrs(placed)).toEqual([{ src, width: 100, height: 50 }]);
});
