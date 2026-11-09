import { deflateSync } from "node:zlib";

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

/** The first bytes of a PNG of `width`×`height` (enough to read its size). */
export function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

/** An article with images: one measurable, one behind hotlink protection, one missing. */
export const PICTURES_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Pangolin Pictures</title></head><body><article><h1>Pangolin Pictures</h1>
${paragraph(1)}<p><img src="/photo.png" alt="A pangolin"></p>${paragraph(2)}
<p><img src="/hotlinked.png" alt="Curled up"></p>${paragraph(3)}
<p><img src="/missing.png" alt="Gone"></p>
${paragraph(4)}</article></body></html>`;

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** A real, decodable PNG of `width`×`height`: grey noise (8-bit greyscale), which compresses as poorly as a photo. */
export function realPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale, no interlace
  const rows = Buffer.alloc((width + 1) * height);
  let seed = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      rows[y * (width + 1) + 1 + x] = seed >>> 24;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
  return new Uint8Array(png);
}

/** How often the fixture site served each path. */
export const served = new Map<string, number>();

/** Local site so tests never touch the network. */
export function startFixtureServer() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      served.set(path, (served.get(path) ?? 0) + 1);
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
      if (path === "/pictures") return html(PICTURES_HTML);
      if (path === "/wide.png") {
        return new Response(realPng(2720, 340), { headers: { "content-type": "image/png" } });
      }
      if (path === "/narrow.png") {
        return new Response(realPng(400, 300), { headers: { "content-type": "image/png" } });
      }
      if (path === "/photo.png") {
        return new Response(pngHeader(640, 480), { headers: { "content-type": "image/png" } });
      }
      if (path === "/hotlinked.png") {
        // As WeChat's image host: another site's page gets a placeholder.
        const size = req.headers.get("referer") ? pngHeader(10, 10) : pngHeader(1200, 300);
        return new Response(size, { headers: { "content-type": "image/png" } });
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
      if (path === "/cf-wall") {
        // Like Cloudflare: challenges a Chrome user agent, serves an honest client.
        if (req.headers.get("user-agent")?.includes("Chrome"))
          return html("<h1>Just a moment...</h1>", 403);
        return html(ARTICLE_HTML);
      }
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
