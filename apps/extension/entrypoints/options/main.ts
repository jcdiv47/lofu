import "./style.css";
import { browser } from "wxt/browser";
import { api } from "../../lib/api.ts";
import { send } from "../../lib/messages.ts";
import { getSettings, isConfigured, saveSettings } from "../../lib/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const urlInput = $<HTMLInputElement>("server-url");
const tokenInput = $<HTMLInputElement>("token");
const conn = $("conn");
const autoRepair = $<HTMLInputElement>("auto-repair");
const list = $<HTMLOListElement>("needs-list");

/** Dead links can't be fixed by visiting them. */
const DEAD = /^HTTP (404|410)/;

function setConn(text: string, kind: "ok" | "err" | "" = "") {
  conn.textContent = text;
  conn.className = `conn ${kind}`;
}

async function checkConnection() {
  setConn("checking…");
  try {
    const { data } = await api.health();
    await api.tags(); // proves the token, not just reachability
    setConn(`connected · lofu ${data.version}${data.search ? " · search on" : ""}`, "ok");
    return true;
  } catch (e) {
    setConn((e as Error).message, "err");
    return false;
  }
}

async function loadNeeds() {
  if (!isConfigured(await getSettings())) return;
  try {
    const items = (await api.failed()).filter((b) => !DEAD.test(b.contentError ?? ""));
    $("needs-count").textContent = items.length ? String(items.length) : "";
    $("needs-empty").hidden = items.length > 0;
    list.replaceChildren(
      ...items.map((b) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = b.url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = b.title || b.url;
        const why = document.createElement("span");
        why.className = "why";
        why.textContent = `${b.domain} · ${b.contentError ?? "unreadable"}`;
        li.append(a, why);
        return li;
      }),
    );
  } catch (e) {
    $("needs-empty").hidden = false;
    $("needs-empty").textContent = (e as Error).message;
  }
}

$("server-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    new URL(urlInput.value.trim());
  } catch {
    return setConn("That isn't a valid URL.", "err");
  }
  await saveSettings({ serverUrl: urlInput.value, token: tokenInput.value });
  if (await checkConnection()) void loadNeeds();
});

autoRepair.addEventListener("change", async () => {
  // Repair reads pages as you visit them, so it needs access to all sites.
  if (autoRepair.checked && !(await browser.permissions.request({ origins: ["<all_urls>"] }))) {
    autoRepair.checked = false;
    return;
  }
  await saveSettings({ autoRepair: autoRepair.checked });
  await send({ type: "refresh-repair" });
});

$("refresh").addEventListener("click", async () => {
  await send({ type: "refresh-repair" });
  await loadNeeds();
});

(async () => {
  const s = await getSettings();
  urlInput.value = s.serverUrl;
  tokenInput.value = s.token;
  autoRepair.checked = s.autoRepair;
  if (isConfigured(s) && (await checkConnection())) await loadNeeds();
})();
