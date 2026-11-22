# Third-party notices

lofu is MIT-licensed (see [LICENSE](LICENSE)). This file covers the work of
others that it contains, ships or runs.

## Copied into this repository

These files are others' work, kept under their own licenses, whose texts
follow at the end of this file.

| What | Where | From | License |
|---|---|---|---|
| Icons | `apps/reader/assets/icons/*.svg`, taken from or based on Lucide | [Lucide](https://github.com/lucide-icons/lucide); some Lucide icons derive from [Feather](https://github.com/feathericons/feather) | ISC (Lucide), MIT (Feather) |

## Installed by package managers

Dependencies are fetched by `bun install` and `cargo`, not stored here, and
carry their own license files. All are permissive: MIT, ISC, BSD, Apache-2.0,
Zlib or Unicode-3.0, apart from those named below. The main ones:

| Dependency | Used for | License |
|---|---|---|
| [Defuddle](https://github.com/kepano/defuddle) | article extraction and Markdown | MIT |
| [linkedom](https://github.com/WebReflection/linkedom) | DOM for extraction workers | ISC |
| [MathJax](https://github.com/mathjax/MathJax-src) (`mathjax-full`) | TeX to SVG | Apache-2.0 |
| [Hono](https://github.com/honojs/hono), `@hono/zod-openapi` | HTTP API | MIT |
| [Zod](https://github.com/colinhacks/zod) | API schemas | MIT |
| [WXT](https://github.com/wxt-dev/wxt) | browser extension build | MIT |
| [nsh](https://github.com/longbridge/nsh) (`nsh-core`, runtimes) | the reader app; its runtime is part of every app build | Apache-2.0 |
| clap, serde, ureq | the CLI | MIT OR Apache-2.0 |
| IBM Plex Mono, Instrument Sans, Instrument Serif (`@fontsource/*`) | the extension's fonts, bundled into its builds | SIL OFL 1.1 |

When you distribute a build of the extension, include the fonts' OFL notices
(each `@fontsource` package has its `LICENSE`). App builds include nsh's
runtime under Apache-2.0. Build tools that ship nothing, such as lightningcss
(MPL-2.0, used by WXT's bundler), are not listed.

## Run as separate programs

These are not linked into lofu. It starts them or talks to them over the
network, so their licenses don't extend to lofu's code.

| Program | How it's used | License |
|---|---|---|
| [Meilisearch](https://github.com/meilisearch/meilisearch) (Community Edition) | search, its own container | MIT |
| Chromium (`chromedp/headless-shell`, or a local install) | rendering JavaScript-only pages, driven over CDP | BSD-3-Clause and others |
| [poppler-utils](https://poppler.freedesktop.org/) (`pdftotext`, `pdfinfo`) | PDF text, run as subprocesses; installed in the server's Docker image | GPL-2.0 or GPL-3.0 |

A server image you publish contains poppler-utils, a GPL package from
Debian. Its source is available from Debian.

---

## License texts

### Lucide (ISC)

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Feather (MIT), for the Lucide icons derived from it

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
