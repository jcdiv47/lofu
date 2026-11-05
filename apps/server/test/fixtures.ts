const paragraph = (i: number) =>
  `<p>Paragraph ${i} about the zymurgy of sourdough starters, fermentation curves and crumb structure. ` +
  `Bakers measure hydration carefully because flour absorbs water at different rates.</p>`;

export const ARTICLE_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Sourdough Science | Example Blog</title>
<meta property="og:title" content="Sourdough Science">
<meta property="og:type" content="article">
<meta property="og:image" content="https://example.com/cover.jpg">
<meta name="description" content="A deep dive into fermentation.">
<meta name="author" content="Ada Baker">
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article><h1>Sourdough Science</h1>${Array.from({ length: 12 }, (_, i) => paragraph(i)).join("")}</article>
<footer>© Example Blog · <a href="/privacy">Privacy</a></footer>
</body></html>`;

// "你好世界" repeated, encoded as GBK.
const GBK_HELLO = [0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7];

/** Local site so tests never touch the network. */
export function startFixtureServer() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/article")) {
        return new Response(ARTICLE_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/gbk") {
        const head = Buffer.from('<html><head><meta charset="gbk"><title>');
        const tail = Buffer.from(
          "</title></head><body><article><p>Legacy encodings are still common on older Chinese sites.</p></article></body></html>",
        );
        return new Response(Buffer.concat([head, Buffer.from(GBK_HELLO), tail]), {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/paper.pdf") {
        return new Response("%PDF-1.4 fake", { headers: { "content-type": "application/pdf" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
}
