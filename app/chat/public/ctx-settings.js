// 11/15 係 C: an addition to the start settings, for a relay the launcher (sync.py) started.
// - CtxSettings: a "Context settings" button in the start settings; it opens its own sheet with the max context length and
//   the conversation memory (K/V) quantization, each "automatic" by default. GET /m/ctx (sync.py ctx --json) gives the
//   values, what "automatic" picks on this PC (marked "Recommended") and, when Strata runs, how far it fits; saving goes
//   through POST /m/settings like the other start settings. Takes effect from the next start.
// - (11/17 W1: the Hugging Face token field that was here is gone. A token for a private repository is put in from a terminal.)
// Loaded after setup.js. Uses h, tr, toast, openSheet, I18n from the page.
"use strict";

const CtxSettings = (() => {
  const label = (n) => `${Math.round(n / 1024)}K`;

  async function call(url, body) {
    let r;
    try {
      r = await fetch(url, body
        ? { method: "POST", headers: { "x-dsh-mobile": "1", "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: JSON.stringify(body) }
        : { cache: "no-store", credentials: "same-origin" });
    } catch {
      throw new Error(tr("Cannot reach the PC"));
    }
    let b = {};
    try { b = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !b.ok) throw new Error(b.error || tr("Failed (HTTP {0})", [r.status]));
    return b;
  }

  function open() {
    const body = h("div", { class: "set-body" }, h("div", { class: "sheet-note muted" }, tr("Reading the settings…")));
    let cur = null;
    // 11/15 夜: each choice shows what pair it would give with the other side as set now (cur.preview, from sync ctx):
    // "ok" plain, "warn" marked tight, "block" not pressable. "Recommended" = what automatic picks with the other side as set.
    const chips = (name, list, setting) => h("div", { class: "set-choices" }, list.map(([v, text]) => {
      const p = (cur.preview && cur.preview[name] && cur.preview[name][String(v)]) || { status: "ok" };
      const autoPick = cur.preview && cur.preview[name] && cur.preview[name].auto;
      const on = String(setting) === String(v);
      const rec = v !== "auto" && autoPick && String(v) === String(autoPick[name]);
      const block = p.status === "block" && !on;
      const b = h("button", { class: `chip${on ? " on" : ""}`, type: "button", "aria-pressed": on ? "true" : "false", disabled: block,
        "aria-disabled": block ? "true" : "false", onclick: () => { if (!block) save({ [name]: v }); } },
        rec ? `${text} · ${tr("Recommended")}` : p.status === "warn" && v !== "auto" ? `${text} · ${tr("Tight")}` : text);
      if (block) { b.style.opacity = "0.35"; b.style.cursor = "not-allowed"; }
      else if (p.status === "warn" && v !== "auto" && !on) b.style.borderColor = "var(--warn)";
      return b;
    }));
    function render() {
      if (!cur) return;
      const c = cur.context;
      const k = cur.kv_format;
      const kids = [
        h("div", { class: "set-group" },
          h("div", { class: "set-label muted small" }, tr("Max context length")),
          chips("context", [["auto", tr("Automatic")], ...c.choices.map((n) => [n, label(n)])], c.setting),
          h("div", { class: "set-note muted small" }, tr("Longer takes more VRAM."))),
        h("div", { class: "set-group" },
          h("div", { class: "set-label muted small" }, tr("Quantization")),
          chips("kv_format", [["auto", tr("Automatic")], ...k.choices.map((x) => [x.value, x.label])], k.setting),
          h("div", { class: "set-note muted small" }, tr("Accuracy and VRAM use both go k8 > k8v4 > k4."))),
      ];
      // only while the settings are the ones Strata runs with (after a change, the number belongs to the old start).
      // The engine's own number, when it gave one, comes before the estimate below.
      const same = cur.running && cur.running.context === c.effective && cur.running.kv_format === k.effective;
      if (cur.kv_limit && same) kids.push(h("div", { class: "sheet-note fit-warn ctx-limit" }, tr("On this PC: up to about {0} tokens.", [I18n.num(cur.kv_limit)])));
      else if (cur.status === "warn") kids.push(h("div", { class: "sheet-note fit-warn ctx-limit" }, tr("Tight on VRAM. It can slow down as the chat gets long.")));
      const anyBlock = Object.values(cur.preview || {}).some((g) => Object.values(g).some((p) => p.status === "block"));
      if (anyBlock) kids.push(h("div", { class: "sheet-note muted small" }, tr("Grayed-out choices don't fit this PC's VRAM.")));
      body.replaceChildren(...kids);
    }
    async function load() {
      cur = await call("/m/ctx");
      render();
    }
    async function save(change) {
      try {
        await call("/m/settings", change);
        toast(tr("Saved. It takes effect at the next start"));
        await load();
      } catch (e) { toast(e.message); }
    }
    openSheet([h("div", { class: "sheet-title" }, tr("Context settings")),
      h("div", { class: "sheet-note muted" }, tr("Takes effect from the next start.")), body]);
    load().catch((e) => body.replaceChildren(h("div", { class: "sheet-note fit-warn" }, e.message)));
  }

  // for the start settings sheet: the button (small, at the end), then the token row
  function extras() {
    const btn = h("button", { class: "btn slim ghost ctx-open", type: "button", onclick: () => open() }, tr("Context settings"));
    const row = h("div", { class: "set-group" });
    const name = "desktop_auto_start";
    // These strings live here to avoid touching the shared locale tables.
    const text = {
      ja: "デスクトップアプリを開くときにモデルを自動で起動する",
      zh: "打开桌面应用时自动启动模型",
      en: "Start the model automatically when opening the desktop app",
    };
    call("/m/settings").then((cur) => {
      if (!cur.schema?.[name]) return;
      const toggle = h("input", { type: "checkbox" });
      toggle.checked = cur.settings[name] !== "off";
      toggle.addEventListener("change", async () => {
        const on = toggle.checked;
        toggle.disabled = true;
        try {
          await call("/m/settings", { [name]: on ? "on" : "off" });
          toast(tr("Saved. It takes effect at the next start"));
        } catch (e) {
          toggle.checked = !on;
          toast(e.message);
        } finally {
          toggle.disabled = false;
        }
      });
      row.append(h("label", {}, toggle, " " + (text[I18n.lang] || text.en)));
    }).catch((e) => { row.textContent = e.message; });
    return [row, h("div", { class: "set-group ctx-open-row" }, btn)];
  }

  return { open, extras };
})();
