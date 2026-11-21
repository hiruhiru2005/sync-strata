// One session: the transcript (session/follow: a snapshot of recent history, then durable events and live
// assistant text), older history on demand (session/page), the agent's open questions, the queue, and the box.
"use strict";

const TOOL_KEYS = ["path", "file_path", "filePath", "command", "pattern", "query", "url", "glob", "description", "prompt"];

function toolSummary(args) {
  let a;
  try { a = JSON.parse(args || "{}"); } catch { return String(args || "").slice(0, 80); }
  if (!a || typeof a !== "object") return "";
  for (const k of TOOL_KEYS) if (typeof a[k] === "string" && a[k]) return a[k].split("\n")[0].slice(0, 80);
  const first = Object.values(a).find((v) => typeof v === "string");
  return first ? first.split("\n")[0].slice(0, 80) : "";
}

// 10/31: only the words (an image or file kept as an attachment ref shows as a picture or a card, media.js)
function textOnly(content) {
  return (content || []).map((b) => (b.type === "text" ? b.text : (b.type === "image" || b.type === "file") && !b.attachment ? (b.type === "image" ? tr("[image]") : tr("[file]")) : "")).join("");
}

function textOf(content) {
  return (content || []).map((b) => (b.type === "text" ? b.text : b.type === "image" ? tr("[image]") : b.type === "file" ? tr("[file]") : "")).join("");
}

// --- the context meter at the top right (10/30) ---
// dsh keeps the size of the next request per session (the contextPressure projection: the prompt the last request
// read, plus what the conversation grew by since) and the route's window; the desktop UI's meter shows the same.
// Compaction starts at min(thresholdRatio of the window, window - the model's reply cap - 8192): compaction-basic's
// thresholdRatio and headroomTokens in the dsh profile (cordis.patch.yml). dsh does not report
// the threshold itself, so these two follow that file: 11/6 the window 262,144 and thresholdRatio 0.9 -> 235,929
// (it was 0.8 of 122,880: 98,304). Change them here too when the file changes.
// 11/16 係 G2 (本人「ここちゃんと自動で更新するような仕組みに」): 決め打ち（0.9・8192・返事の上限 16384）では，返事の上限が
// 65,536 の設定（実際の起動の道具の表）と食い違い 230K と出ていた（本当は 188,416）．中継の GET /m/strata/ctx が，起動のたびに
// 起動の道具が書く 2 つのファイル（dsh-ctx.patch.yml・cordis.patch.yml）から，dsh が実際に使う値を読んで返すので，それを使う．
// 設定を変えて dsh を起こし直したあとは，次に画面を開いたとき（30 秒以内の読み直し）に新しい値になる．読めないときだけ下の決め打ち．
const COMPACT_RATIO = 0.9;
const COMPACT_HEADROOM = 8192;

const CtxNum = (() => {
  let v = null, at = 0, pending = null;
  function load(force) {
    if (pending) return pending;
    if (!force && v && Date.now() - at < 30000) return Promise.resolve(v);
    pending = fetch("/m/strata/ctx", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const was = v && JSON.stringify([v.compact_at, v.max_tokens, v.headroom, v.threshold_ratio]);
        if (b && b.ok) v = b;
        at = Date.now();
        if (v && JSON.stringify([v.compact_at, v.max_tokens, v.headroom, v.threshold_ratio]) !== was) document.dispatchEvent(new Event("sync-ctxnum"));
        return v;
      })
      .catch(() => v)
      .finally(() => { pending = null; });
    return pending;
  }
  return { load, get: () => v };
})();

function ctxInfo(sessionId) {
  const p = Store.S.projections.get(sessionId) || {};
  const pr = p.contextPressure || {};
  const sel = Store.selection(sessionId);
  const m = sel && Store.modelInfo(sel);
  const win = pr.contextWindow || (m && m.contextWindow) || null;
  const used = pr.projectedTokens != null ? pr.projectedTokens : pr.pressureTokens;
  const n = CtxNum.get();
  const nm = n && ((sel && n.models && n.models[sel.model]) || n);
  let compactAt = null, ratio = COMPACT_RATIO, head = COMPACT_HEADROOM, cap = (m && m.maxTokens) || 16384;
  if (n && nm && n.headroom != null && n.threshold_ratio != null) { ratio = n.threshold_ratio; head = n.headroom; cap = nm.max_tokens; }
  if (win) compactAt = Math.max(0, Math.min(Math.floor(win * ratio), win - cap - head));
  return { used: used == null ? null : used, win, compactAt, breakdown: p.contextBreakdown || null,
    rule: n ? { ratio, head, cap } : null };   // rule: the numbers really read from dsh's settings (null: the fixed estimate above)
}

// 1K = 1,024 tokens, like the context sizes (128K = 131,072)
function kTok(n) {
  const k = n / 1024;
  return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}K`;
}

function ctxLevel(c) {
  if (c.used == null || !c.win) return "none";
  if (c.compactAt && c.used >= c.compactAt) return "bad";
  return c.used / c.win >= 0.6 ? "warn" : "ok";
}

// The ring is drawn once and then only its arc, number and class change, so the busy arc keeps turning smoothly
// while the header redraws (it does every few seconds).
const RING_R = 12.5, RING_L = 2 * Math.PI * RING_R;
const RING_SVG = `<svg viewBox="0 0 32 32" class="ctx-ring" aria-hidden="true">
  <circle cx="16" cy="16" r="${RING_R}" class="ctx-track"/>
  <circle cx="16" cy="16" r="${RING_R}" class="ctx-arc" stroke-dasharray="0 ${RING_L.toFixed(2)}" transform="rotate(-90 16 16)"/>
  <text x="16" y="16.6" class="ctx-num" text-anchor="middle" dominant-baseline="middle">—</text></svg><span class="spinner ctx-spin" aria-hidden="true"></span>`;

function ctxRingUpdate(btn, c, busy) {
  if (!btn.querySelector(".ctx-ring")) btn.innerHTML = RING_SVG;
  const frac = c.used != null && c.win ? Math.min(1, c.used / c.win) : 0;
  btn.querySelector(".ctx-arc").setAttribute("stroke-dasharray", `${(frac * RING_L).toFixed(2)} ${RING_L.toFixed(2)}`);
  btn.querySelector(".ctx-num").textContent = c.used != null && c.win ? `${Math.round((c.used / c.win) * 100)}%` : "—";
  btn.className = `icon-btn ctx-meter ${ctxLevel(c)}${busy ? " busy" : ""}`;
  btn.setAttribute("aria-label", c.used != null && c.win ? tr("Context {0} / {1} (tap for details)", [kTok(c.used), kTok(c.win)]) : tr("Context usage"));
}

// 11/14: the rows are shared by the sheet and the PC's side panel (wide.js); short: without the long note
function ctxRows(sessionId, short = false) {
  {
    const c = ctxInfo(sessionId);
    if (c.used == null || !c.win) {
      return [h("div", { class: "sheet-note muted" }, tr("No numbers yet. dsh counts the context after the first reply."))];
    }
    const pct = Math.round((c.used / c.win) * 100);
    const lv = ctxLevel(c);
    const bar = h("div", { class: "ctx-bar" }, h("div", { class: `ctx-fill ${lv}`, style: `width:${Math.min(100, (c.used / c.win) * 100).toFixed(1)}%` }));
    if (c.compactAt) bar.append(h("div", { class: "ctx-mark", style: `left:${((c.compactAt / c.win) * 100).toFixed(1)}%`, title: tr("Where compaction starts") }));
    const rows = [
      h("div", { class: "ctx-big" }, `${kTok(c.used)} / ${kTok(c.win)}`, h("span", { class: `ctx-pct ${lv}` }, `${pct}%`)),
      bar,
      h("div", { class: "ctx-row" }, h("span", { class: "muted" }, tr("Tokens")), h("span", {}, `${fmtN(c.used)} / ${fmtN(c.win)}`)),
    ];
    if (c.compactAt) {
      rows.push(h("div", { class: "ctx-row" }, h("span", { class: "muted" }, tr("Where compaction starts")),
        h("span", { class: c.used >= c.compactAt ? "bad" : "" }, c.used >= c.compactAt ? tr("{0} (passed; compacts before the next reply)", [kTok(c.compactAt)]) : tr("{0} ({1} left)", [kTok(c.compactAt), kTok(c.compactAt - c.used)]))));
    }
    const b = c.breakdown;
    if (b && (b.systemTokens || b.toolsTokens || b.messageTokens)) {
      rows.push(h("div", { class: "ctx-row" }, h("span", { class: "muted" }, tr("Breakdown (approx.)")),
        h("span", {}, tr("Instructions {0} · tools {1} · conversation {2}", [kTok(b.systemTokens), kTok(b.toolsTokens), kTok(b.messageTokens)]))));
    }
    if (!short) {
      rows.push(h("div", { class: "ctx-note muted" }, c.rule
        ? tr("The expected size of the next request to Strata (what the last request read plus what was added since, as dsh counts it). The limit is the length set in dsh. Compaction starts at the smaller of {0}% of the limit and the limit minus the reply limit ({1}) and the margin ({2}). 1K = 1,024 tokens.",
          [Math.round(c.rule.ratio * 100), kTok(c.rule.cap), kTok(c.rule.head)])
        : tr("The expected size of the next request to Strata (what the last request read plus what was added since, as dsh counts it). The limit is the length set in dsh; compaction starts at 90% of it (or just below the reply limit, whichever is smaller). 1K = 1,024 tokens.")));
    }
    return rows;
  }
}

function openContextSheet(sessionId) {
  const body = h("div", { class: "ctx-sheet" });
  const render = () => body.replaceChildren(...ctxRows(sessionId));
  const off1 = Store.on((topic, id) => { if (topic === "projections" && (!id || id === sessionId)) render(); });
  document.addEventListener("sync-ctxnum", render);   // 11/16: dsh's numbers arrived (or changed)
  const off = () => { off1(); document.removeEventListener("sync-ctxnum", render); };
  openSheet([h("div", { class: "sheet-title" }, tr("Context usage")), body], { onClose: off });
  render();
  CtxNum.load(true);   // read again each time the sheet opens, so a changed setting shows
}

function promptBranchTarget(e) {
  if (e.type !== "user/message" || e.data?.source?.kind !== "user" ||
      e.surfaceOp !== "append" || !Number.isSafeInteger(e.seq) || e.seq < 0) return null;
  const parts = e.data.content;
  const text = Array.isArray(parts) && parts.every((p) => p?.type === "text" && typeof p.text === "string")
    ? parts.map((p) => p.text).join("") : "";
  return { atSeq: e.seq - 1, editText: text.trim() ? text : null };
}

async function createPromptBranch(api, sessionId, target, header, workspace) {
  // dsh uses an inclusive boundary. Open turns get synthetic closers; never omit atSeq.
  if (target.atSeq >= 0) return api.forkSession(sessionId, target.atSeq);
  // There is no event before seq 0. Don't let create silently use a default cwd.
  if (!workspace?.workspaceId || !header?.cwd || workspace.path !== header.cwd) {
    throw new Error(tr("Cannot start a branch before the first event: the original workspace could not be verified."));
  }
  return api.createSession(workspace.workspaceId, header.agentPreset);
}

// subInfo: {parentId} when this is a subagent's conversation (10/31): read only, addressed through its parent, back goes to the parent.
function ChatView(go, sessionId, subInfo) {
  const address = subInfo ? { kind: "subagent", parentSessionId: subInfo.parentId, childSessionId: sessionId, mode: "unknown" } : { kind: "session", sessionId };
  const subs = new Map(); // the subagents this conversation started: child id -> {label}
  let subTitle = subInfo ? Store.subLabel(sessionId) : null; // a subagent's own label (its subagent/descriptor) or the start of its task
  const runs = new Map(); // 11/2: workflow runId -> its name
  const cmds = new Map(); // 11/14: slash command commandId -> its name (command/run, for the command/done after it)
  const titleEl = h("div", { class: "topbar-title" });
  const subEl = h("div", { class: "topbar-sub muted" });
  const meter = h("button", { class: "icon-btn ctx-meter", type: "button", "aria-label": tr("Context usage"), onclick: () => openContextSheet(sessionId) });
  const more = h("button", { class: "icon-btn", type: "button", "aria-label": tr("Menu"), html: ICONS.more });
  const older = h("button", { class: "older hidden", type: "button" }, tr("Load earlier"));
  const log = h("div", { class: "log" });
  const asks = h("div", { class: "asks" });
  const pendingBox = h("div", { class: "pending-sends" }); // 11/15: 送ったばかりの発言（仮の吹き出し．Outbox）
  const scroller = h("div", { class: "transcript" }, older, log, pendingBox, asks);
  const copier = Copy.attach(scroller); // 10/31: hold a message (or right-click it) for コピー・部分コピー (copy.js)
  const jump = h("button", { class: "jump hidden", type: "button", "aria-label": tr("Jump to latest"), html: ICONS.chevron });
  const queue = h("div", { class: "queue" });
  // 11/2: the subagents of this conversation that run now, above the box (tap: the list of its subagents)
  const subBar = h("button", { class: "sub-bar hidden", type: "button", onclick: () => openSubsSheet() });
  // 11/17 係 W6: the engine could not start again for lack of GPU memory (seat_short): suggest a lighter model above the box
  const seatBar = h("div", { class: "seat-bar hidden" });
  let seatSeen = false;   // a turn's error text said seat_short
  const renderSeat = () => {
    const st = Store.S.strata;
    const show = SeatShort.noted() || (seatSeen && !(st && st.online));
    seatBar.classList.toggle("hidden", !show);
    if (show && !seatBar.firstChild) seatBar.replaceChildren(SeatShort.el());
  };
  const seatCheck = (text) => { if (SeatShort.has(text)) { seatSeen = true; renderSeat(); } return text; };
  const archivedBar = h("div", { class: "archived-bar hidden" },
    h("span", { class: "grow" }, tr("Archived. Restore it to continue.")),
    h("button", { class: "btn primary slim", type: "button", onclick: () => setArchived(sessionId, false) }, tr("Restore")));
  const running = () => { const s = Store.S.sessions.get(sessionId); return !!(s && s.running); };
  const composer = Composer({
    getSelection: () => Store.selection(sessionId),
    onSelect: async (s) => {
      try { await Api.selectModel(sessionId, s.provider, s.model, s.reasoningEffort); } catch (e) { toast(tr("Could not switch: {0}", [e.message])); }
    },
    // 11/15: 押した瞬間に仮の吹き出しを出し，送るのは Outbox が裏で（composer.js）
    optimistic: true,
    onSend: (text, atts) => {
      Outbox.send(sessionId, text, atts, () => (atts && atts.length
        ? Attach.send({ sessionId, text, atts, mode: "queue", sel: Store.selection(sessionId) })
        : Api.prompt(sessionId, text, "queue")), { floor: ready ? lastSeq : null, inboxSeen: new Set(inboxItems().map((x) => x.m.id)) });
    },
    onStop: () => Api.cancel(sessionId),
    isRunning: () => running(),
    commandSessionId: subInfo ? null : sessionId, // 11/14: 「/compact」などの命令（composer.js）
  });
  const el = h("div", { class: `screen chat${subInfo ? " sub" : ""}` },
    h("header", { class: "topbar" },
      h("button", { class: "icon-btn back-btn", type: "button", "aria-label": tr("Back"), onclick: () => go(subInfo ? Store.routeOf(subInfo.parentId) : "#/", "back"), html: ICONS.back }),
      h("button", { class: "topbar-center", type: "button", "aria-label": tr("Session actions"), onclick: () => openMenu() }, titleEl, subEl), meter, more),
    scroller, jump, h("div", { class: "bottom" }, seatBar, subBar, queue, archivedBar, composer.el));

  let branchHeader = null;
  let branchSheet = null;
  let branching = false;

  function openPromptBranch(target) {
    if (!ready || branchSheet || branching) return;
    const route = location.hash;
    const input = target.editText === null ? null : h("textarea", {
      class: "text-input", rows: 5, "aria-label": tr("Edited prompt"),
    }, target.editText);
    if (input) input.value = target.editText;
    const err = h("div", { class: "form-error bad hidden", role: "alert" });
    const resend = input && h("button", { class: "btn primary", type: "button", onclick: () => submit(true) }, tr("Edit & resend"));
    const skip = h("button", { class: "btn ghost", type: "button", onclick: () => submit(false) }, tr("Continue without this prompt"));
    async function submit(edit) {
      const text = edit ? input.value : null;
      if (branching || location.hash !== route || (edit && !text.trim())) return;
      branching = skip.disabled = true;
      if (resend) resend.disabled = true;
      err.classList.add("hidden");
      try {
        const child = await createPromptBranch(Api, sessionId, target, branchHeader,
          Store.S.workspacesReady ? Store.workspaceOf(sessionId) : null);
        if (edit) Outbox.send(child.sessionId, text, [], () => Api.prompt(child.sessionId, text), { floor: target.atSeq });
        sheet.close(true);
        if (el.isConnected && location.hash === route) go(Store.routeOf(child.sessionId));
        else toast(tr("Branch created: {0}", [child.sessionId]));
      } catch (e) {
        err.textContent = tr("Could not create branch: {0}", [errorText(e)]);
        err.classList.remove("hidden");
        if (branchSheet !== sheet) toast(err.textContent);
      } finally {
        branching = skip.disabled = false;
        if (resend) resend.disabled = !input.value.trim();
      }
    }
    if (input) input.addEventListener("input", () => { resend.disabled = branching || !input.value.trim(); });
    const sheet = openSheet([
      h("div", { class: "sheet-title" }, tr("Branch from this prompt")),
      h("div", { class: "sheet-note muted" }, tr("The new chat starts before this prompt. The original chat stays unchanged. Workspace files are shared, not rolled back.")),
      input || h("div", { class: "sheet-note muted" }, tr("Only text-only prompts can be edited and resent.")),
      err, h("div", { class: "form-actions" }, skip, resend),
    ], { onClose: () => { if (branchSheet === sheet) branchSheet = null; } });
    branchSheet = sheet;
  }

  let ready = false; // set once the opening snapshot is drawn: later entries rise in, the history does not
  let stopFollow = null;
  let lastSeq = -1;
  let cursor = 0;
  let oldestSeq = null;
  let revision = null;
  let live = null; // {attemptId, text, reasoning, el, body, frame}
  let tools = new Map(); // callId -> {el, status, result}
  let evlog = []; // the durable events shown so far, oldest first (会話をコピー starts from these and reads older pages)

  const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const nearBottom = () => gap() < 140;
  // 11/16: 下に付いていくかどうかは「本人が上へ動かしたか」で決める（前は描くたびに「下から 140px 以内か」で決めていたので，
  // 考え中などにスマホで少し上へ引くと，次のコマでいちばん下へ引き戻され，指と取り合ってガクガクした）．
  // 指が触れている間・指を離した後の慣性の間・ホイールやキーで上へ動かした時は「付いていかない」にし，
  // 本人がいちばん下（48px 以内）まで戻すか，↓の印・自分の発言でいちばん下へ行ったら，また付いていく．
  let sticky = true;      // 下に付いていく（follow() は会話の購読なので別の名前）
  let touching = false;
  let gestureUntil = 0;   // この時刻までの動きは本人の操作（慣性・ホイール・キー）
  let lastTop = 0;
  const toBottom = () => { sticky = true; scroller.scrollTop = scroller.scrollHeight; };
  function keepBottom(fn) {
    const stick = sticky && !touching;
    fn();
    if (stick) toBottom();
  }
  const gesture = (ms) => { gestureUntil = Math.max(gestureUntil, performance.now() + ms); };
  scroller.addEventListener("touchstart", () => { touching = true; }, { passive: true });
  const release = () => { touching = false; gesture(1200); };
  scroller.addEventListener("touchend", release, { passive: true });
  scroller.addEventListener("touchcancel", release, { passive: true });
  scroller.addEventListener("wheel", (e) => { gesture(400); if (e.deltaY < 0) sticky = false; }, { passive: true });
  scroller.addEventListener("keydown", (e) => { if (/^(PageUp|ArrowUp|Home)$/.test(e.key)) { gesture(600); sticky = false; } });
  scroller.addEventListener("scroll", () => {
    const top = scroller.scrollTop;
    const byUser = touching || performance.now() < gestureUntil;
    if (byUser && top < lastTop - 1) sticky = false;
    if (gap() <= 48) sticky = true;
    lastTop = top;
  }, { passive: true });

  // --- building transcript entries ---
  function toolEntry(id, name, args) {
    let t = tools.get(id);
    if (t) return null;
    const status = h("span", { class: "tool-status" }, h("span", { class: "spinner small" }));
    const body = h("div", { class: "tool-body" });
    const det = h("details", { class: "tool" },
      h("summary", {}, icon("tool", "small"), h("span", { class: "tool-name" }, name), h("span", { class: "tool-arg" }, toolSummary(args)), status),
      body);
    det.addEventListener("toggle", () => {
      if (!det.open || body.childElementCount) return;
      let pretty = args;
      try { pretty = JSON.stringify(JSON.parse(args), null, 2); } catch { /* raw */ }
      body.append(h("div", { class: "tool-label muted" }, tr("Arguments")), h("pre", {}, String(pretty || "").slice(0, 6000)));
      if (t.result != null) body.append(h("div", { class: "tool-label muted" }, tr("Result")), h("pre", {}, t.result.slice(0, 8000)));
    });
    t = { el: det, status, body, result: null, name, args, slot: null, media: h("div", { class: "tool-media" }) };
    tools.set(id, t);
    if (name === "subagent" || name === "subagent_fork") t.slot = h("div", { class: "sub-slot" });
    // 11/2: a message to a subagent (or stopping one) links to it
    if (name === "send_message" || name === "interrupt_agent") {
      let to = null;
      try { to = JSON.parse(args || "{}").agent_id; } catch { /* not JSON yet */ }
      if (typeof to === "string" && /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to)) t.slot = h("div", { class: "sub-slot" }, linkTo(to));
    }
    // 10/31: every tool row has a place under it for the images its result carries (read_image)
    return h("div", { class: "tool-group" }, det, t.slot, t.media);
  }

  function entriesFor(e) {
    const d = e.data || {};
    switch (e.type) {
      case "user/message": {
        const src = d.source || {};
        if (src.kind === "user") {
          const said = textOnly(d.content);
          if (subInfo && !subTitle) { subTitle = said.trim().split("\n")[0].slice(0, 40); renderHeader(); }
          const media = Media.strip(sessionId, d.content, "end"); // 10/31: the pictures and files you sent
          const node = h("div", { class: `msg user${media ? " with-media" : ""}` }, said.trim() ? Copy.mark(h("div", { class: "bubble" }, said), said) : null, media);
          const target = subInfo ? null : promptBranchTarget(e);
          if (target) {
            node.classList.add("with-media");
            node.append(h("button", { class: "mini", type: "button", onclick: () => openPromptBranch(target) }, tr("Branch…")));
          }
          if (claimPending(e, said)) node.dataset.claimed = "1"; // 11/15: 仮の吹き出しと入れ替え（出し直しの動きは付けない）
          return [node];
        }
        if (src.kind === "subagent-settled" && src.senderSessionId) {
          const closing = (d.content || []).slice(1).map((p) => p.text || "").join("\n").trim();
          const lab = labelOf(src.senderSessionId);
          const sm = String(src.summary || "");
          const said = /fail/i.test(sm) ? (lab ? tr("Subagent “{0}” failed", [lab]) : tr("Subagent failed"))
            : /stop|interrupt|cancel/i.test(sm) ? (lab ? tr("Subagent “{0}” stopped", [lab]) : tr("Subagent stopped"))
            : (lab ? tr("Subagent “{0}” finished", [lab]) : tr("Subagent finished"));
          return [h("div", { class: "sub-note" }, h("div", { class: "marker", title: sm }, said),
            closing ? h("details", { class: "reasoning" }, h("summary", { class: "muted" }, tr("The subagent's last words")), h("div", { class: "reasoning-body" }, closing)) : null,
            subLink(src.senderSessionId))];
        }
        if (src.kind === "agent-message" && src.senderSessionId) {
          const text = textOf(d.content).replace(/^Agent \S+ sent a message:\s*/, "");
          const rel = relOf(src.senderSessionId); // 11/2: a subagent also gets messages from its parent (send_message)
          const head = rel === "parent" ? tr("Message from the parent agent") : rel === "child" ? tr("Report from a subagent") : tr("Message from another agent");
          return [h("div", { class: "sub-note" }, h("details", { class: "reasoning" }, h("summary", { class: "muted" }, head), h("div", { class: "reasoning-body" }, text)),
            linkTo(src.senderSessionId))];
        }
        if (src.form === "notice" && src.summary) return [h("div", { class: "marker" }, src.summary)];
        return [];
      }
      case "assistant/message": {
        const out = [];
        for (const b of (d.message && d.message.content) || []) {
          if (b.type === "text" && b.text.trim()) out.push(Copy.mark(h("div", { class: "msg assistant md", html: Md.render(b.text) }), b.text)); // コピーは Markdown の元の文字
          else if (b.type === "reasoning" && b.text.trim()) {
            out.push(h("details", { class: "reasoning" }, h("summary", { class: "muted" }, tr("Thinking ({0} chars)", [b.text.length])), Copy.mark(h("div", { class: "reasoning-body" }, b.text), b.text))); // 10/31 本人: 考えの本文もコピー・部分コピー
          } else if (b.type === "tool-call") {
            const x = toolEntry(b.id, b.name, b.arguments);
            if (x) out.push(x);
          }
        }
        // the speed of the Strata request behind this message, under it (filled in once found: strata.js)
        const src = (d.message && d.message.source) || {};
        const n = d.usage && d.usage.outputTokens;
        if (src.provider === "strata" && n && e.time) {
          const sp = h("div", { class: "speed muted hidden" });
          Speeds.request(sp, n, e.time);
          out.push(sp);
        }
        return out;
      }
      case "tool/call": {
        const x = toolEntry(d.callId, d.name, d.arguments);
        return x ? [x] : [];
      }
      case "tool/result": {
        const m = d.message || {};
        const t = tools.get(m.toolCallId);
        if (t) {
          t.result = textOf(m.content);
          const media = Media.strip(sessionId, m.content);
          if (media) t.media.replaceChildren(media);
          t.status.replaceChildren(m.isError || d.error ? h("span", { class: "bad" }, tr("Failed")) : h("span", { class: "ok" }, "✓"));
          if (t.el.open) { t.body.replaceChildren(); t.el.open = false; }
          const cid = subChildId(t.result);
          if (cid) {
            if (!subs.has(cid)) subs.set(cid, { label: subDesc(t.args) });
            if (t.slot) t.slot.replaceChildren(subLink(cid));
          }
        }
        return [];
      }
      case "turn/end": {
        const k = d.reason && d.reason.kind;
        if (k === "error") return [h("div", { class: "marker bad" }, tr("Stopped with an error: {0}", [seatCheck((d.reason.error && d.reason.error.message) || "")]))];
        if (k === "aborted" || k === "interrupted") return [h("div", { class: "marker" }, tr("Stopped"))];
        if (k === "max-tokens") return [h("div", { class: "marker bad" }, tr("Stopped at the output limit for one reply"))];
        return [];
      }
      // 11/2: subagents started by a workflow (the workflow tool) have no subagent tool row of their own
      case "tool-workflow/run-start":
        if (d.runId) runs.set(d.runId, d.name || "");
        return [h("div", { class: "marker" }, tr("Started workflow “{0}”", [d.name || "?"]))];
      case "tool-workflow/run-end": {
        const nm = runs.get(d.runId) || "";
        const r = String(d.stopReason || "");
        const kind = /cancel|abort|interrupt|stop/i.test(r) ? "stop" : /fail|error/i.test(r) ? "fail" : "end";
        const said = kind === "stop" ? (nm ? tr("Workflow “{0}” stopped", [nm]) : tr("Workflow stopped"))
          : kind === "fail" ? (nm ? tr("Workflow “{0}” failed", [nm]) : tr("Workflow failed"))
          : (nm ? tr("Workflow “{0}” finished", [nm]) : tr("Workflow finished"));
        return [h("div", { class: "marker", title: r }, said)];
      }
      case "tool-workflow/agent-start":
        if (!d.childId) return [];
        subs.set(d.childId, { label: d.label || (subs.get(d.childId) || {}).label || null });
        return [h("div", { class: "sub-note" }, subLink(d.childId))];
      case "subagent/catalog":
        if (d.childId) subs.set(d.childId, { label: d.label || (subs.get(d.childId) || {}).label || null });
        return [];
      case "subagent/descriptor":
        if (subInfo && d.label) { subTitle = d.label; renderHeader(); }
        return [];
      case "compaction/end":
        return [h("div", { class: "marker" }, d.error ? tr("Compaction failed ({0})", [String(d.error).slice(0, 60)]) : tr("Compacted the conversation so far"))];
      // 11/14: スラッシュ命令の記録（dsh-commands の command/run {commandId, name, args?}・command/done {commandId, kind, text?}．
      // dsh の画面は commandId で組にして 1 つの札にする）．ここでは「/名前 を実行」の 1 行と，失敗したときだけその文
      case "command/run": {
        if (d.commandId) cmds.set(d.commandId, d.name);
        const args = String(d.args || "").trim().split("\n")[0].slice(0, 40);
        return [h("div", { class: "marker" }, tr("Ran {0}", [`/${d.name || "?"}${args ? ` ${args}` : ""}`]))];
      }
      case "command/done": {
        if (d.kind !== "error") return [];
        const nm = cmds.get(d.commandId);
        return [h("div", { class: "marker bad", title: d.text || "" }, (() => {
          const what = nm ? `/${nm}` : null;
          const why = d.text ? String(d.text).split("\n")[0].slice(0, 80) : null;
          if (what) return why ? tr("{0} failed: {1}", [what, why]) : tr("{0} failed", [what]);
          return why ? tr("The command failed: {0}", [why]) : tr("The command failed");
        })())];
      }
      default:
        return [];
    }
  }

  function apply(e) {
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    if (e.surfaceOp && e.surfaceOp !== "append") return; // rewrites after a compaction, not new messages
    evlog.push(e);
    if (e.type === "assistant/message") dropLive();
    const nodes = entriesFor(e);
    if (nodes.length) {
      keepBottom(() => log.append(...nodes));
      if (ready) nodes.forEach((n) => { if (!n.dataset.claimed) rise(n); });
    }
  }

  // --- live assistant text (assistant-stream frames) ---
  function dropLive() {
    if (live) {
      if (live.frame) cancelAnimationFrame(live.frame);
      if (live.timer) clearTimeout(live.timer);
      live.el.remove();
    }
    live = null;
  }

  function startLive(attemptId) {
    dropLive();
    const body = h("div", { class: "md" });
    const count = h("span", { class: "think-count" }, thinkingCount(sessionId));
    // 11/10: 考え中でも押すと思考の中身が見られる（本人）．できあがった返事の「思考（N 字）」と同じ開け閉めで，開いている間は
    // 届いた分がそのまま足されていく．本文が出始めたら見出しを「思考（N 字）」に替えて残す（できあがりと同じ見た目）
    const spin = h("span", { class: "spinner small" });
    const label = h("span", {}, tr("Thinking…"));
    const rbody = h("div", { class: "reasoning-body" });
    const think = h("details", { class: "reasoning live-think-box hidden" }, h("summary", { class: "live-think muted" }, spin, label, count), rbody);
    think.addEventListener("toggle", () => { if (think.open && live) rbody.textContent = live.rtext; });
    live = { attemptId, text: "", reasoning: 0, rtext: "", el: h("div", { class: "msg assistant live" }, think, body), body, think, count,
      spin, label, rbody, frame: 0, timer: 0, drawn: 0, md: Md.stream(body) };
    keepBottom(() => asks.before(live.el));
    if (ready) rise(live.el);
  }

  function liveChunk(c) {
    if (!live || !c) return;
    if (c.type === "text-delta") live.text += c.text;
    else if (c.type === "reasoning-delta") { live.reasoning += c.text.length; live.rtext += c.text; }
    else return;
    scheduleLive();
  }

  // 11/15: 届くたび（最大で毎コマ）に全文を描き直していたのを，LIVE_MS に 1 回へ間引く．PC で同じ GPU の LLM と
  // 画面が取り合い，decode が遅くなっていた（本人）．届いた分はためておき次の 1 回でまとめて描く．最初の 1 回はすぐ描く．
  // 本文は Md.stream で確定した塊を残し最後の塊だけ描き直す．生成の終わり（end）は全文を描き直す（drawLive(true)）．
  // 11/15 朝（本人「スマホは元に戻したほうがいいかも．PC も文字だけは低間隔で．GPU への負担は抑えたまま」）: 間隔を機器で分ける．
  // スマホ（指で触る機器）は元どおり届くたび（最大で毎コマ）．描くのはスマホの GPU で，PC の LLM とは取り合わない．
  // PC（マウスのある機器．fx.js と同じ見分け）は LIVE_MS_PC に 1 回＝文字は 1 秒 10 回．飾り（fx.js）は 1 秒 4 段のまま．
  // どちらも Md.stream で最後の塊だけ描き直すので，1 回の描画は 11/14 まで（全文の入れ替え）より軽い．
  // 11/16 本人の実機チェック「PC の画面のフレームレートが低すぎる（文字もアニメーションも）」: PC も毎コマ（requestAnimationFrame）に戻す．
  // 11/15 は PC を 100 ms に 1 回（1 秒 10 回）にしたが，かくついて見えた．GPU の取り合いは，毎コマの描き直しの量を減らして抑える:
  // 本文は Md.stream が最後の塊だけ描き直す／メッセージは CSS の contain で描き直しの範囲を絞る（app.css 11/16）／窓が裏の間は
  // requestAnimationFrame が止まる（届いた分はためておき，戻ったら 1 回で描く）／飾りは合成器だけで回る transform・opacity のみ（fx.js・app.css）．
  // 実測（この PC の画面は 240Hz: requestAnimationFrame が毎秒 240 回）: 毎コマだと 1 秒 240 回描くので，最短の間隔を 15 ms（約 60fps）にする．
  // 文字の増え方は 60fps あれば目で見て滑らか．スマホ（指で触る機器）は今までどおり届くたび．
  // 11/16 係 G2: 既定は 15 ms．測りのときは fx.js の SyncFps（localStorage syncFps {"text":60|120|240|0} か ?textfps=）で替えられる（0 は毎コマ）．
  const LIVE_MS_PC = typeof SyncFps !== "undefined" ? SyncFps.textMs : 0;   // 11/16 夜: 既定は毎コマ（届いた時だけ描く）
  const livePc = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)") : null;
  const liveMs = () => (livePc && livePc.matches ? LIVE_MS_PC : 0);
  function scheduleLive() {
    const L = live;
    if (!L || L.frame || L.timer) return;
    const go = () => {
      L.timer = 0;
      if (live === L) L.frame = requestAnimationFrame(() => { L.frame = 0; if (live === L) drawLive(false); });
    };
    const wait = liveMs() - (performance.now() - L.drawn);
    if (wait > 0) L.timer = setTimeout(go, wait);
    else go();
  }

  function drawLive(full) {
    if (!live) return;
    if (live.frame) { cancelAnimationFrame(live.frame); live.frame = 0; }
    if (live.timer) { clearTimeout(live.timer); live.timer = 0; }
    live.drawn = performance.now();
    keepBottom(() => {
      live.think.classList.toggle("hidden", !live.reasoning);
      if (live.text && !live.spin.classList.contains("hidden")) {   // 本文が出始めた: 考え終わり
        live.spin.classList.add("hidden");
        live.count.textContent = "";
      }
      if (live.text) live.label.textContent = tr("Thinking ({0} chars)", [live.rtext.length]);
      if (live.think.open) {   // 11/10: 欄の一番下まで送ってあれば，届いた分に付いて下へ送り続ける（上に戻して読んでいる間は動かさない）
        const rb = live.rbody;
        const atEnd = rb.scrollTop + rb.clientHeight >= rb.scrollHeight - 16;
        rb.textContent = live.rtext;
        if (atEnd && !touching) rb.scrollTop = rb.scrollHeight;   // 11/16: 指が触れている間は動かさない（指と取り合わない）
      }
      live.md.update(live.text, full);
    });
  }

  function seedLive(attempt) {
    startLive(attempt.attemptId);
    for (const r of attempt.stream || []) {
      if (r.type === "text-chunks") liveChunk({ type: "text-delta", text: r.texts.join("") });
      else if (r.type === "reasoning-chunks") liveChunk({ type: "reasoning-delta", text: r.texts.join("") });
      else if (r.type === "chunk") liveChunk(r.chunk);
    }
  }

  // --- following the session ---
  function onFrame(f) {
    if (f.type === "snapshot") {
      ready = false;
      log.replaceChildren();
      tools = new Map();
      dropLive();
      lastSeq = -1;
      evlog = [];
      cursor = f.cursor;
      branchHeader = f.header;
      const recs = f.records || [];
      oldestSeq = recs.length ? recs[0].event.seq : null;
      for (const r of recs) apply(r.event);
      older.classList.toggle("hidden", !f.hasMore);
      revision = f.assistantStream ? f.assistantStream.revision : null;
      if (f.assistantStream && f.assistantStream.activeAttempt) seedLive(f.assistantStream.activeAttempt);
      requestAnimationFrame(toBottom);
      ready = true;
    } else if (f.type === "event") {
      apply(f.event);
    } else if (f.type === "assistant-stream") {
      const fr = f.frame;
      if (revision != null && fr.revision !== revision + 1) return follow(); // missed a frame: start over
      revision = fr.revision;
      if (fr.type === "start") startLive(fr.attemptId);
      else if (fr.type === "chunk" && live && live.attemptId === fr.attemptId) liveChunk(fr.chunk);
      else if (fr.type === "end" && fr.outcome && fr.outcome.kind === "abandoned") dropLive();
      else if (fr.type === "end" && live) drawLive(true);   // 11/15: 終わり・止めたとき: 間引いて残った分を全文で描き直す
    }
  }

  function follow() {
    if (stopFollow) stopFollow();
    stopFollow = Api.mux.open("session/follow", {
      request: { address, assistantStream: true, maxMessages: 60, turnWindow: { minMessages: 30, minTurns: 2 } },
    }, {
      item: onFrame,
      error: (err) => {
        stopFollow = null;
        if (subInfo && err.code === "subagent/unauthorized") { // 11/2: opened through the wrong parent: use its own route
          const right = Store.routeOf(sessionId);
          if (right !== location.hash) { go(right, "replace"); return; }
        }
        if (err.code !== "socket-closed") log.append(h("div", { class: "marker bad" }, tr("Could not load: {0}", [err.message || err.code])));
      },
    });
  }

  older.addEventListener("click", async () => {
    if (oldestSeq == null) return;
    older.disabled = true;
    try {
      const page = await Api.page(address, cursor, oldestSeq);
      const recs = page.records || [];
      const saveLast = lastSeq;
      const frag = [];
      const evs = [];
      for (const r of recs) {
        const e = r.event;
        if (e.surfaceOp && e.surfaceOp !== "append") continue;
        evs.push(e);
        frag.push(...entriesFor(e));
      }
      evlog = [...evs, ...evlog];
      lastSeq = saveLast;
      if (recs.length) oldestSeq = recs[0].event.seq;
      const before = scroller.scrollHeight;
      log.prepend(...frag);
      scroller.scrollTop += scroller.scrollHeight - before;
      older.classList.toggle("hidden", !page.hasMore);
    } catch (e) {
      toast(tr("Loading failed: {0}", [e.message]));
    } finally {
      older.disabled = false;
    }
  });

  // --- header, asks, queue ---
  function renderHeader() {
    if (subInfo) {
      titleEl.textContent = subTitle || tr("Subagent");
      subEl.textContent = tr("Subagent • parent: {0}", [Store.title(subInfo.parentId)]);
      meter.classList.add("hidden");
      archivedBar.classList.add("hidden");
      composer.el.classList.add("hidden");
      return;
    }
    titleEl.textContent = Store.title(sessionId);
    const w = Store.workspaceOf(sessionId);
    const st = Store.S.strata;
    let sub = w ? Store.workspaceName(w) : "";
    if (running() && st && st.online && st.state !== "idle") sub += `${sub ? " • " : ""}${strataPill().textContent}`;
    subEl.textContent = sub;
    // the context meter replaces the spinner; while the agent runs a short arc circles the ring
    ctxRingUpdate(meter, ctxInfo(sessionId), running());
    const archived = Store.isArchived(sessionId);
    archivedBar.classList.toggle("hidden", !archived);
    composer.el.classList.toggle("hidden", archived);
    composer.refresh();
  }

  function renderAsks() {
    keepBottom(() => asks.replaceChildren(...pendingCards(sessionId)));
  }

  function inboxItems() {
    const p = Store.S.projections.get(sessionId) || {};
    const inbox = p.inbox || {};
    return [...(inbox["next-step"] || []).map((m) => ({ m, steer: true })), ...(inbox["next-turn"] || []).map((m) => ({ m, steer: false }))];
  }

  // --- 11/15: 仮の吹き出し（composer.js の Outbox）---
  // 本物と見るのは: 同じ本文の user/message（作った後の seq のもの．古い順に 1 つずつ対応づける），または「次に送る」の帯に
  // 新しく入った同じ本文の項目．送れたのに 20 秒たってもどちらも来ないときは，見えないまま外す（二重に残さない）．
  const normText = (s) => String(s || "").replace(/\r\n/g, "\n").trim();
  const textParts = (content) => (content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const pendingEls = new Map(); // entry.id -> el
  const claimedInbox = new Set();
  const liveEntries = () => Outbox.list(sessionId).filter((x) => x.state === "sending" || x.state === "sent");
  function claimPending(e, said) {
    const t = normText(said);
    const hit = liveEntries().find((x) => normText(x.text) === t
      && (x.floor == null ? (e.time || 0) >= x.at - 60000 : e.seq > x.floor));
    if (!hit) return false;
    Outbox.done(hit, "message");
    return true;
  }
  function claimQueued(items) {
    for (const { m } of items) {
      if (claimedInbox.has(m.id)) continue;
      const t = normText(textParts(m.content));
      const hit = liveEntries().find((x) => !(x.inboxSeen && x.inboxSeen.has(m.id)) && normText(x.text) === t);
      if (hit) { claimedInbox.add(m.id); Outbox.done(hit, "queue"); }
    }
  }
  function renderPending() {
    const want = liveEntries();
    for (const [id, node] of pendingEls) if (!want.some((x) => x.id === id)) { node.remove(); pendingEls.delete(id); }
    let added = false;
    for (const x of want) {
      if (pendingEls.has(x.id)) continue;
      const node = pendingBubble(x);
      pendingEls.set(x.id, node);
      pendingBox.append(node);
      added = true;
    }
    if (added) toBottom(); // 自分で送った発言は，読み返している途中でもいちばん下へ
  }
  const sentTimers = new Map();
  function onOutbox(entry, what) {
    if (what === "rekey" || !entry) { renderPending(); return; }
    if (entry.key !== sessionId) return;
    if (what === "failed") {
      // 仮を外して本文と添付を入力欄へ（打ちかけの文があれば消さずに並べる）
      Outbox.done(entry, "failed");
      const how = composer.restore(entry.text, entry.atts);
      if (how === "merged") toast(tr("The message that was not sent is back at the top of the box"));
      return;
    }
    if (what === "sent" && entry.state === "sent" && !sentTimers.has(entry.id)) {
      sentTimers.set(entry.id, setTimeout(() => { sentTimers.delete(entry.id); if (entry.state === "sent") Outbox.done(entry, "timeout"); }, 20000));
    }
    renderPending();
  }
  const offOutbox = Outbox.on(onOutbox);

  function renderQueue() {
    const items = inboxItems();
    claimQueued(items);
    queue.replaceChildren(...items.map(({ m, steer }) => h("div", { class: "queued" },
      h("span", { class: "queued-tag" }, steer ? tr("Waiting to steer") : tr("Next")),
      h("span", { class: "queued-text" }, textOf(m.content)),
      steer ? null : h("button", { class: "mini", type: "button", onclick: () => Api.updateQueue(sessionId, m.id, "steer").catch((e) => toast(e.message)) }, tr("Steer")),
      h("button", { class: "mini", type: "button", "aria-label": tr("Remove"), onclick: () => Api.updateQueue(sessionId, m.id, "remove").catch((e) => toast(e.message)) }, "×"))));
  }

  // Pin, rename and archive come from the shared menu; this screen adds reload and stop. Archiving leaves the screen.
  function openMenu() {
    if (subInfo) {
      const s = openSheet([h("div", { class: "sheet-title" }, subTitle || tr("Subagent")),
        sheetItem("restore", tr("Reload"), () => { s.close(true); follow(); }),
        sheetItem("file", tr("Copy conversation"), () => { s.close(true); copyConversation(); }),
        subCount() ? sheetItem("tool", tr("Subagents ({0})", [subCount()]), () => { s.close(true); openSubsSheet(); }) : null,
        sheetItem("back", tr("Back to the parent conversation"), () => { s.close(true); go(Store.routeOf(subInfo.parentId), "back"); }),
        h("div", { class: "sheet-foot muted small" }, `ID: ${sessionId}`)]);
      return;
    }
    openSessionActions(sessionId, {
      after: (kind) => { if (kind === "archive") go("#/", "back"); },
      extra: (close) => [
        sheetItem("restore", tr("Reload"), () => { close(true); follow(); }),
        sheetItem("file", tr("Copy conversation"), () => { close(true); copyConversation(); }),
        subCount() ? sheetItem("tool", tr("Subagents ({0})", [subCount()]), () => { close(true); openSubsSheet(); }) : null,
        permissionItem(sessionId, () => { close(true); openPermissionSheet(sessionId); }),
        sheetItem("power", tr("Start / stop Strata"), () => { close(true); openStrataSheet(); }),
        running() ? sheetItem("stop", tr("Stop the run"), () => { close(true); Api.cancel(sessionId).catch((e) => toast(errorText(e))); }, "bad") : null,
      ],
      footer: `ID: ${sessionId}`,
    });
  }
  more.addEventListener("click", openMenu);

  // --- 会話をコピー (10/31): 「あなた: …」「AI: …」 separated by blank lines. Tool rows, thinking,
  // notices and cards are left out; an attachment is one line with its name. Older pages not loaded yet are read first.
  function lineOf(e) {
    const d = e.data || {};
    if (e.type === "user/message") {
      const src = d.source || {};
      if (src.kind !== "user") return null;
      const parts = d.content || [];
      const text = parts.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
      const atts = parts.filter((x) => x.type === "image" || x.type === "file").map((x) => tr("[attachment] {0}", [x.name || (x.attachment && x.attachment.name) || (x.type === "image" ? tr("Image") : tr("File"))]));
      const body = [text, ...atts].filter(Boolean).join("\n");
      return body ? `${subInfo ? tr("Parent agent") : tr("You")}: ${body}` : null;
    }
    if (e.type === "assistant/message") {
      const t = ((d.message && d.message.content) || []).filter((b) => b.type === "text" && b.text.trim()).map((b) => b.text.trim()).join("\n\n");
      return t ? `AI: ${t}` : null;
    }
    return null;
  }
  async function copyConversation() {
    let list = evlog.slice();
    let before = oldestSeq;
    let more = !older.classList.contains("hidden");
    try {
      if (more) Copy.notice(tr("Loading the conversation…"));
      while (more && before != null) {
        const page = await Api.page(address, cursor, before);
        const recs = page.records || [];
        if (!recs.length) break;
        list = [...recs.map((r) => r.event).filter((e) => !e.surfaceOp || e.surfaceOp === "append"), ...list];
        before = recs[0].event.seq;
        more = page.hasMore;
      }
    } catch {
      Copy.notice(tr("Could not load the older messages"));
      return;
    }
    const text = list.map(lineOf).filter(Boolean).join("\n\n");
    if (!text) { Copy.notice(tr("Nothing to copy")); return; }
    if (await Copy.write(text)) { Copy.notice(tr("Copied the conversation")); return; }
    // after a long read the phone may refuse a write that no longer follows a tap: one more tap does it
    const sh = openSheet([h("div", { class: "sheet-title" }, tr("The conversation is loaded")),
      h("button", { class: "btn primary wide-in", type: "button", onclick: async () => {
        sh.close(true);
        Copy.notice((await Copy.write(text)) ? tr("Copied the conversation") : tr("Could not copy"));
      } }, tr("Copy now"))]);
  }

  // --- subagents (10/31) ---
  function subChildId(text) {
    const m = String(text || "").trim().match(/^started (?:background subagent job|subagent) (\S+)$/m);
    return m ? m[1] : null;
  }
  function subDesc(args) {
    try { const a = JSON.parse(args || "{}"); return a.description || null; } catch { return null; }
  }
  // 11/2: who another agent is to this conversation: "parent" (the one that started this subagent), "child" (one this
  // conversation started), "other" (known elsewhere in dsh's list) or "unknown"
  function relOf(id) {
    if (subInfo && id === subInfo.parentId) return "parent";
    const c = Store.S.children.get(id);
    if (subs.has(id) || (c && c.parentSessionId === sessionId)) return "child";
    if (Store.S.sessions.has(id) || c) return "other";
    return "unknown";
  }
  // a link that opens that agent where dsh allows it: a child through this conversation, anyone else by its own route
  // (a subagent through its own parent). An unknown id in a top conversation is taken for one of its subagents
  // (as before); in a subagent's conversation it gets no link.
  function linkTo(id) {
    const rel = relOf(id);
    if (rel === "child" || (rel === "unknown" && !subInfo)) return subLink(id);
    if (rel === "unknown") return null;
    const isSub = Store.isChild(id);
    const label = isSub ? Store.subLabel(id) || tr("Subagent") : Store.title(id);
    const route = rel === "parent" && !Store.S.sessions.has(id) && !isSub ? `#/s/${encodeURIComponent(id)}` : Store.routeOf(id);
    return h("button", { class: "sub-link", type: "button", onclick: () => go(route) },
      icon(isSub ? "tool" : "code", "small"), h("span", { class: "sub-label" }, label),
      h("span", { class: "sub-open" }, rel === "parent" ? tr("Open parent") : tr("Open")));
  }
  function subHash(cid) { return `#/s/${encodeURIComponent(sessionId)}/sub/${encodeURIComponent(cid)}`; }
  // 11/2: the name from this conversation's own log (subagent/catalog, the workflow's agent-start), else from dsh's list
  function labelOf(cid) { return (subs.get(cid) || {}).label || Store.subLabel(cid) || null; }
  function subLink(cid) {
    const run = (Store.S.children.get(cid) || {}).running;
    return h("button", { class: "sub-link", type: "button", "data-cid": cid, onclick: () => go(subHash(cid)) },
      icon("tool", "small"), h("span", { class: "sub-label" }, labelOf(cid) || tr("Subagent")),
      h("span", { class: `sub-run${run ? "" : " hidden"}` }, tr("Running")), h("span", { class: "sub-open" }, tr("Open")));
  }
  // every subagent of this conversation: the ones its loaded log names, and (11/2) the ones dsh lists with it as parent,
  // so the ones started before the loaded part of a long (compacted) history are there too
  function allSubIds() {
    const ids = new Set(subs.keys());
    for (const c of Store.childrenOf(sessionId)) ids.add(c.sessionId);
    return ids;
  }
  function subCount() { return allSubIds().size; }
  function openSubsSheet() {
    const info = (cid) => Store.S.children.get(cid) || {};
    const seen = new Map([...subs.keys()].map((k, i) => [k, i]));
    const ids = [...allSubIds()].sort((a, b) => ((info(b).running ? 1 : 0) - (info(a).running ? 1 : 0))
      || ((info(b).updatedAt || 0) - (info(a).updatedAt || 0)) || ((seen.get(b) ?? -1) - (seen.get(a) ?? -1)));
    const n = ids.filter((cid) => info(cid).running).length;
    const rows = ids.map((cid) => h("button", { class: "sheet-item with-icon run-pick", type: "button", onclick: () => { s.close(true); go(subHash(cid)); } },
      icon("tool"), h("span", { class: "run-pick-text" }, h("span", { class: "run-pick-name" }, labelOf(cid) || cid.slice(0, 8))),
      info(cid).running ? h("span", { class: "run-pick-state on" }, tr("Running")) : null));
    const s = openSheet([h("div", { class: "sheet-title" }, n ? tr("Subagents ({0}, {1} running)", [ids.length, n]) : tr("Subagents ({0})", [ids.length])),
      ids.length ? null : h("div", { class: "sheet-note muted" }, tr("No subagents.")), ...rows]);
  }
  // the 実行中 marks on the links follow the subagents' state
  function refreshSubLinks() {
    for (const el of log.querySelectorAll(".sub-link[data-cid]")) {
      const run = !!(Store.S.children.get(el.dataset.cid) || {}).running;
      const m = el.querySelector(".sub-run");
      if (m) m.classList.toggle("hidden", !run);
    }
  }
  function renderSubBar() {
    const n = Store.runningUnder(sessionId);
    subBar.classList.toggle("hidden", !n);
    if (n) subBar.replaceChildren(h("span", { class: "spinner small" }), h("span", { class: "grow" }, trp("{0} subagent running", "{0} subagents running", n)), icon("chevron", "small turn"));
  }

  scroller.addEventListener("scroll", () => jump.classList.toggle("hidden", nearBottom()));
  jump.addEventListener("click", () => { sticky = true; scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }); });

  const off = Store.on((topic, id) => {
    if (topic === "reconnected") follow();
    if (["sessions", "status", "projections", "workspaces", "strata", "catalog"].includes(topic)) renderHeader();
    if (topic === "sessions" || topic === "status") { renderSubBar(); refreshSubLinks(); }
    if (topic === "strata") renderSeat();
    if (topic === "strata" && live && !live.text) live.count.textContent = thinkingCount(sessionId);
    if (topic === "projections" && (!id || id === sessionId)) renderQueue();
    if (topic === "pending") renderAsks();
    if (topic === "error" && id === sessionId) log.append(h("div", { class: "marker bad" }, seatCheck(Store.S.errors.get(sessionId))));
  });
  renderHeader();
  renderSeat();
  document.addEventListener("sync-ctxnum", renderHeader);   // 11/16: the ring's red mark follows dsh's real numbers
  CtxNum.load();
  renderQueue();
  renderAsks();
  renderSubBar();
  // 11/15: 新しい会話の画面から移ってきた送信中の発言（と，ほかの画面にいる間に失敗したもの）
  for (const x of Outbox.list(sessionId)) if (x.state === "failed" || x.state === "sent") onOutbox(x, x.state);
  renderPending();
  if (Store.S.conn === "online") follow();
  // 11/14: Esc (no sheet, menu or picture open, not typing elsewhere) asks whether to stop the run
  const onKey = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || subInfo || !el.isConnected || !running()) return;
    if (sheetOpen() || document.querySelector(".img-large, .copy-menu, .copy-bar")) return;
    if (e.target && e.target.closest && e.target.closest("input, textarea") && !composer.el.contains(e.target)) return;
    e.preventDefault();
    confirmSheet({ title: tr("Stop this run?"), okLabel: tr("Stop the run"), danger: true })
      .then((ok) => { if (ok) Api.cancel(sessionId).catch((err) => toast(errorText(err))); });
  };
  document.addEventListener("keydown", onKey);
  return { el, destroy() {
    branchSheet?.close(true);
    off(); offOutbox(); for (const t of sentTimers.values()) clearTimeout(t);
    if (stopFollow) stopFollow(); dropLive(); copier.destroy(); document.removeEventListener("keydown", onKey);
    document.removeEventListener("sync-ctxnum", renderHeader);
  } };
}
