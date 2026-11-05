# lofu reader (nsh prototype)

The reader on [Native Shell](https://nsh.dev) (nsh 0.4.0), built to answer one question before committing to nsh for the iOS, macOS and web apps: **can an nsh app show a saved article, let you highlight passages, and put the highlights back in the right place?**

- **Library:** your saved, extracted bookmarks.
- **Reader:** the article's Markdown in a read-only `RichEditor`. Saved highlights are drawn as inline decorations. Selecting text shows a **Highlight** bubble, and a press inside a highlight offers **Remove**.
- **Anchoring:** highlights are W3C text-quote selectors (the quote plus about 32 characters of context on each side), matched with whitespace ignored (`packages/shared/src/anchor.ts`). They survive the article being shown by a different renderer, and highlights imported without context (Raindrop) are placed too. `lib/docIndex.ts` maps between plain-text offsets and ProseMirror document positions.

## Run it

```sh
nsh run apps/reader                     # GTK window on Linux, AppKit on macOS
nsh run apps/reader/App.tsx --target web   # http://127.0.0.1:8790 (server needs LOFU_CORS_ORIGINS=http://127.0.0.1:8790)
nsh run apps/reader --target ios        # on a Mac with Xcode
```

The first launch asks for the server address and a token.

## Checks

```sh
cd apps/reader && nsh test                    # headless (QuickJS, as on devices)
nsh test --target web --browser <chromium>    # the same tests in a real browser
bun e2e/web.ts                                # the highlight loop with real mouse/keyboard input in Chrome
```

`e2e/web.ts` needs the web dev server, a lofu server with the test articles, and `LOFU_URL`/`LOFU_TOKEN`. It writes screenshots to `e2e/screens/`.

## Findings (nsh 0.4.0)

What was verified on the **web target** with real input:

| Works | Notes |
|---|---|
| Long articles | 11,941 words visible about 150 ms after the tap; Wikipedia (8,125 words, 600+ runs) in about 180 ms, with a 6 MB JS heap. |
| CJK text | Chinese renders, selects and highlights. |
| Selection → highlight → reload → remove | `onSelectionChange`, the bubble menu, `textBetween`, and decorations that follow the text. |
| Saved highlights without context | Placed on load (Raindrop imports have no context). |

Problems found, with workarounds:

1. **Web: dragging the mouse doesn't select text in `RichEditor`** (read-only or editable). Pointer events arrive, and the same synthetic drag selects in a plain `<textarea>`. Shift+click and Shift+arrow keys do select. nsh's own hosted demo behaves the same way. **This would block highlighting on the web until fixed upstream**: [longbridge/nsh#1004](https://github.com/longbridge/nsh/issues/1004).
2. **Decoration `attrs.style` is ignored**: the text is split at the range but nothing is drawn. `attrs.class` works, so highlights use Tailwind classes.
3. **`RichEditor` loads Markdown, JSON or plain text, but not HTML.** That's fine, because the server keeps Markdown for every article. Raw HTML embeds in the Markdown (`<iframe>`) would show as literal text, so the reader strips them.
4. **`TextView` (the obvious reading component) has no API for reading the selection.** The prototype therefore uses a read-only `RichEditor`, which has one.
5. **Passing a signal's `set` as a bare function** throws "not a live signal" in QuickJS (devices and headless tests) but works in a browser's JS engine. Wrap it: `(v) => sig.set(v)`.

**Not verified yet:**
- **Linux GTK: deferred.** A Linux desktop app isn't a goal for now. Verifying it would need a headless X server (`xorg-server-xvfb` and `xdotool`).
- **iOS and macOS:** they need a Mac. iOS matters most for a read-later app. Long-press selection plus the bubble menu on iOS is the next thing to try.
