# lofu app (macOS, iOS, web)

The lofu app on [Native Shell](https://nsh.dev) (nsh 0.4.0): one TSX codebase that runs as an AppKit app on macOS, a UIKit app on iOS, and in the browser. It started as a prototype answering **can an nsh app show a saved article, let you highlight passages, and put the highlights back in the right place?** (yes, see Findings).

- **Layout:** on a Mac (or any window 640+ points wide, not a phone) a sidebar sits beside a card grid, in a window with the app's own title bar. On a phone it's a native navigation stack that opens on *All bookmarks*, with *Library* (the sidebar's contents, as an inset grouped list) one swipe back, as Mail opens on the inbox.
- **Library:** *All bookmarks*, *Unsorted*, *Favorites*, *Highlights*, *Archive*, collections and tags, with counts. Cards show the page's cover, or a catalog card with the excerpt in serif when it has none. Pages the server couldn't read are marked *Unreadable*. Right-click (desktop) or long-press (phone) for Open original, Copy link, Favorite, Archive, and Try reading it again.
- **Data:** a local mirror kept current with `/v1/sync` (`lib/store.ts`), so counts and filters are instant and the last snapshot shows at launch, offline too. Favorite and archive apply at once and roll back if the server refuses. Search goes to the server (`/v1/search`, which knows the article text) and shows its snippets with the matches marked.
- **Reader:** the article's Markdown in a read-only `RichEditor`. Saved highlights are drawn as inline decorations. Selecting text shows a **Highlight** bubble, and a press inside a highlight offers **Remove**.
- **Anchoring:** highlights are W3C text-quote selectors (the quote plus about 32 characters of context on each side), matched with whitespace ignored (`packages/shared/src/anchor.ts`). They survive the article being shown by a different renderer, and highlights imported without context (Raindrop) are placed too. `lib/docIndex.ts` maps between plain-text offsets and ProseMirror document positions.

## Run it

```sh
nsh run apps/reader                     # GTK window on Linux, AppKit on macOS
nsh run apps/reader/App.tsx --target web   # http://127.0.0.1:8790 (server needs LOFU_CORS_ORIGINS=http://127.0.0.1:8790)
nsh run apps/reader --target ios        # on a Mac with Xcode
```

The first launch asks for the server address and a token, and checks them before saving. `nsh package App.tsx --target macos` makes a `.app`; `--target ios-simulator --run` installs one in the simulator.

## Checks

```sh
cd apps/reader && nsh test                    # headless (QuickJS, as on devices)
nsh test --target web --browser <chromium>    # the same tests in a real browser
bun e2e/web.ts                                # the highlight loop with real mouse/keyboard input in Chrome
```

`e2e/web.ts` needs the web dev server, a lofu server with the test articles (listed at the top of the file), and `LOFU_URL`/`LOFU_TOKEN`. It writes screenshots to `e2e/screens/`.

The same flow on the real platforms, with the platform's own clicks and touches against a running server (some bookmarks in a few collections; the test opens the `MLDL` collection and "Mixture of Experts Explained"):

```sh
LOFU_URL=http://127.0.0.1:8787 LOFU_TOKEN=lofu_… bun e2e/apps/run.ts macos [light|dark]
LOFU_URL=… LOFU_TOKEN=… bun e2e/apps/run.ts ios [light|dark]       # the booted simulator
```

It signs in, searches, opens a collection and an article, and writes `e2e/screens/<platform>-<scheme>-*.png`. Look at them: layout regressions don't fail assertions.

## Findings (nsh 0.4.0)

What was verified on the **web target** with real input:

| Works | Notes |
|---|---|
| Long articles | 11,941 words visible about 150 ms after the tap; Wikipedia (8,125 words, 600+ runs) in about 180 ms, with a 6 MB JS heap. |
| CJK text | Chinese renders, selects and highlights. |
| Selection → highlight → reload → remove | `onSelectionChange`, the bubble menu, `textBetween`, and decorations that follow the text. |
| Saved highlights without context | Placed on load (Raindrop imports have no context). |

Problems found, with workarounds:

1. **Web: dragging the mouse doesn't select the right text in `RichEditor`** (read-only or editable). With the editor at the window's left edge a drag selected nothing; beside the sidebar it selects, but the wrong range: dragging across "The following recipe assumes you're very ambitious" selects "g recipe assumes you're very a". Shift+click and Shift+arrow keys select exactly, so highlighting works that way, and `e2e/web.ts` uses them. Upstream: [longbridge/nsh#1004](https://github.com/longbridge/nsh/issues/1004).
2. **Decoration `attrs.style` is ignored**: the text is split at the range but nothing is drawn. `attrs.class` works, so highlights use Tailwind classes.
3. **`RichEditor` loads Markdown, JSON or plain text, but not HTML.** That's fine, because the server keeps Markdown for every article. Raw HTML embeds in the Markdown (`<iframe>`) would show as literal text, so the reader strips them.
4. **`TextView` (the obvious reading component) has no API for reading the selection.** The prototype therefore uses a read-only `RichEditor`, which has one.
5. **Passing a signal's `set` as a bare function** throws "not a live signal" in QuickJS (devices and headless tests) but works in a browser's JS engine. Wrap it: `(v) => sig.set(v)`.
6. **Web: `lifecycle()` is missing** from the web runtime (it's typed and documented): calling it throws at startup. The app checks for it and, on the web, syncs at launch and on request only.
7. **`List` recycles its cells**: a component's setup code runs once per cell, not per item, so anything it computes from props once (a status label, an image-failed flag) leaks to the next item scrolled in. Read props inside JSX or functions, and key per-item state by the item (`components/BookmarkCard.tsx` remembers *which* cover URL failed).

On **macOS and iOS** (Xcode 27 beta, an iPhone Air simulator on iOS 27), with the platforms' own clicks and touches (`e2e/apps`): signing in, the sidebar or the Library page, collections, server search with marked snippets, opening an article, and light and dark mode all work, as do native back (swipe, the header's back button, Escape and Cmd+[ on the Mac) and the system header on iOS (`headerRightSymbol`, large titles).

**Not verified yet:**
- **Selecting text with a long press (iOS) or a drag (macOS), and so highlighting there.** `nsh test`'s synthetic long press and drag over the read-only `RichEditor` select nothing, and on this machine the simulator can't be driven otherwise (`agent-device` needs an Xcode whose simulator service loads on macOS 27.3). Try it by hand: open an article, long-press a word, and look for the **Highlight** bubble.
- **Linux GTK: deferred.** A Linux desktop app isn't a goal for now. Verifying it would need a headless X server (`xorg-server-xvfb` and `xdotool`).
