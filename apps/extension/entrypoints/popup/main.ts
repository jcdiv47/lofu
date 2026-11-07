import "./style.css";
import { browser } from "wxt/browser";
import { api, type Bookmark, type Collection, type TagCount } from "../../lib/api.ts";
import { send } from "../../lib/messages.ts";
import { cacheGet, cacheSet } from "../../lib/settings.ts";

/*
 * Opening the popup saves the page (like Pocket). Everything renders from the
 * tab and the local cache first, so the card appears instantly; the server's
 * answer then stamps it. Edits autosave through the background worker.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = $("card");
const titleEl = $("title");
const statusLine = $("status-line");
const chips = $("chips");
const tagInput = $<HTMLInputElement>("tag-input");
const suggest = $<HTMLDivElement>("suggest");
const collectionSel = $<HTMLSelectElement>("collection");
const note = $<HTMLTextAreaElement>("note");
const favBtn = $<HTMLButtonElement>("fav");
const trashBtn = $<HTMLButtonElement>("trash");
const removeBtn = $<HTMLButtonElement>("remove");
const sync = $("sync");

type State = "saving" | "saved" | "existing" | "removed" | "error";
let bookmark: Bookmark | null = null;
let tags: string[] = [];
let allTags: TagCount[] = [];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const stampDate = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

function setState(state: State) {
  card.dataset.state = state;
  const word = {
    saving: "",
    saved: "Shelved",
    existing: "On shelf",
    removed: "Withdrawn",
    error: "",
  }[state];
  $("stamp-word").textContent = word;
}

function showProblem(text: string, setup: boolean) {
  setState("error");
  $("problem").hidden = false;
  $("problem-text").textContent = text;
  $("open-options").hidden = !setup;
  statusLine.textContent = "not saved";
  statusLine.classList.add("warn");
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
function flashSync(text: string, error = false) {
  sync.textContent = text;
  sync.classList.toggle("err", error);
  sync.style.opacity = "1";
  clearTimeout(syncTimer);
  if (!error) syncTimer = setTimeout(() => (sync.style.opacity = "0"), 1400);
}

// ---- content status line --------------------------------------------------

function describeContent(b: Bookmark): { text: string; warn: boolean } {
  switch (b.contentStatus) {
    case "pending":
      return { text: "reading page…", warn: false };
    case "ok": {
      const words = b.wordCount ? `${b.wordCount.toLocaleString()} words` : "full text";
      return { text: `${b.type} · ${words}`, warn: false };
    }
    case "skipped":
      return { text: `${b.type} · link only`, warn: false };
    case "failed":
      return { text: b.contentError ?? "couldn't read page", warn: true };
  }
}

function renderBookmark(b: Bookmark) {
  bookmark = b;
  if (b.title) titleEl.textContent = b.title;
  $("callno").textContent = `№ ${b.id.slice(-6).toUpperCase()}`;
  $("stamp-date").textContent = stampDate(b.createdAt);
  const { text, warn } = describeContent(b);
  statusLine.textContent = text;
  statusLine.title = text;
  statusLine.classList.toggle("warn", warn);
  favBtn.setAttribute("aria-pressed", String(b.favorite));
  showTrash(b.archived);
}

/** `archived` is the Trash (the API field keeps its old name). */
function showTrash(inTrash: boolean) {
  trashBtn.setAttribute("aria-pressed", String(inTrash));
  trashBtn.textContent = inTrash ? "In Trash" : "Move to Trash";
  trashBtn.title = inTrash ? "Restore from the Trash" : "Move to the Trash";
}

/** Extraction runs server-side after saving; follow it briefly so the card can report it. */
async function followExtraction(id: string) {
  for (let i = 0; i < 30 && bookmark?.id === id && bookmark.contentStatus === "pending"; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 600 : 1500));
    try {
      const fresh = await api.get(id);
      if (bookmark?.id !== id) return;
      renderBookmark({ ...fresh, tags, note: note.value || null }); // keep local edits
    } catch {
      return;
    }
  }
}

// ---- tags -----------------------------------------------------------------

function renderChips() {
  for (const el of chips.querySelectorAll(".chip")) el.remove();
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = t;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove tag ${t}`);
    x.onclick = () => setTags(tags.filter((v) => v !== t));
    chip.append(x);
    chips.insertBefore(chip, tagInput);
  }
}

function setTags(next: string[]) {
  tags = [...new Set(next.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  renderChips();
  patch({ tags });
}

let selected = -1;
function renderSuggestions() {
  const q = tagInput.value.trim().toLowerCase();
  const matches = q
    ? allTags.filter((t) => t.name.includes(q) && !tags.includes(t.name))
    : allTags.filter((t) => !tags.includes(t.name));
  const top = matches
    .sort(
      (a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || b.count - a.count,
    )
    .slice(0, 6);
  suggest.replaceChildren(
    ...top.map((t, i) => {
      const li = document.createElement("div");
      li.role = "option";
      li.setAttribute("aria-selected", String(i === selected));
      li.innerHTML = `<span></span><span class="count"></span>`;
      (li.firstChild as HTMLElement).textContent = t.name;
      (li.lastChild as HTMLElement).textContent = String(t.count);
      li.onmousedown = (e) => {
        e.preventDefault();
        commitTag(t.name);
      };
      return li;
    }),
  );
  const open = top.length > 0 && document.activeElement === tagInput;
  suggest.hidden = !open;
  tagInput.setAttribute("aria-expanded", String(open));
}

function commitTag(value: string) {
  if (value.trim()) setTags([...tags, value]);
  tagInput.value = "";
  selected = -1;
  renderSuggestions();
}

tagInput.addEventListener("input", () => {
  selected = -1;
  if (tagInput.value.includes(",")) {
    const parts = tagInput.value.split(",");
    tagInput.value = parts.pop() ?? "";
    setTags([...tags, ...parts]);
  }
  renderSuggestions();
});
tagInput.addEventListener("focus", renderSuggestions);
tagInput.addEventListener("blur", () => {
  if (tagInput.value.trim()) commitTag(tagInput.value);
  suggest.hidden = true;
});
tagInput.addEventListener("keydown", (e) => {
  const items = [...suggest.querySelectorAll<HTMLElement>("[role=option]")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    for (const [i, li] of items.entries()) li.setAttribute("aria-selected", String(i === selected));
  } else if (e.key === "Enter" || (e.key === "Tab" && selected >= 0)) {
    const pick = selected >= 0 ? items[selected]?.firstChild?.textContent : tagInput.value;
    if (pick?.trim()) {
      e.preventDefault();
      commitTag(pick);
    }
  } else if (e.key === "Backspace" && !tagInput.value && tags.length) {
    setTags(tags.slice(0, -1));
  }
});
chips.addEventListener("click", () => tagInput.focus());

// ---- other edits --------------------------------------------------------------

function patch(p: Parameters<typeof api.update>[1]) {
  if (!bookmark) return;
  const id = bookmark.id;
  flashSync("saving…");
  void send({ type: "patch", id, patch: p }).then((r) => {
    if (r.ok) flashSync("saved");
    else flashSync(r.error, true);
  });
}

function renderCollections(cols: Collection[]) {
  const current = collectionSel.value;
  collectionSel.replaceChildren(new Option("Unsorted", ""));
  // Flatten the tree, indenting children.
  const byParent = new Map<string | null, Collection[]>();
  for (const c of cols) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      collectionSel.add(new Option(`${" ".repeat(depth)}${c.name}`, c.id));
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  collectionSel.value = bookmark?.collectionId ?? current;
}

collectionSel.addEventListener("change", () =>
  patch({ collectionId: collectionSel.value || null }),
);
note.addEventListener("input", () => patch({ note: note.value.trim() || null }));
favBtn.addEventListener("click", () => {
  const on = favBtn.getAttribute("aria-pressed") !== "true";
  favBtn.setAttribute("aria-pressed", String(on));
  patch({ favorite: on });
});
trashBtn.addEventListener("click", () => {
  const on = trashBtn.getAttribute("aria-pressed") !== "true";
  showTrash(on);
  patch({ archived: on });
});

removeBtn.addEventListener("click", async () => {
  if (!bookmark) return;
  if (card.dataset.state === "removed") {
    // Undo: re-save with the same metadata (the server revives the same id).
    const r = await send({
      type: "restore",
      bookmark: { ...bookmark, tags, note: note.value || null },
    });
    if (r.ok && r.bookmark) {
      renderBookmark(r.bookmark);
      setState("saved");
      removeBtn.textContent = "Delete";
    } else if (!r.ok) flashSync(r.error, true);
    return;
  }
  const r = await send({ type: "remove", id: bookmark.id });
  if (!r.ok) return flashSync(r.error, true);
  setState("removed");
  removeBtn.textContent = "Undo";
  statusLine.textContent = "deleted from your shelves";
});

$("open-options").addEventListener("click", () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

// ---- boot ---------------------------------------------------------------------

async function boot() {
  // `?tab=<id>` targets a specific tab (used by the e2e test, which opens the
  // popup page in a regular tab); normally it's the active tab.
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  const tab = forced
    ? await browser.tabs.get(forced)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return showProblem("No active tab.", false);
  titleEl.textContent = tab.title || tab.url || "Untitled";
  try {
    $("domain").textContent = new URL(tab.url ?? "").hostname.replace(/^www\./, "");
  } catch {}

  // Instant: cached tag/collection lists, refreshed after the save.
  allTags = (await cacheGet<TagCount[]>("tags")) ?? [];
  renderCollections((await cacheGet<Collection[]>("collections")) ?? []);

  const res = await send({ type: "save-tab", tabId: tab.id });
  if (!res.ok) return showProblem(res.error, res.needsSetup);

  tags = res.bookmark.tags;
  note.value = res.bookmark.note ?? "";
  renderChips();
  renderBookmark(res.bookmark);
  collectionSel.value = res.bookmark.collectionId ?? "";
  setState(res.created ? "saved" : "existing");
  if (!res.created && res.captured) statusLine.textContent = "re-captured from your browser";

  void followExtraction(res.bookmark.id);
  void Promise.all([api.tags(), api.collections()])
    .then(async ([t, c]) => {
      allTags = t;
      renderCollections(c);
      await Promise.all([cacheSet("tags", t), cacheSet("collections", c)]);
    })
    .catch(() => {});
}

void boot();
