// 11/15 app1115: the start settings, the first-run guide and "stop" choices, for a relay the launcher (sync.py) started.
// - The settings sheet: the model, quality or speed, the RAM limit and the VRAM kept free, each "automatic" by default. They are
//   the launcher's settings.json (GET/POST /m/settings) and take effect at the next start.
// - The first-run guide opens by itself when /m/models says first_run (no model, or a shared part missing): the model to download,
//   how big (the shared parts it needs included), the free space, and the button (11/17: the relay's download list does the rest).
// - "Stop": Strata only, or everything (this page then loses its connection too).
// strata.js (loaded before) gives Models, loadModels, modelsPost, fmtGiB, fmtSpeed, fmtLeft, startStrata, stopStrata.
"use strict";

const Setup = (() => {
  // --- settings ---
  async function settingsCall(body) {
    let r;
    try {
      r = await fetch("/m/settings", body
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

  function openSettingsSheet() {
    const body = h("div", { class: "set-body" }, h("div", { class: "sheet-note muted" }, tr("Reading the settings…")));
    const note = h("div", { class: "sheet-note muted" }, tr("Takes effect from the next start."));
    let cur = null;
    const choice = (label, name, options, help) => h("div", { class: "set-group" },
      h("div", { class: "set-label muted small" }, label),
      h("div", { class: "set-choices" }, options.map(([v, text]) => h("button", {
        class: `chip${String(cur.settings[name]) === String(v) ? " on" : ""}`, type: "button",
        "aria-pressed": String(cur.settings[name]) === String(v) ? "true" : "false",
        onclick: () => save({ [name]: v }),
      }, text))),
      help ? h("div", { class: "set-note muted small" }, help) : null);
    // a number: "automatic" or the value (tap it to type another)
    const number = (label, name, unit, help, placeholder) => {
      const v = cur.settings[name];
      const custom = v !== "auto";
      const ask = () => openPrompt({
        title: label, value: custom ? String(v) : "", placeholder, okLabel: tr("Save"), note: help,
        onSubmit: async (text) => { await save({ [name]: text.replace(/[^\d.]/g, "") }); },
      });
      return h("div", { class: "set-group" },
        h("div", { class: "set-label muted small" }, label),
        h("div", { class: "set-choices" },
          h("button", { class: `chip${custom ? "" : " on"}`, type: "button", "aria-pressed": custom ? "false" : "true", onclick: () => save({ [name]: "auto" }) }, tr("Automatic")),
          h("button", { class: `chip${custom ? " on" : ""}`, type: "button", "aria-pressed": custom ? "true" : "false", onclick: ask },
            custom ? `${I18n.num(v)} ${unit}` : tr("Set a value…"))),
        h("div", { class: "set-note muted small" }, help));
    };
    function modelDirectory() {
      const dir = cur.models_directory;
      if (!dir?.configurable) return null;
      const label = tr("Model directory");
      const help = tr("Finish or cancel model downloads and checks first. After saving, choose Stop everything and reopen Sync-Strata; closing the window alone is not enough. No files are moved or deleted. Models will be read and downloaded in the new folder. Chat history and the existing chat cache location stay unchanged.");
      const automatic = !cur.settings.models_dir || cur.settings.models_dir === "auto";
      return h("div", { class: "set-group" },
        h("div", { class: "set-label muted small" }, label),
        h("div", { class: "set-note small", style: "overflow-wrap: anywhere" }, dir.path),
        h("div", { class: "set-choices" },
          h("button", { class: `chip${automatic ? " on" : ""}`, type: "button", "aria-pressed": String(automatic),
            onclick: async () => {
              if (automatic) return;
              if (await confirmSheet({ title: tr("Use the default model directory?"), message: help, okLabel: tr("Save") })) {
                try { await save({ models_dir: "auto" }); } catch { /* save shows the error */ }
              }
            } }, tr("Automatic")),
          h("button", { class: "chip", type: "button", onclick: () => openPrompt({
            title: label, value: dir.path, placeholder: tr("Absolute folder path"), note: help, maxLength: 4096,
            onSubmit: async (text) => { if (text !== dir.path) await save({ models_dir: text }); },
          }) }, tr("Change folder…"))),
        h("div", { class: "set-note muted small" }, help));
    }
    function render() {
      if (!cur) return;
      if (cur.settings && cur.settings.ram_squeeze == null) cur.settings.ram_squeeze = "auto";   // 11/16: not set = the default, on
      if (cur.settings && cur.settings.refusal_reduction == null) cur.settings.refusal_reduction = "off";   // 11/20 0.1.3: not set = off
      // 11/16 本人: the phone connection moved out of here to its own icon on the session list (Remote.openSheet)
      const models = (cur.models || []).map((m) => (typeof m === "string" ? [m, (modelOf(m) || {}).name || m] : [m.id, m.name || m.id]));
      body.replaceChildren(
        choice(tr("Model"), "model", [["auto", tr("Automatic")], ...models], tr("Automatic: the model that suits this PC")),
        ...[modelDirectory()].filter(Boolean),
        // 11/15 本人: 起動時の tail skip は R4・R7・R10（自動＝この PC に推奨の方）．API を別のソフトから使うときだけ効く
        choice(tr("Tail skip at start"), "tail_skip", [["auto", tr("Automatic")], ...[4, 7, 10].map((r) => [r, Spec.v && Spec.v.recommended_r === r ? `${rLabel(r)} · ${tr("Recommended for this PC")}` : rLabel(r)])],
          tr("Applies only when another program uses the API.")),
        number(tr("RAM limit"), "ram_max_gib", "GiB", tr("Automatic: follows the free RAM"), "20"),
        number(tr("VRAM kept free"), "vram_reserve_mib", "MiB", tr("Automatic"), "1024"),
        // 11/16 係 S4・G2 (本人の決めた文): ram_squeeze = auto（既定．「入」と見せる）か off（「切」）．起動・モデルの切り替えのとき 1 回だけ，
        // ほかのアプリのメモリを追い出して（アプリは閉じない）モデルに回す．
        choice(tr("Memory push-out"), "ram_squeeze", [["auto", tr("Push out")], ["off", tr("Leave alone")]],
          tr("When starting or switching models, other apps' memory is pushed out and given to the model. No apps are closed.")),
        // 11/20 0.1.3 本人の決定: 拒否を減らす（本家 Strata の制御ベクトル．既定は切．次の起動から効く）．文は本人が確認箱で OK
        choice(tr("Fewer refusals (uncensored, experimental)"), "refusal_reduction", [["off", tr("Leave alone")], ["on", tr("Reduce")]],
          tr("With Reduce, the model declines less often. Its safety behavior is weakened too, so you are responsible for what you have it write.")));
      if (typeof CtxSettings !== "undefined") body.append(...CtxSettings.extras());   // 11/15 係 C
      if (typeof UpdateView !== "undefined") body.append(...UpdateView.extras());     // 11/18 係 W9: 更新
    }
    async function save(change) {
      try {
        cur = await settingsCall(change);
        toast(Object.hasOwn(change, "models_dir")
          ? tr("Saved. Stop everything and reopen Sync-Strata to apply the model directory.")
          : tr("Saved. It takes effect at the next start"));
      } catch (e) {
        toast(e.message);
        throw e;
      }
      render();
    }
    openSheet([h("div", { class: "sheet-title" }, tr("Strata settings")), note, body]);   // 11/20 0.1.3 本人: 題は「Strata の設定」
    (Spec.v ? Promise.resolve() : Spec.load()).then(() => settingsCall(null)).then((b) => { cur = b; render(); }, (e) => body.replaceChildren(h("div", { class: "sheet-note fit-warn" }, e.message)));
  }

  // --- stop: Strata only, or everything ---
  function openStopSheet() {
    const sh = openSheet([h("div", { class: "sheet-title" }, tr("Stop")),
      sheetItem("power", tr("Stop Strata"), async () => { sh.close(true); try { await stopStrata(); } catch (e) { toast(e.message); } }),
      sheetItem("stop", tr("Stop everything (this page also disconnects)"), async () => {
        sh.close(true);
        const ok = await confirmSheet({
          title: tr("Stop everything?"),
          message: tr("To use it again, start it on the PC."),
          okLabel: tr("Stop everything"), danger: true,
        });
        if (!ok) return;
        try {
          const r = await fetch("/m/shutdown?what=all", { method: "POST", headers: { "x-dsh-mobile": "1" }, credentials: "same-origin", cache: "no-store" });
          const b = await r.json().catch(() => ({}));
          if (!r.ok || !b.ok) throw new Error(b.error || tr("Failed (HTTP {0})", [r.status]));
          toast(tr("Stopping everything"));
        } catch (e) { toast(e.message); }
      }, "bad"),
      h("button", { class: "btn wide-in ghost", type: "button", onclick: () => sh.close() }, tr("Cancel"))]);
  }

  // --- the first-run guide ---
  // 11/17 W1 (D, E): one model (the recommended one) and one button. Pressing it puts the model on the download list together with
  // the shared parts it lacks (those come first); the relay fetches them one after another. Closing the guide changes nothing: the
  // downloads go on, and the Strata sheet's model list shows them and can add more. There is no screen of shared parts alone.
  let guideOpen = false;
  function openGuide() {
    if (guideOpen) return;
    guideOpen = true;
    const list = h("div", { class: "msel-group" });
    const free = h("div", { class: "sheet-note muted" });
    const title = h("div", { class: "sheet-title" }, tr("Download a model"));
    const intro = h("div", { class: "sheet-note muted" }, tr("Once the download finishes, Strata can start."));
    const all = h("button", { class: "btn wide-in primary", type: "button" }, tr("Getting ready…"));
    const later = h("button", { class: "btn wide-in ghost", type: "button" }, tr("Later"));
    let closed = false;
    let timer = null;

    // the model to show: the one on the download list, the one being checked, the recommended one when none is here yet, or a model
    // that is here but lacks a shared part it needs to start
    function pickModel() {
      const L = Models.list;
      if (!L) return null;
      const ms = (L.models || []).filter((m) => !m.pending);   // 11/15: 準備中のモデルは案内に出さない
      const haveModel = ms.some((m) => m.local.complete);
      const rec = ms.find((m) => m.recommended) || ms[0];
      return ms.find((m) => queueOf(m.id)) || ms.find(dlActive) || (!haveModel ? rec : ms.find((m) => m.local.complete && m.shared_missing && m.shared_missing.length)) || null;
    }
    function row(m) {
      const d = m.download;
      const q = queueOf(m.id);
      const left = m.local.total_bytes - m.local.have_bytes;
      const lines = [h("div", { class: "msel-note" }, tr("Model · {0} to download", [fmtGiB(left)]) + (m.recommended ? tr(" · recommended for this PC") : ""))];
      const acts = [];
      if (dlActive(m)) {
        const [pct, text] = progressText(d);
        const fill = h("div", { class: "ctx-fill" });
        fill.style.width = `${pct}%`;
        lines.push(h("div", { class: "ctx-bar dl-bar" }, fill), h("div", { class: "msel-note dl-text" }, text));
        acts.push(h("button", { class: "btn slim ghost", type: "button", onclick: () => act(() => modelsPost("cancel", m.id)) }, tr("Stop the download")));
      } else if (q) {
        lines.push(h("div", { class: "msel-note" }, tr("Waiting to download")));
        acts.push(h("button", { class: "btn slim ghost", type: "button", onclick: () => act(() => modelsPost("cancel", m.id)) }, tr("Take off the list")));
      } else if (d && d.state === "failed" && d.error) {
        lines.push(h("div", { class: "msel-note fit-warn" }, dlFailText(d)));
      }
      return h("div", { class: "msel-item strata-model" }, h("div", { class: "msel-text" },
        h("div", { class: "msel-name" }, m.name), lines, acts.length ? h("div", { class: "model-acts" }, acts) : null));
    }
    async function act(fn) {
      try { await fn(); } catch (e) { toast(e.message); }
      await loadModels();
      render();
    }
    function render() {
      const L = Models.list;
      if (!L) return;
      const m = pickModel();
      const queued = (L.queue || []).length > 0;
      // what is still to fetch for this model (its own files, and the shared parts that are not on the list yet)
      const need = m ? (m.local.complete ? 0 : m.local.total_bytes - m.local.have_bytes) + (m.shared_bytes || 0) : 0;
      const lacks = !!m && (!m.local.complete || (m.shared_pending && m.shared_pending.length > 0));
      if (!L.first_run && !lacks && !queued) {
        // ready: offer the start
        title.textContent = tr("Ready");
        intro.textContent = tr("Strata can start now.");
        list.replaceChildren();
        free.textContent = "";
        all.textContent = tr("Start Strata");
        all.disabled = !!(Store.S.strata && Store.S.strata.online);
        if (typeof EnvCheck !== "undefined") EnvCheck.guide(list, all);   // 11/15 係 C env: not supported -> no start
        all.onclick = () => {
          const m2 = (L.models || []).find((x) => x.recommended && x.local.complete) || (L.models || []).find((x) => x.local.complete);
          const r = (Spec.v && Spec.v.recommended_r) || (m2 && m2.default_r) || 7;   // 11/15: この PC に推奨の R（R4 か R7）
          if (m2) startStrata(m2.preset, { model: m2.id, r, name: `${m2.name} ${rLabel(r)}` }).catch((e) => toast(e.message));
          sh.close();
        };
        return;
      }
      title.textContent = tr("Download a model");
      intro.textContent = tr("Once the download finishes, Strata can start.");
      const shared = sharedRow(L, () => act(() => stopSharedParts()));
      list.replaceChildren(...(m ? [row(m)] : []), ...(shared ? [shared] : []));
      const fb = (m && m.free_bytes) ?? L.free_bytes;
      free.textContent = fb != null ? tr("Free space: {0} (to download: {1})", [fmtGiB(fb), fmtGiB(need)]) : tr("To download: {0}", [fmtGiB(need)]);
      free.classList.toggle("fit-warn", fb != null && fb < need + 2 * GIB);
      const resume = !!m && m.local.have_bytes + m.local.partial_bytes > 0 && !m.local.complete;
      all.textContent = queued ? tr("Downloading…") : resume ? tr("Resume the download") : tr("Download ({0})", [fmtGiB(need)]);
      all.disabled = queued || !m;
      all.onclick = () => act(() => modelsPost("download", m.id));
      if (typeof EnvCheck !== "undefined") EnvCheck.guide(list, all);   // 11/15 係 C env: not supported -> no download
    }
    async function poll() {
      if (!Spec.v) await Spec.load();   // 11/15: 「Strata を起動」は，この PC に推奨の R で
      await loadModels();
      if (closed) return;
      render();
      timer = setTimeout(poll, Models.list && (Models.list.active || (Models.list.queue || []).length) ? 1000 : 3000);
    }
    later.onclick = () => sh.close();
    const sh = openSheet([title, intro, list, free, all, later], {
      onClose: () => { closed = true; guideOpen = false; clearTimeout(timer); try { sessionStorage.setItem("dsh-setup-later", "1"); } catch { /* private */ } },
    });
    render();
    poll();
  }

  // opens the guide once per page load, when logged in and the relay says first_run (not again after "Later" in this tab)
  let asked = false;
  async function maybeGuide() {
    if (asked || Store.S.conn !== "online") return;
    asked = true;
    try { if (sessionStorage.getItem("dsh-setup-later")) return; } catch { /* private */ }
    await loadModels();
    if (Models.list && Models.list.first_run) openGuide();
  }
  Store.on((topic) => { if (topic === "conn") maybeGuide(); });
  setTimeout(maybeGuide, 1500);

  return { openSettingsSheet, openStopSheet, openGuide, settingsCall, launcher: () => !!(Models.list && Models.list.launcher) };
})();
