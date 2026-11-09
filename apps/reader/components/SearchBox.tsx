import {
  type Bounds,
  cleanup,
  computed,
  effect,
  keymap,
  signal,
  untracked,
  type ViewRef,
} from "nsh";
import { hasQuery, parseQuery } from "../../../packages/shared/src/query";
import type { Bookmark } from "../lib/api";
import {
  applySuggestion,
  firstRowIsDefault,
  narrowed,
  recent,
  remember,
  type SuggestRow,
  suggestions,
  typing,
} from "../lib/search";
import { bookmarksIn, collections, type Source } from "../lib/store";
import { setToolbarSuggesting } from "../lib/toolbar";
import { SearchSuggestions } from "./SearchSuggestions";

/**
 * The library's search box, as Raindrop's: what's typed (`query`) and what
 * the list shows (`applied`). On wide windows a search runs when it's
 * committed (Return, a suggestion, a recent search), and while the field has
 * the keyboard a panel under it suggests conditions, their values, and
 * recent searches (`lib/search.ts`); the filter button opens the conditions
 * that narrow the results shown. On phones a search runs as it's typed.
 */
export function useSearchBox(o: {
  source: () => Source;
  /** Search as it's typed (phones): no panel, nothing to commit. */
  live: boolean;
  initial?: string;
  /** The bookmarks the server found for the applied search, once it has. */
  results: () => Bookmark[] | null;
  /** Opens a collection a suggestion names. */
  onSource?: (s: Source) => void;
  /** Puts the keyboard back in the field. */
  focusField: () => void;
  /** The Mac's toolbar field: the keys come from it rather than the app's keymap. */
  nativeField: boolean;
}) {
  const query = signal(o.initial ?? "");
  const applied = signal(o.initial ?? "");
  const open = signal(false);
  const mode = signal<"suggest" | "narrow">("suggest");
  const active = signal(-1);
  const anchor = signal<ViewRef | Bounds | null>(null);

  /** What the counts are of: the source, narrowed by the conditions already typed. */
  const base = (): Bookmark[] => {
    const q = query();
    const t = mode() === "suggest" ? typing(q) : null;
    const others = t ? q.slice(0, t.start) + q.slice(t.end) : q;
    const words = parseQuery(others).text;
    const found = o.results();
    // Words only the server can match: the results found for them.
    const start =
      words && found && words === parseQuery(applied()).text ? found : bookmarksIn(o.source());
    return narrowed(start, others);
  };
  const sections = computed(() =>
    open()
      ? suggestions({
          query: query(),
          mode: mode(),
          base: base(),
          collections: collections().map((c) => ({ id: c.id, name: c.name })),
          recent: recent(),
        })
      : [],
  );
  const rows = () => sections().flatMap((s) => s.rows);

  const show = (m: "suggest" | "narrow") => {
    mode.set(m);
    open.set(true);
    untracked(() => {
      const q = query();
      active.set(
        firstRowIsDefault({ query: q, mode: m, base: [], collections: [], recent: [] }) ? 0 : -1,
      );
    });
  };
  const close = () => {
    open.set(false);
    active.set(-1);
  };

  const commit = (q = query()) => {
    close();
    applied.set(q.trim());
    if (hasQuery(q)) remember(q);
  };

  const pick = (row: SuggestRow) => {
    const a = row.action;
    switch (a.kind) {
      case "replace":
      case "append": {
        const next = applySuggestion(query(), a);
        query.set(next);
        if (a.commit) commit(next);
        else {
          show("suggest");
          o.focusField();
        }
        return;
      }
      case "query":
        query.set(`${a.query} `);
        commit(a.query);
        return;
      case "submit":
        commit();
        return;
      case "source":
        close();
        query.set("");
        applied.set("");
        o.onSource?.(a.source);
    }
  };

  const onChange = (v: string) => {
    query.set(v);
    if (o.live || !v.trim()) applied.set(v.trim());
    if (!o.live) show("suggest");
  };

  const key = (k: "up" | "down" | "enter" | "escape") => {
    if (k === "escape") return close();
    if (k === "enter") {
      const row = open() ? rows()[active()] : undefined;
      return row ? pick(row) : commit();
    }
    const n = rows().length;
    if (!open() || !n) return;
    const i = active();
    active.set(k === "down" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1);
  };

  // Losing the keyboard closes the panel, a moment later: a press on one of
  // its rows takes the keyboard from the field first.
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const onFocus = (at?: ViewRef | Bounds) => {
    if (blurTimer) clearTimeout(blurTimer);
    if (at) anchor.set(at);
    if (!o.live && !open()) show("suggest");
  };
  const onBlur = () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (mode() === "suggest") close();
    }, 250);
  };
  cleanup(() => blurTimer && clearTimeout(blurTimer));

  /** The filter button: the conditions that narrow what's shown, or closes them. */
  const toggleNarrow = (at?: ViewRef | Bounds) => {
    if (at) anchor.set(at);
    if (open() && mode() === "narrow") close();
    else show("narrow");
  };

  // The arrows move through the rows (Return reaches the field's submit,
  // which is `key("enter")`); the Mac's toolbar field hands them over
  // itself (`setToolbarSuggesting`).
  effect(() => {
    const on = open() && rows().length > 0;
    if (o.nativeField) {
      setToolbarSuggesting(on);
      return;
    }
    if (!on) return;
    const off = keymap.bind(
      {
        up: () => key("up"),
        down: () => key("down"),
      },
      { when: "always", repeat: true },
    );
    cleanup(off);
  });
  cleanup(() => {
    if (o.nativeField) setToolbarSuggesting(false);
  });

  const panel = () => (
    <If when={open() && anchor() && (rows().length > 0 || sections().some((s) => s.help))}>
      <SearchSuggestions
        anchor={() => anchor()}
        sections={sections}
        active={active}
        onActive={(i) => active.set(i)}
        onPick={pick}
        onClose={close}
      />
    </If>
  );

  return {
    query,
    applied,
    open,
    onChange,
    onFocus,
    onBlur,
    key,
    commit,
    clear: () => {
      query.set("");
      applied.set("");
      close();
    },
    toggleNarrow,
    setAnchor: (a: ViewRef | Bounds) => anchor.set(a),
    panel,
  };
}
