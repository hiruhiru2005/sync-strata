// Strata on this page: the state pill, the sheet that starts and stops it (11/15: and picks, downloads and switches models), the token count beside "考え中", and the
// speed shown under each message. The numbers come from the relay (server.mjs), which reads Strata's /metrics.
"use strict";

const fmtN = (n) => I18n.num(n);

function strataJobRunning() {
  const st = Store.S.strata;
  return !!(st && st.job && !st.job.endedAt);
}

function strataPill() {
  const st = Store.S.strata;
  // 11/16: until the first state arrives (Store.S.strata is still empty) show no pill: "stopped" here was wrong when Strata was running
  if (!st) return h("span", { class: "pill hidden", "aria-hidden": "true" });
  let cls = "off";
  let text = tr("Strata stopped");
  if (strataJobRunning()) {
    cls = "busy";
    text = st.job.kind === "start" ? tr("Strata starting") : tr("Strata stopping");
  } else if (st && st.online) {
    if (st.state === "generating") {
      cls = "busy";
      if (st.phase === "thinking") {
        text = tr("Thinking {0} tokens", [fmtN(st.generated || 0)]);
        if (st.tok_s) text += ` · ${Math.round(st.tok_s)} tok/s`;
      } else {
        const what = /tool call/.test(st.phase || "") ? tr("Writing") : tr("Generating");
        text = st.tok_s ? `${what} ${Math.round(st.tok_s)} tok/s` : what;
      }
    } else if (st.state === "reading") {
      cls = "busy";
      text = st.prompt_total ? tr("Reading {0}%", [Math.round((100 * (st.prompt_read || 0)) / st.prompt_total)]) : tr("Reading…");
    } else if (st.state === "unloaded") {
      text = tr("Strata getting ready");
    } else {
      cls = "idle";
      text = tr("Strata idle");
    }
  }
  return h("span", { class: `pill ${cls}` }, h("span", { class: "dot" }), text);
}

// The tokens thought so far, for the "考え中" line of one session. Strata reports only the request it is working on,
// so the count is shown only while this session is the one running (with two at once it could be the other's).
function thinkingCount(sessionId) {
  const st = Store.S.strata;
  if (!st || !st.online || st.state !== "generating" || st.phase !== "thinking" || !st.generated) return "";
  const running = Store.runningAll(); // 11/2: subagents count too (a parent waiting on one is "running" as well)
  if (running.length !== 1 || running[0].sessionId !== sessionId) return "";
  return tr("{0} tokens", [fmtN(st.generated)]);
}

// --- 11/2: the pill jumps to the session Strata is writing for (a subagent's too) ---
function strataBusy() {
  const st = Store.S.strata;
  return !!(st && st.online && !strataJobRunning() && (st.state === "generating" || st.state === "reading"));
}

// Is this session's answer streaming now? Its session/follow opens with the attempt in progress: the one Strata writes
// for has text, thinking or a tool call in it; one still waiting its turn (the 8081 proxy queues them) has none yet.
// "writing" | "waiting" | "idle" | null (no answer in time)
function probeStreaming(s, ms = 2500) {
  return new Promise((resolve) => {
    let stop = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stop) stop();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    const address = Store.isChild(s.sessionId)
      ? { kind: "subagent", parentSessionId: s.parentSessionId, childSessionId: s.sessionId, mode: "unknown" }
      : { kind: "session", sessionId: s.sessionId };
    stop = Api.mux.open("session/follow", { request: { address, assistantStream: true, maxMessages: 1 } }, {
      item: (f) => {
        if (f.type !== "snapshot") return;
        const a = f.assistantStream && f.assistantStream.activeAttempt;
        if (!a) return finish("idle");
        const moved = (a.stream || []).some((r) => r.type === "chunk"
          || ((r.type === "text-chunks" || r.type === "reasoning-chunks") && (r.texts || []).some(Boolean)));
        finish(moved ? "writing" : "waiting");
      },
      error: () => finish(null),
    });
    if (done && stop) stop();
  });
}

// the conversation at the top of a subagent's line, for "親: …"
function topOf(id) {
  let cur = id;
  for (let i = 0; i < 8 && Store.isChild(cur); i++) cur = Store.S.children.get(cur).parentSessionId;
  return cur;
}

let jumping = false;
async function jumpToWriting(go) {
  if (jumping) return;
  const all = Store.runningAll();
  // a parent waiting on its subagents is "running" too: the ones with no running subagent are the candidates
  let cands = all.filter((s) => !all.some((c) => c.parentSessionId === s.sessionId));
  if (!cands.length) cands = all;
  if (!cands.length) { openStrataSheet(); return; }
  if (cands.length === 1) { go(Store.routeOf(cands[0].sessionId)); return; }
  jumping = true;
  const slow = setTimeout(() => toast(tr("Looking for the session being written…")), 400);
  let probe;
  try {
    probe = await Promise.all(cands.slice(0, 16).map((s) => probeStreaming(s)));
  } finally {
    clearTimeout(slow);
    jumping = false;
  }
  const writing = cands.filter((s, i) => probe[i] === "writing");
  if (writing.length === 1) { go(Store.routeOf(writing[0].sessionId)); return; }
  openRunningSheet(go, cands, probe);
}

// More than one could be the one (Strata still reading the prompt, or the probe did not answer): let the user pick.
function openRunningSheet(go, cands, probe) {
  const rank = { writing: 0, waiting: 1, idle: 3 };
  const rows = cands.map((s, i) => ({ s, p: probe[i] })).sort((a, b) => (rank[a.p] ?? 2) - (rank[b.p] ?? 2)).map(({ s, p }) => {
    const child = Store.isChild(s.sessionId);
    const name = child ? Store.subLabel(s.sessionId) || tr("Subagent") : Store.title(s.sessionId);
    const state = p === "writing" ? tr("Writing") : p === "waiting" ? tr("Waiting its turn") : tr("Running");
    return h("button", { class: "sheet-item with-icon run-pick", type: "button", onclick: () => { sh.close(true); go(Store.routeOf(s.sessionId)); } },
      icon(child ? "tool" : "code"),
      h("span", { class: "run-pick-text" }, h("span", { class: "run-pick-name" }, name),
        child ? h("span", { class: "run-pick-parent muted small" }, tr("Parent: {0}", [Store.title(topOf(s.sessionId))])) : null),
      h("span", { class: `run-pick-state${p === "writing" ? " on" : ""}` }, state));
  });
  const sh = openSheet([h("div", { class: "sheet-title" }, tr("Running sessions")), ...rows,
    sheetItem("power", tr("Start / stop Strata"), () => { sh.close(true); openStrataSheet(); })]);
}

// --- starting and stopping ---
async function strataControl(action, query = "") {
  let r;
  try {
    r = await fetch(`/m/strata/${action}${query}`, { method: "POST", headers: { "x-dsh-mobile": "1" }, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new Error(tr("Cannot reach the PC"));
  }
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || !body.ok) throw new Error(body.error || tr("Failed (HTTP {0})", [r.status]));
  return body;
}

// 11/9: 起動の設定は 2 つ．"syncm" = Sync-M（いつもの，品質が高い），"syncs" = Sync-S（decode が速い代わりに品質が下がる）．
// どちらも tail skip あり（11/9 夜から）・画像を読める（画像の読み取りは画像が来たときだけ起動）ので，画像のあり・なしは選ばない
// 11/15: モデルは中継の一覧（GET /m/models．中継の models/models.json）から選ぶ．手元に無いものはここからダウンロードできる．
// 一覧を出さない古い中継（404）のときは，前の 2 つのボタン（Sync-M・Sync-S）に戻る．
const STRATA_PRESETS = DSH_CONFIG.strataPresets;
// 最後に読んだ /m/models の答え（Strata の欄を開いている間だけ読み直す）．legacy: 中継が一覧を出さない
const Models = { list: null, legacy: false, error: null };

// 動いている Strata の設定の名前（/metrics のモデル名から）．11/15: 欄で選んで起動したなら tail skip も（例「Sync-S · R4」）
function strataPresetName(model) {
  let name = model || "";
  // 11/16 夜 本人: Sync-XS だけ「qwen3.8-flash-next-sync-xs」と長い小文字で出ていた（前は sync-m・sync-s だけを見ていた）．
  // 名乗りの最後の「sync-<名前>」から，ほかの物と同じ「Sync-XS」の形に（config.js の strataPresets に名前があればそれ）
  const pm = /sync-([a-z]+)$/i.exec(model || "");
  if (pm) name = STRATA_PRESETS["sync" + pm[1].toLowerCase()] || `Sync-${pm[1].toUpperCase()}`;
  const run = Models.list && Models.list.running;
  return run && run.r ? `${name} · R${run.r}` : name;
}

const GIB = 1024 ** 3;
const fmtGiB = (b) => `${I18n.num(Math.round((b / GIB) * 10) / 10)} GiB`;
const fmtSpeed = (bps) => (bps ? `${I18n.num(Math.round(bps / 1e6))} MB/s` : "");
function fmtLeft(s) {
  if (s == null || !isFinite(s)) return "";
  if (s < 60) return tr("{0} s left", [Math.max(1, Math.round(s))]);
  if (s < 3600) return tr("{0} min left", [Math.round(s / 60)]);
  return tr("{0} h {1} min left", [Math.floor(s / 3600), Math.round((s % 3600) / 60)]);
}
const modelDesc = (m) => (m.description && (m.description[I18n.lang] || m.description.en)) || "";
const modelOf = (id) => ((Models.list && Models.list.models) || []).find((m) => m.id === id) || null;
const DL_ACTIVE = ["starting", "downloading", "verifying"];
const dlActive = (m) => !!(m && m.download && DL_ACTIVE.includes(m.download.state));

// 11/17 W1 (D, E): the waiting list (L.queue = [{id, name, kind: "model"|"shared", active}], the one running first). A download
// press puts the model on it together with the shared parts it lacks; the relay fetches them one after another.
const queueOf = (id) => ((Models.list && Models.list.queue) || []).find((q) => q.id === id) || null;
// how many models are ahead of this one on the list (the running one counts)
function modelsAhead(id) {
  const qs = (Models.list && Models.list.queue) || [];
  return qs.slice(0, Math.max(0, qs.findIndex((q) => q.id === id))).filter((q) => q.kind === "model").length;
}
function progressText(d) {
  if (d.state === "starting") return [0, tr("Getting ready…")];
  if (d.state === "verifying" && d.verify) {
    const pct = d.verify.total_bytes ? Math.floor((100 * d.verify.done_bytes) / d.verify.total_bytes) : 0;
    return [pct, tr("Checking the files {0}%", [pct])];
  }
  const pct = d.total_bytes ? Math.floor((100 * (d.done_bytes || 0)) / d.total_bytes) : 0;
  const parts = [`${pct}%`, fmtGiB(d.done_bytes || 0) + " / " + fmtGiB(d.total_bytes || 0), fmtSpeed(d.speed_bps), fmtLeft(d.eta_s)].filter(Boolean);
  return [pct, parts.join(" · ")];
}
// The text for a download that failed: a private repository says what to do (the token is put in from a terminal; there is no field)
const dlFailText = (d) => (d.error_kind === "auth" ? tr("This is a private repository. Enter the token in a terminal.") : d.error);
// The shared parts as one row (the page has no row of their own for each): the one being fetched with its progress, how many
// wait, or why the last try failed. null when there is nothing to show. reg(fill, text) lets a caller update the progress in place.
function sharedRow(L, onStop, reg) {
  const qs = (L.queue || []).filter((q) => q.kind === "shared");
  const bad = (L.shared || []).find((x) => !x.local.complete && x.download && x.download.state === "failed" && x.download.error && !qs.some((q) => q.id === x.id));
  if (!qs.length && !bad) return null;
  const lines = [];
  const acts = [];
  const cur = qs.find((q) => q.active);
  const d = cur && (L.shared || []).find((x) => x.id === cur.id);
  if (cur && d && d.download) {
    const [pct, text] = progressText(d.download);
    const fill = h("div", { class: "ctx-fill" });
    fill.style.width = `${pct}%`;
    const t = h("div", { class: "msel-note dl-text" }, text);
    if (reg) reg(fill, t);
    lines.push(h("div", { class: "msel-note" }, tr("Downloading {0} of {1}", [qs.indexOf(cur) + 1, qs.length])), h("div", { class: "ctx-bar dl-bar" }, fill), t);
  } else if (qs.length) {
    lines.push(h("div", { class: "msel-note" }, tr("Waiting to download")));
  }
  if (qs.length) acts.push(h("button", { class: "btn slim ghost", type: "button", onclick: onStop }, tr("Stop the download")));
  if (bad) lines.push(h("div", { class: "msel-note fit-warn" }, dlFailText(bad.download)));
  return h("div", { class: "msel-item strata-model" }, h("div", { class: "msel-text" },
    h("div", { class: "msel-name" }, tr("Shared parts")), lines, acts.length ? h("div", { class: "model-acts" }, acts) : null));
}
// stops the shared parts on the list (the waiting ones first, then the running one)
async function stopSharedParts() {
  const qs = ((Models.list && Models.list.queue) || []).filter((q) => q.kind === "shared");
  for (const q of [...qs].sort((a, b) => Number(a.active) - Number(b.active))) await modelsPost("cancel", q.id);
}

async function modelsPost(action, id) {
  let r;
  try {
    r = await fetch(`/m/models/${action}?id=${encodeURIComponent(id)}`, { method: "POST", headers: { "x-dsh-mobile": "1" }, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new Error(tr("Cannot reach the PC"));
  }
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || !body.ok) throw new Error(body.error || tr("Failed (HTTP {0})", [r.status]));
  return body;
}

async function loadModels() {
  try {
    const r = await fetch("/m/models", { cache: "no-store" });
    if (r.status === 404) { Models.legacy = true; Models.list = null; return; }
    const b = await r.json();
    if (r.ok && b.ok) { Models.list = b; Models.legacy = false; Models.error = null; } else Models.error = b.error || tr("Failed (HTTP {0})", [r.status]);
  } catch {
    Models.error = tr("Cannot reach the PC");
  }
}

// A conversation running, or Strata working, gets a warning first (stopping ends that work with an error).
async function confirmStop(title, okLabel) {
  const running = [...Store.S.sessions.values()].filter((s) => s.running).length;
  const st = Store.S.strata;
  const busy = st && st.online && (st.state === "reading" || st.state === "generating");
  if (!running && !busy) return true;
  return confirmSheet({
    title,
    message: (running ? trp("{0} conversation is running.", "{0} conversations are running.", running) : tr("Strata is processing now."))
      + tr(" Stopping ends that work."),
    okLabel, danger: true,
  });
}

// Unity running, or Unity work another session announced, gets a warning that can be overridden.
// 11/15: opts = {model, r, restart, name}: the model of the list, its tail skip, and "stop the running one first".
async function startStrata(preset = "syncm", opts = null) {
  const g = await strataControl("guard");
  const lines = [];
  if (g.unityRunning) lines.push(tr("• Unity (Unity.exe) is running."));
  for (const a of g.announced || []) lines.push(tr("• {0}: {1}", [a.who, a.note]));
  if (lines.length) {
    const ok = await confirmSheet({
      title: tr("This may clash with Unity work"),
      message: `${lines.join("\n")}\n\n${DSH_CONFIG.strataRamGiB
        ? tr("Starting uses about {0} GiB of RAM. A Unity build becomes much slower.", [DSH_CONFIG.strataRamGiB])
        : tr("Starting uses a lot of RAM. A Unity build becomes much slower.")}`,
      okLabel: tr("Start anyway"), danger: true,
    });
    if (!ok) return;
  }
  const p = preset === "syncs" ? "syncs" : "syncm";
  if (opts && opts.model) {
    if (opts.restart && !(await confirmStop(tr("Strata is busy. Switch anyway?"), tr("Yes, switch")))) return;
    // preset= too: a relay older than 11/15 reads only that (and starts the same pack with its own tail skip)
    await strataControl("start", `?model=${encodeURIComponent(opts.model)}&r=${opts.r}${opts.restart ? "&restart=1" : ""}&preset=${p}&mode=vision`);
    toast(opts.restart ? tr("Switching Strata to {0} (1–2 min)", [opts.name]) : tr("Starting Strata with {0} (1–2 min)", [opts.name]));
    return;
  }
  // mode=vision: 11/9 より前の中継（preset を読まない）でも，古い画像なしの設定ではなく Sync-M で起動するように
  await strataControl("start", `?preset=${p}&mode=vision`);
  toast(tr("Starting Strata with {0} (1–2 min)", [STRATA_PRESETS[p]]));
}

async function stopStrata() {
  if (!(await confirmStop(tr("Stop Strata while it is working?"), tr("Yes, stop")))) return;
  await strataControl("stop");
  toast(tr("Stopping Strata"));
}

// What runs now, from Strata's own state (polled every 1-3 s, fresher than the last list): the model whose name matches,
// and the tail skip it was started with (the relay's record of the last start, when that start was this model).
function liveRunning() {
  const L = Models.list;
  const st = Store.S.strata;
  if (!L || !L.models || !st || !st.online || !st.model) return null;
  const m = L.models.find((x) => { try { return new RegExp(x.match || x.id, "i").test(st.model); } catch { return false; } });
  return m ? { model: m.id, r: L.choice && L.choice.model === m.id ? L.choice.r ?? null : null } : null;
}

// The name of a start job: the model of the list (with its tail skip) or the 11/9 preset.
function jobName(job) {
  const m = job.model && modelOf(job.model);
  const name = m ? m.name : STRATA_PRESETS[job.mode] || null;
  return name && job.r ? `${name} R${job.r}` : name;
}

// 11/17 係 W6: the engine could not start again for lack of GPU memory ("seat_short"): suggest a lighter model.
// strata.restart_note comes from /m/strata (the engine's GET /v1/status); a 503 text with "seat_short" in a chat says the same.
const SeatShort = {
  noted() { const st = Store.S.strata; return !!(st && st.restart_note === "seat_short" && !st.online); },   // 遅い起動で動いているときは「起動できませんでした」と出さない
  has(text) { return /seat_short/.test(String(text || "")); },
  el() {
    return h("div", { class: "seat-short" },
      h("div", { class: "seat-short-text" }, tr("The GPU memory was not enough to start this model. A lighter model (Sync-XS) is likely to start.")),
      h("button", { class: "btn slim", type: "button", onclick: () => openStrataSheet({ light: true }) }, tr("Choose a lighter model")));
  },
};

function openStrataSheet(opts) {
  let wantLight = !!(opts && opts.light);   // 11/17 係 W6: from the seat_short notice: the lightest model is chosen first
  const seatBox = h("div", { class: "seat-short-box hidden" });
  const state = h("div", { class: "strata-state" });
  const logBox = h("pre", { class: "job-log hidden" });
  const btn = h("button", { class: "btn wide-in", type: "button" });
  const btn2 = h("button", { class: "btn wide-in ghost hidden", type: "button" });
  const note = h("div", { class: "sheet-note muted" });
  // 11/15: the model list, why one is recommended, and quality (R7) or speed (R4)
  const listBox = h("div", { class: "set-group strata-models hidden" });
  const why = h("div", { class: "sheet-note muted hidden" });
  const rBox = h("div", { class: "set-group hidden" });
  // 11/15 app1115: the launcher's start settings and the stop choices (only when the launcher is behind this relay; setup.js)
  const extra = h("div", { class: "strata-extra" });
  let sel = null; // {model, r}
  let picked = false; // the user chose here: polling no longer moves the choice
  let shownKey = "";
  const prog = new Map(); // id -> {fill, text}: the progress line, updated in place between redraws
  let closed = false;
  let timer = null;

  function defaultSel() {
    const L = Models.list;
    const ms = ((L && L.models) || []).filter((x) => !x.pending);   // 11/15: 準備中のモデルは選ばない
    if (wantLight && ms.length) {   // 11/17 係 W6: the lightest model (the smallest experts) first
      const lm = ms.slice().sort((a, b) => (a.experts_gib || 0) - (b.experts_gib || 0))[0];
      return { model: lm.id, r: lm.default_r || (Spec.v && Spec.v.recommended_r) || 7 };
    }
    const ok = (id) => { const m = ms.find((x) => x.id === id); return m && m.local.complete ? m : null; };
    const run = L && L.running;
    const m = (run && ms.find((x) => x.id === run.model)) || (L && L.choice && ok(L.choice.model)) || ms.find((x) => x.recommended && x.local.complete)
      || ms.find((x) => x.local.complete) || ms.find((x) => x.recommended) || ms[0];
    if (!m) return null;
    const rec = Spec.v ? Spec.v.recommended_r : null;   // 11/15: 決めていなければ，この PC に勧める R
    const r = run && run.model === m.id && run.r ? run.r : L.choice && L.choice.model === m.id && L.choice.r ? L.choice.r : rec || m.default_r || 7;
    return { model: m.id, r: SHOWN_R.includes(r) ? r : rec || 7 };
  }


  function act(fn) {
    return async (e) => {
      e.stopPropagation();
      try { await fn(); } catch (err) { toast(err.message); }
      await loadModels();
      render();
    };
  }

  function modelItem(m) {
    const L = Models.list;
    if (m.pending) {   // 11/15 本人: Sync-XS も一覧に．pack がまだ無い間は「準備中」で，選べない
      return h("div", { class: "msel-item strata-model pending", "aria-disabled": "true" },
        h("div", { class: "msel-text" },
          h("div", { class: "msel-name" }, m.name, h("span", { class: "model-tags" }, [h("span", { class: "mini model-tag" }, tr("Coming soon"))])),
          h("div", { class: "msel-note" }, modelDesc(m))));
    }
    const d = m.download;
    const on = sel && sel.model === m.id;
    const tags = [];
    if (m.recommended) tags.push(h("span", { class: "mini model-tag rec" }, tr("Recommended")));
    if (m.running) tags.push(h("span", { class: "mini model-tag" }, tr("Running")));
    const lines = [h("div", { class: "msel-note" }, modelDesc(m))];
    const loc = m.local;
    let have = loc.complete
      ? tr("Downloaded · {0}", [fmtGiB(loc.total_bytes)]) + (loc.verified ? tr(" · files checked") : "")
      : loc.have_bytes + loc.partial_bytes > 0 ? tr("Partly downloaded · {0} of {1}", [fmtGiB(loc.have_bytes + loc.partial_bytes), fmtGiB(loc.total_bytes)])
        : tr("Not downloaded · {0}", [fmtGiB(loc.total_bytes)]);
    lines.push(h("div", { class: "msel-note" }, have));
    lines.push(h("div", { class: `msel-note${m.fits ? "" : " fit-warn"}` }, m.fits
      ? tr("Runs fine on this PC", [I18n.num(Math.round(m.experts_gib * 10) / 10)])
      : m.short === "vram" ? tr("Slow on this PC (not enough VRAM)")
      : m.fits_ram_gib ? tr("This model is for {0} GB of RAM. This PC ({1} GB) reads part of it from the SSD, so it is slower.", [m.fits_ram_gib, Math.round(L.ram_gib)])
      : tr("Slow on this PC (not enough RAM)", [I18n.num(L.ram_gib), I18n.num(Math.round(m.experts_gib * 10) / 10)])));
    if (m.shared_missing && m.shared_missing.length) {
      lines.push(h("div", { class: "msel-note fit-warn" }, tr("Missing files: {0}", [m.shared_missing.join(", ")])));
    }
    const acts = [];
    const qm = queueOf(m.id);
    if (qm && !qm.active && !dlActive(m)) {   // 11/17 W1: on the list, its turn has not come
      const ahead = modelsAhead(m.id);
      lines.push(h("div", { class: "msel-note" }, ahead ? tr("Waiting · {0} ahead", [ahead]) : tr("Waiting · next")));
      acts.push(h("button", { class: "btn slim ghost", type: "button", onclick: act(() => modelsPost("cancel", m.id)) }, tr("Take off the list")));
    } else if (dlActive(m)) {
      const [pct, text] = progressText(d);
      const fill = h("div", { class: "ctx-fill" });
      fill.style.width = `${pct}%`;
      const t = h("div", { class: "msel-note dl-text" }, text);
      prog.set(m.id, { fill, text: t });
      lines.push(h("div", { class: "ctx-bar dl-bar" }, fill), t);
      acts.push(h("button", { class: "btn slim ghost", type: "button", onclick: act(() => modelsPost("cancel", m.id)) },
        d.state === "verifying" || d.mode === "verify" ? tr("Stop the check") : tr("Stop the download")));
    } else {
      if (d && d.state === "failed" && d.error) lines.push(h("div", { class: "msel-note fit-warn" }, dlFailText(d)));
      if (d && (d.state === "stopped" || d.state === "interrupted") && !loc.complete) {
        const pct = d.total_bytes ? Math.floor((100 * (d.done_bytes || 0)) / d.total_bytes) : null;
        lines.push(h("div", { class: "msel-note" }, pct != null ? tr("Download stopped at {0}%", [pct]) : tr("Download stopped")));
      }
      if (d && d.state === "done" && d.mode === "download" && loc.complete) lines.push(h("div", { class: "msel-note ok-note" }, tr("Download complete")));
      if (d && d.state === "done" && d.mode === "verify" && loc.verified) lines.push(h("div", { class: "msel-note ok-note" }, tr("The files are fine")));
      const busyOther = L.active && L.active !== m.id;
      // 11/17 W1: the button is always on: another download may be running, this one then waits its turn (D: the shared parts the
      // model lacks come with it, so the size on the button includes them)
      const press = act(async () => {
        sel = { model: m.id, r: sel ? sel.r : 7 }; picked = true;
        const wait = !!(L.queue && L.queue.length);
        await modelsPost("download", m.id);
        if (wait) toast(tr("Added to the list. It starts after the others."));
      });
      if (!loc.complete) {
        const resume = loc.have_bytes + loc.partial_bytes > 0;
        acts.push(h("button", { class: "btn slim primary", type: "button", onclick: press },
          resume ? tr("Resume the download") : tr("Download ({0})", [fmtGiB(loc.total_bytes - loc.have_bytes + (m.shared_bytes || 0))])));
      } else {
        if (m.shared_pending && m.shared_pending.length) {
          acts.push(h("button", { class: "btn slim primary", type: "button", onclick: press }, tr("Download the shared parts ({0})", [fmtGiB(m.shared_bytes || 0)])));
        }
        if (!loc.verified && !m.running) acts.push(h("button", { class: "btn slim ghost", type: "button", disabled: busyOther, onclick: act(() => modelsPost("verify", m.id)) }, tr("Check the files")));
      }
    }
    if (loc.complete || loc.have_bytes > 0) {
      const st = Store.S.strata;
      const blocked = L.delete_blocked || (st && (st.online || (st.job && !st.job.endedAt)));
      acts.push(h("button", {
        class: "btn slim ghost", type: "button", disabled: !!blocked,
        title: blocked ? tr("Stop Strata and wait for model operations to finish before deleting.") : null,
        onclick: act(async () => {
          if (await confirmSheet({
            title: tr("Delete {0} from this PC?", [m.name]),
            message: tr("This removes the model files. Shared files stay on this PC. To use this model again, download it again."),
            okLabel: tr("Delete model"), danger: true,
          })) await modelsPost("delete", m.id);
        }),
      }, tr("Delete model")));
    }
    const item = h("div", {
      class: `msel-item strata-model${on ? " current" : ""}`, role: "radio", tabindex: "0", "aria-checked": on ? "true" : "false",
      onclick: (e) => { if (e.target.closest("button")) return; sel = { model: m.id, r: sel ? sel.r : m.default_r || 7 }; picked = true; render(); },
      onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); e.currentTarget.click(); } },
    },
    h("div", { class: "msel-text" },
      h("div", { class: "msel-name" }, m.name, tags.length ? h("span", { class: "model-tags" }, tags) : null),
      lines, acts.length ? h("div", { class: "model-acts" }, acts) : null),
    on ? h("span", { class: "msel-check", html: ICONS.check }) : null);
    return item;
  }

  function renderModels() {
    const L = Models.list;
    const show = !!(L && L.models && L.models.length);
    listBox.classList.toggle("hidden", !show);
    rBox.classList.toggle("hidden", !show);
    why.classList.toggle("hidden", !show);
    if (!show) return;
    if (!sel || !picked) sel = defaultSel();
    const st = Store.S.strata;
    const key = JSON.stringify([sel, Spec.v && Spec.v.recommended_r, L.active, L.ram_gib, L.running, L.delete_blocked,
      st && st.online, !!(st && st.job && !st.job.endedAt), L.models.map((m) => [m.id, m.local.complete, m.local.verified, m.local.have_bytes > 0, m.local.have_bytes + m.local.partial_bytes > 0,
      m.download && m.download.state, m.download && m.download.mode, m.download && m.download.error, m.running, m.recommended, m.fits, m.short, m.shared_missing,
      m.shared_pending, m.shared_bytes]), (L.queue || []).map((q) => [q.id, q.active]),
    (L.shared || []).map((x) => [x.id, x.local.complete, x.download && x.download.state, x.download && x.download.error])]);
    if (key === shownKey) {
      for (const m of L.models) {
        const p = prog.get(m.id);
        if (p && dlActive(m)) { const [pct, text] = progressText(m.download); p.fill.style.width = `${pct}%`; p.text.textContent = text; }
      }
      const ps = prog.get("shared");
      const cur = (L.queue || []).find((q) => q.kind === "shared" && q.active);
      const sd = cur && (L.shared || []).find((x) => x.id === cur.id);
      if (ps && sd && sd.download) { const [pct, text] = progressText(sd.download); ps.fill.style.width = `${pct}%`; ps.text.textContent = text; }
      return;
    }
    shownKey = key;
    prog.clear();
    const sharedEl = sharedRow(L, act(() => stopSharedParts()), (fill, text) => prog.set("shared", { fill, text }));   // 11/17 W1
    listBox.replaceChildren(h("div", { class: "set-label muted small" }, tr("Model")), h("div", { class: "msel-group" }, L.models.map(modelItem)),
      ...(sharedEl ? [h("div", { class: "msel-group" }, sharedEl)] : []));
    const rec = L.models.find((m) => m.recommended);
    if (rec) {
      const bigger = L.models.filter((m) => !m.fits && (m.experts_gib || 0) > (rec.experts_gib || 0)).map((m) => m.name);
      why.textContent = !rec.fits ? tr("Every model is slow on this PC. {1} is the lightest.", [I18n.num(L.ram_gib), rec.name])
        : bigger.length ? tr("{1} is recommended for this PC.", [I18n.num(L.ram_gib), rec.name, bigger.join(", ")])
          : tr("{1} also runs well on this PC.", [I18n.num(L.ram_gib), rec.name]);
    }
    const choice = (r, label) => h("button", {
      class: `chip${sel.r === r ? " on" : ""}`, type: "button", "aria-pressed": sel.r === r ? "true" : "false",
      onclick: () => { sel = { ...sel, r }; picked = true; render(); },
    }, label);
    rBox.replaceChildren(h("div", { class: "set-label muted small" }, tr("Tail skip at start")),
      // 11/15 本人: R4・R7・R10 の 3 択と推奨の印．起動時の tail skip は API を別のソフトから使うときだけ効く
      h("div", { class: "set-choices" }, [4, 7, 10].map((r) => choice(r, Spec.v && Spec.v.recommended_r === r ? `${rLabel(r)} · ${tr("Recommended for this PC")}` : rLabel(r)))),
      Spec.v ? h("div", { class: "set-note muted small" }, Spec.reason()) : null,
      h("div", { class: "set-note muted small strata-r-note" }, tr("Applies only when another program uses the API.")));
  }

  function render() {
    const st = Store.S.strata;
    const job = st && st.job;
    const working = strataJobRunning();
    state.replaceChildren(strataPill(), ...(st && st.online && st.model ? [h("span", { class: "muted small" }, strataPresetName(st.model))] : []));
    if (job) {
      const secs = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
      const preset = job.kind === "start" ? jobName(job) : null;
      const head = job.kind === "start"
        ? (working ? (preset ? (job.restart ? tr("Switching to {0} ({1} s)", [preset, secs]) : tr("Starting with {0} ({1} s)", [preset, secs])) : tr("Starting ({0} s)", [secs]))
          : job.code === 0 ? (preset ? tr("Started with {0} ({1} s)", [preset, secs]) : tr("Started ({0} s)", [secs]))
            : (preset ? tr("Start with {0} failed (exit code {1})", [preset, job.code]) : tr("Start failed (exit code {0})", [job.code])))
        : (working ? tr("Stopping ({0} s)", [secs])
          : job.code === 0 ? tr("Stopped ({0} s)", [secs]) : tr("Stop failed (exit code {0})", [job.code]));
      // 11/16 係 G2（本人の決めた文）: 起動の道具が「ほかのアプリの RAM を追い出しています」と書いてから，その終わりの行が来るまでの間，段の文を足す．
      // 終わりの行は ramsqueeze.run の why（追い出しました／ほとんどありませんでした）か detail（失敗・off）や，次の段（PC の調べ・RAM の枠）．未確認: 実機の行の並び
      const tail = job.tail || [];
      let sq = -1;
      for (let i = tail.length - 1; i >= 0; i--) if (/RAM を追い出しています/.test(tail[i])) { sq = i; break; }
      const sqDone = sq >= 0 && tail.slice(sq + 1).some((x) => /追い出しました|追い出せる分|追い出しに失敗|追い出しません|RAM の枠|エンジンを起こ/.test(x));
      const step = working && job.kind === "start" && sq >= 0 && !sqDone ? [tr("Pushing out other apps' memory.")] : [];
      logBox.textContent = [head, ...step, ...tail].join("\n");
      logBox.classList.remove("hidden");
    } else {
      logBox.classList.add("hidden");
    }
    const online = !!(st && st.online);
    seatBox.classList.toggle("hidden", !SeatShort.noted());
    if (SeatShort.noted() && !seatBox.firstChild) seatBox.replaceChildren(h("div", { class: "seat-short-text" }, tr("The GPU memory was not enough to start this model. A lighter model (Sync-XS) is likely to start.")));
    const ram = DSH_CONFIG.strataRamGiB;
    const L = Models.list;
    if (L && L.models) {
      L.running = liveRunning();
      for (const x of L.models) x.running = !!L.running && L.running.model === x.id;
    }
    if (!L || !L.models || !L.models.length) {
      // the 11/9 sheet: two start buttons (an old relay, or the list not read yet)
      renderModels();
      btn.disabled = working || !st;
      btn2.disabled = working || !st;
      btn.className = `btn wide-in ${online ? "danger" : "primary"}`;
      btn.textContent = working ? tr("Working…") : online ? tr("Stop Strata") : tr("Start {0} (usual)", [STRATA_PRESETS.syncm]);
      btn2.textContent = tr("Start {0} (fast)", [STRATA_PRESETS.syncs]);
      btn2.className = "btn wide-in ghost";
      btn2.classList.toggle("hidden", online || working || (!Models.legacy && !Models.error));
      btn.onclick = () => run(() => (online ? stopStrata() : startStrata("syncm")));
      btn2.onclick = () => run(() => startStrata("syncs"));
      note.textContent = online
        ? (ram ? tr("Stopping frees about {0} GiB of RAM.", [ram]) : tr("Stopping frees RAM."))
        : tr("{0} is the usual setting (higher quality). {1} decodes faster but with lower quality.", [STRATA_PRESETS.syncm, STRATA_PRESETS.syncs])
          + tr(" Both can read images. Other apps are pushed out to the page file before loading, so the PC is slow for a while (1–2 min).");
      if (!Models.legacy && !Models.error && !L) note.textContent += `\n${tr("Reading the model list…")}`;
      return;
    }
    renderModels();
    const lau = !!L.launcher && typeof Setup !== "undefined";
    if (lau !== (extra.childElementCount > 0)) {
      extra.replaceChildren(...(lau ? [
        sheetItem("gear", tr("Strata settings"), () => Setup.openSettingsSheet()),   // 11/20 0.1.3 本人: 「Strata の設定」
        sheetItem("power", tr("Stop…"), () => Setup.openStopSheet()),
      ] : []));
    }
    const m = modelOf(sel.model);
    const label = m ? `${m.name} R${sel.r}` : "";
    const run0 = L.running;
    const same = online && run0 && run0.model === sel.model && (!run0.r || run0.r === sel.r);
    const ready = !!m && m.local.complete && !dlActive(m) && !(m.shared_missing && m.shared_missing.length);
    btn.disabled = working || !st || (!same && !ready);
    btn2.disabled = working || !st;
    if (working) {
      btn.className = "btn wide-in primary";
      btn.textContent = tr("Working…");
      btn2.classList.add("hidden");
    } else if (!online) {
      btn.className = "btn wide-in primary";
      btn.textContent = tr("Start {0}", [label]);
      btn2.classList.add("hidden");
      btn.onclick = () => run(() => startStrata(m.preset, { model: m.id, r: sel.r, name: label }));
    } else if (same) {
      btn.className = "btn wide-in danger";
      btn.textContent = tr("Stop Strata");
      btn2.classList.add("hidden");
      btn.onclick = () => run(() => stopStrata());
    } else {
      btn.className = "btn wide-in primary";
      btn.textContent = tr("Switch to {0}", [label]);
      btn2.className = "btn wide-in ghost";
      btn2.textContent = tr("Stop Strata");
      btn2.classList.remove("hidden");
      btn.onclick = () => run(() => startStrata(m.preset, { model: m.id, r: sel.r, name: label, restart: true }));
      btn2.onclick = () => run(() => stopStrata());
    }
    note.textContent = online
      ? (ram ? tr("Stopping frees about {0} GiB of RAM.", [ram]) : tr("Stopping frees RAM."))
        + (same ? "" : tr(" Switching takes 1–2 minutes."))
      : tr("Starting takes 1–2 minutes, and the PC is slow meanwhile.");
    if (m && !m.local.complete) note.textContent += tr(" {0} is not downloaded.", [m.name]);
    if (m && m.short === "ram" && m.fits_ram_gib) note.textContent += `
${tr("This model is for {0} GB of RAM. This PC ({1} GB) reads part of it from the SSD, so it is slower.", [m.fits_ram_gib, Math.round(L.ram_gib)])}`;   // 11/17 係 W6
    if (typeof EnvCheck !== "undefined") EnvCheck.strata(state, btn, online && same);   // 11/15 係 C env: not supported -> no start
  }

  async function run(fn) {
    btn.disabled = true;
    btn2.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
    render();
  }

  async function poll() {
    if (!Spec.v) await Spec.load();
    await loadModels();
    if (closed) return;
    render();
    const fast = (Models.list && (Models.list.active || (Models.list.queue || []).length)) || strataJobRunning();
    timer = setTimeout(poll, fast ? 1000 : 4000);
  }

  const off = Store.on((topic) => { if (topic === "strata" || topic === "sessions") render(); });
  const memBox = typeof MemView !== "undefined" ? MemView.inline() : null;   // 11/17 係 W5: the memory box (hidden unless the launcher relay answers)
  openSheet([h("div", { class: "sheet-title" }, "Strata"), seatBox, state, note, memBox, listBox, why, rBox, btn, btn2, logBox, extra],
    { onClose: () => { closed = true; clearTimeout(timer); off(); } });
  render();
  poll();
}

// --- the speed under each message ---
// A message is matched to Strata's record of its request by the output tokens (dsh's usage.outputTokens is Strata's
// output_tokens) and the time it ended (the event's time; Strata's start + duration). Lookups are batched; one for a
// message that just ended is retried for a while, since the relay may not have seen its request yet.
const Speeds = (() => {
  const rows = new Map(); // Strata's request id -> {id, end, out, tps, first, dur, ...}
  let wanted = [];
  let timer = null;

  function find(w) {
    let best = null;
    for (const r of rows.values()) {
      if (r.out !== w.out) continue;
      const d = Math.abs(r.end - w.at);
      if (d < 20000 && (!best || d < best.d)) best = { r, d };
    }
    return best && best.r;
  }

  function fill(el, r) {
    let tps = r.tps;
    if (tps == null && r.dur) {
      const s = r.dur - (r.first || 0); // no decode clock (a cancelled request): from its whole answer time
      if (s > 0) tps = r.out / s;
    }
    if (tps == null) return;
    // 10/31: the prefill speed too (prompt tokens read ÷ the time they took), when the relay kept them (rows from
    // 10/31 18:50 on). A read of a few tokens says little about the speed, so below 64 only the count is shown.
    let pre = "";
    if (r.read != null && r.pms) {
      pre = r.read >= 64 ? tr("prefill {0} tok/s ({1} tokens) · ", [fmtN(Math.round(r.read / (r.pms / 1000))), fmtN(r.read)])
        : tr("prefill {0} tokens · ", [fmtN(r.read)]);
    }
    el.textContent = `${pre}${pre ? "decode " : ""}${tr("{0} tok/s · {1} tokens", [tps.toFixed(1), fmtN(r.out)])}`;
    el.classList.remove("hidden");
  }

  async function run() {
    timer = null;
    const list = wanted.filter((w) => w.el.isConnected || !w.placed);
    wanted = [];
    const need = list.filter((w) => { const r = find(w); if (r) fill(w.el, r); return !r; });
    if (!need.length) return;
    const from = Math.min(...need.map((w) => w.at)) - 60000;
    const to = Math.max(...need.map((w) => w.at)) + 60000;
    try {
      const r = await (await fetch(`/m/strata/requests?from=${from}&to=${to}`, { cache: "no-store" })).json();
      for (const x of r.items || []) rows.set(x.id, x);
    } catch { /* the relay is away: the recent ones are asked again below */ }
    for (const w of need) {
      w.placed = true;
      const r = find(w);
      if (r) fill(w.el, r);
      else if (Date.now() - w.at < 90000 && w.tries++ < 8) wanted.push(w);
    }
    if (wanted.length && !timer) timer = setTimeout(run, 3000);
  }

  return {
    // el: an empty, hidden line under the message; it is filled when the request is found.
    request(el, out, at) {
      wanted.push({ el, out, at, tries: 0, placed: false });
      if (!timer) timer = setTimeout(run, 50);
    },
  };
})();
