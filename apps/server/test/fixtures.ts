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

/** A minimal but valid PDF (xref offsets computed) with a Title and two text lines. */
export function makePdf(title: string, lines: string[]): Uint8Array<ArrayBuffer> {
  const text = lines
    .map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`)
    .join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${title}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

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
        const pdf = makePdf("Quokka Dynamics", [
          "Quokkas are small marsupials found on Rottnest Island off Western Australia.",
          "This paper studies their remarkably photogenic grin.",
        ]);
        return new Response(pdf, { headers: { "content-type": "application/pdf" } });
      }
      if (path === "/broken.pdf") {
        return new Response("%PDF-1.4 not really", {
          headers: { "content-type": "application/pdf" },
        });
      }
      if (path === "/notes.md") {
        return new Response("# Notes\n\nMarkdown served raw about axolotls.", {
          headers: { "content-type": "text/markdown" },
        });
      }
      if (path === "/image.png") {
        return new Response(new Uint8Array([0x89, 0x50]), {
          headers: { "content-type": "image/png" },
        });
      }
      if (path === "/captcha") {
        return html(
          "<html><head><title>验证</title></head><body><p>环境异常</p><p>当前环境异常，完成验证后即可继续访问。</p></body></html>",
        );
      }
      if (path === "/js-app") {
        return html(
          '<html><head><title>Weibo post</title><meta property="og:title" content="A post title"></head><body><div id="app"></div><script src="/app.js"></script></body></html>',
        );
      }
      if (path === "/forbidden") return html("<h1>Forbidden</h1>", 403);
      if (path === "/spa") {
        // Client-rendered: the text only exists after JavaScript runs.
        const text =
          "Rendered client-side: the pangolin is the only mammal covered in scales. ".repeat(8);
        return html(
          `<html><head><title>SPA</title></head><body><div id="root"></div><script>setTimeout(() => { const a = document.createElement("article"); const h = document.createElement("h1"); h.textContent = "Pangolins"; a.append(h); for (let i = 0; i < 3; i++) { const p = document.createElement("p"); p.textContent = ${JSON.stringify(text)}; a.append(p); } document.getElementById("root").append(a); }, 300);</script></body></html>`,
        );
      }
      if (path === "/bot-wall") {
        // Only real browsers (which send Sec-Fetch-* headers) get the page.
        if (req.headers.get("sec-fetch-dest") !== "document") return html("<h1>Go away</h1>", 403);
        return html(ARTICLE_HTML);
      }
      return new Response("nope", { status: 404 });
    },
  });
}
