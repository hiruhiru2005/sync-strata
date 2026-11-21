// The session list (home screen), the archive list and the new-session screen, laid out after the Claude Code
// phone app: one card per session with its state, workspace and age, a preview box when it waits for an answer,
// pinned sessions on top, a search bar, and a round "+" button that opens a new session. Tapping the Strata pill
// opens the sheet that starts and stops Strata (strata.js).
"use strict";

// 10/31 元のアプリと同じ日付の扱い: 「今日・昨日・それ以前」で束ね，行の右には時刻（今日・昨日）か
// 日付（それ以前．年が違えば年も）だけを出す．境目は端末の時計の 0 時．時刻は dsh の updatedAt（ミリ秒，一覧の並びと同じ値）．
// 一覧を描くたびにその時の時計で決めるので，0 時をまたいでも次に描き直したとき束が変わる．
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function dayGroup(ms, now = new Date()) {
  const day = startOfDay(new Date(ms));
  const today = startOfDay(now);
  if (day === today) return "today";
  if (day === today - 86400000) return "yesterday";
  return "earlier";
}
function dayLabel(k) {
  return k === "today" ? tr("Today") : k === "yesterday" ? tr("Yesterday") : tr("Earlier");
}
function fmtRowTime(ms, now = new Date()) {
  if (dayGroup(ms, now) !== "earlier") return I18n.time(ms);
  return I18n.day(ms, new Date(ms).getFullYear() !== now.getFullYear());
}
// 元の並び（新しい順）を保ったまま束ねる．空の束は出さない．timeOf: 要素 → ミリ秒
function groupByDay(list, timeOf, now = new Date()) {
  const order = ["today", "yesterday", "earlier"];
  const buckets = new Map(order.map((k) => [k, []]));
  for (const it of list) buckets.get(dayGroup(timeOf(it), now)).push(it);
  return order.filter((k) => buckets.get(k).length).map((k) => ({ label: dayLabel(k), items: buckets.get(k) }));
}

function pendingPreview(id) {
  const items = Store.pendingFor(id);
  if (!items.length) return null;
  const p = items[0];
  if (p.event === "approval/request") return tr("Approval needed: {0}", [p.request.toolName || tr("tool")]);
  const qs = (p.request && p.request.questions) || [];
  return trp("Answer {0} question: {1}", "Answer {0} questions: {1}", qs.length, [qs.length, qs.map((q) => q.header || q.question).join(tr(" / "))]);
}

// 11/14: on the wide layouts the list stays beside the session: the card of the open session is marked
const isCurrent = (id) => !!(window.dshRoute && dshRoute.wide() && (dshRoute.session() || {}).id === id);

// One card. o: {go, onMore(id), snippet}. The "…" button and a long press both open the session's menu.
function sessionCard(s, o) {
  const id = s.sessionId;
  const w = Store.workspaceOf(id);
  const preview = pendingPreview(id);
  const running = s.running;
  const archived = Store.isArchived(id);
  const pinned = Store.isPinned(id);
  const stateText = archived ? tr("Archived") : running ? tr("Running") : preview ? tr("Needs reply") : tr("Idle");
  const stateCls = running ? "state run" : preview ? "state wait" : "state";
  const kids = Store.runningUnder(id); // 11/2: its subagents that run now
  const more = h("button", { class: "icon-btn small card-more", type: "button", "aria-label": tr("Actions"), html: ICONS.more });
  const cur = isCurrent(id);
  const el = h("div", { class: `card${preview ? " waiting" : ""}${archived ? " archived" : ""}${cur ? " current" : ""}`, role: "button", tabindex: "0", "data-id": id, "aria-current": cur ? "page" : null },
    h("div", { class: "card-main" },
      h("div", { class: `card-icon${running ? " running" : ""}${pinned ? " pinned" : ""}` }, running ? h("span", { class: "spinner" }) : icon(pinned ? "pin" : "code")),
      h("div", { class: "card-text" },
        h("div", { class: "card-title" }, Store.title(id)),
        h("div", { class: "card-sub" },
          h("span", { class: stateCls }, icon("laptop", "small"), stateText),
          kids ? h("span", { class: "sub-run sep" }, tr("• {0} sub running", [kids])) : null,
          w ? h("span", { class: "muted sep ellipsis" }, `• ${Store.workspaceName(w)}`) : null)),
      h("span", { class: "card-time" }, fmtRowTime(s.updatedAt)),
      more),
    o.snippet ? h("div", { class: "card-snippet muted" }, o.snippet) : null,
    preview ? h("div", { class: "card-preview" }, preview) : null);
  el.addEventListener("click", () => o.go(`#/s/${encodeURIComponent(id)}`));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") o.go(`#/s/${encodeURIComponent(id)}`); });
  more.addEventListener("click", (e) => { e.stopPropagation(); o.onMore(id); });
  onLongPress(el, () => o.onMore(id));
  return el;
}

// Draws a list of items into `body` and animates the change: cards that moved slide to their new place, new cards
// rise in, and (with ghost) a card that left slides away. Redraws nothing when the visible content is unchanged,
// so a finger resting on a card is not interrupted by background updates.
// Items: {kind:"label", text} | {kind:"empty", text} | {kind:"archive", n} | {kind:"card", s, snippet}.
function CardList(body, go, firstRise) {
  let lastSig = null;
  let first = firstRise;
  const sigOf = (d) => {
    if (d.kind !== "card") return `${d.kind}|${d.text || d.n}`;
    const id = d.s.sessionId;
    const w = Store.workspaceOf(id);
    return ["c", id, Store.title(id), d.s.running, Store.runningUnder(id), pendingPreview(id) || "", fmtRowTime(d.s.updatedAt), w ? Store.workspaceName(w) : "",
      Store.isPinned(id), Store.isArchived(id), d.snippet || "", isCurrent(id)].join("|");
  };
  const build = (d) => {
    if (d.kind === "label") return h("div", { class: "group-label" }, d.text);
    if (d.kind === "empty") return h("div", { class: "empty muted" }, d.text);
    if (d.kind === "foot") return h("div", { class: "foot muted" }, d.text);
    if (d.kind === "archive") {
      return h("button", { class: "archive-row", type: "button", onclick: () => go("#/archived") },
        icon("archive", "small"), h("span", { class: "grow" }, tr("Archive ({0})", [d.n])), icon("chevron", "small turn"));
    }
    return sessionCard(d.s, { go, onMore: (id) => openSessionActions(id), snippet: d.snippet });
  };

  // 11/14: ↑↓ move between the cards (Enter opens one, as before)
  body.addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || !e.target.matches(".card[data-id]")) return;
    const cards = [...body.querySelectorAll(".card[data-id]")];
    const next = cards[cards.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
  });

  return {
    render(items, opts = {}) {
      const sig = items.map(sigOf).join("\n");
      if (sig === lastSig) return;
      lastSig = sig;
      const animate = !reducedMotion();
      const oldTops = new Map();
      const oldEls = new Map();
      if (animate) {
        for (const c of body.querySelectorAll(".card[data-id]")) {
          oldTops.set(c.dataset.id, c.getBoundingClientRect().top);
          oldEls.set(c.dataset.id, c);
        }
      }
      const oldBodyTop = body.getBoundingClientRect().top;
      const oldScroll = body.scrollTop;
      body.replaceChildren(...items.map(build));
      if (!animate) return;
      const cards = [...body.querySelectorAll(".card[data-id]")];
      const now = new Set(cards.map((c) => c.dataset.id));
      cards.forEach((c, i) => {
        const prev = oldTops.get(c.dataset.id);
        if (prev == null) {
          if (oldEls.size || first) rise(c, first ? Math.min(i, 8) * 35 : 0);
        } else {
          const dy = prev - c.getBoundingClientRect().top;
          if (Math.abs(dy) > 1) c.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
        }
      });
      if (cards.length) first = false;
      const gone = [...oldEls].filter(([id]) => !now.has(id));
      if (opts.ghost && gone.length && gone.length <= 2) {
        for (const [id, el] of gone) {
          el.style.cssText = `position:absolute;left:14px;right:14px;top:${oldTops.get(id) - oldBodyTop + oldScroll}px;margin:0;pointer-events:none;z-index:1`;
          body.append(el);
          el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(48px)" }], { duration: 230, easing: "ease-in", fill: "forwards" })
            .finished.then(() => el.remove(), () => el.remove());
        }
      }
    },
  };
}

// dsh's full-text session search is an opt-in feature (off unless its config says openAt: first-search / startup).
// While it is off, searching matches titles only; the first "disabled" answer is remembered for the page's life.
let contentSearchOn = true;

function ListView(go) {
  let filter = localStorageGet("dsh-mobile-filter") || "all";
  let query = "";
  let hits = new Map(); // sessionId -> snippet, from the content search
  let searching = false;
  let searchSeq = 0;
  let searchTimer = null;

  const body = h("div", { class: "list-body" });
  const list = CardList(body, go, Store.S.sessions.size === 0);
  // 11/2: while Strata reads or writes, the pill opens the session it works for (a subagent's too); otherwise start/stop
  const pill = h("button", { class: "pill-slot", type: "button", "aria-label": tr("Strata status (opens the session it is writing for)"),
    onclick: () => (strataBusy() ? jumpToWriting(go) : openStrataSheet()) });
  const wsChip = h("button", { class: "chip ghost-chip", type: "button", onclick: () => openWorkspaceSheet({
    currentId: filter, includeAll: true, title: tr("Filter by workspace"),
    onPick: (w) => { filter = w.workspaceId; localStorageSet("dsh-mobile-filter", filter); render(); },
  }) });
  const banner = h("div", { class: "banner hidden" });
  const searchBtn = h("button", { class: "icon-btn", type: "button", "aria-label": tr("Search"), html: ICONS.search, onclick: () => openSearch() });
  // 10/31: the Strata pill sits on the row below the title ("考え中 3,450 トークン · 61 tok/s" pushed the title onto 3 lines)
  // 11/14: the settings (language, Enter key, text size, keys) open from the gear beside the search
  const setBtn = h("button", { class: "icon-btn", type: "button", "aria-label": tr("Settings"), html: ICONS.gear, onclick: () => openSettingsSheet() });
  // 11/16 本人: the phone connection (QR, LAN / Tailscale, connected devices) opens from its own icon beside the search and the gear.
  // Only on the PC page itself (127.0.0.1): a phone is already connected, and the relay lets only the PC change it or show the QR.
  const remoteBtn = typeof Remote !== "undefined" && Remote.isPcPage()
    ? h("button", { class: "icon-btn", type: "button", "aria-label": tr("Phone connection"), html: ICONS.phone, onclick: () => Remote.openSheet() }) : null;
  const brandBar = h("header", { class: "topbar" }, h("div", { class: "brand" }, tr("Sessions")), searchBtn, ...(remoteBtn ? [remoteBtn] : []), setBtn);
  const searchInput = h("input", { class: "search-input", type: "search", placeholder: tr("Search sessions"), enterkeyhint: "search", autocomplete: "off" });
  const searchHint = () => { searchInput.placeholder = contentSearchOn ? tr("Search titles and text") : tr("Search titles"); };
  const searchBar = h("header", { class: "topbar searchbar hidden" },
    h("button", { class: "icon-btn", type: "button", "aria-label": tr("Close search"), html: ICONS.back, onclick: () => closeSearch() }),
    searchInput,
    h("button", { class: "icon-btn", type: "button", "aria-label": tr("Clear"), html: ICONS.close, onclick: () => { searchInput.value = ""; onSearchInput(); searchInput.focus(); } }));
  const sectionHead = h("div", { class: "section-head" }, pill, wsChip);
  const el = h("div", { class: "screen list" }, brandBar, searchBar, banner, sectionHead, body,
    h("button", { class: "fab", type: "button", "aria-label": tr("Start new session"), onclick: () => go("#/new"), html: ICONS.plus + `<span>${Md.esc(tr("New session"))}</span>` }));

  function openSearch() {
    brandBar.classList.add("hidden");
    searchBar.classList.remove("hidden");
    sectionHead.classList.add("hidden");
    el.classList.add("searching");
    searchHint();
    setTimeout(() => searchInput.focus(), 30);
  }

  function closeSearch() {
    searchInput.value = "";
    onSearchInput();
    searchBar.classList.add("hidden");
    brandBar.classList.remove("hidden");
    sectionHead.classList.remove("hidden");
    el.classList.remove("searching");
  }

  function onSearchInput() {
    query = searchInput.value.trim();
    clearTimeout(searchTimer);
    searchSeq++;
    hits = new Map();
    searching = false;
    render();
    if (query.length < 2 || !contentSearchOn) return;
    const seq = searchSeq;
    searchTimer = setTimeout(async () => {
      searching = true;
      render();
      try {
        const r = await Api.search(query);
        if (seq === searchSeq) hits = new Map((r.items || []).map((i) => [i.sessionId, i.snippet]));
      } catch (e) {
        if (/disabled/.test(e.message || "")) { contentSearchOn = false; searchHint(); } // the title matches stay either way
      }
      if (seq === searchSeq) { searching = false; render(); }
    }, 350);
  }
  searchInput.addEventListener("input", onSearchInput);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSearch(); });

  function renderFilter() {
    if (Store.S.workspacesReady && filter !== "all" && !Store.S.workspaces.some((x) => x.workspaceId === filter)) {
      filter = "all";
      localStorageSet("dsh-mobile-filter", filter);
    }
    const w = Store.S.workspaces.find((x) => x.workspaceId === filter);
    wsChip.replaceChildren(icon("folder", "small"), w ? Store.workspaceName(w) : tr("All"), icon("chevron", "small"));
  }

  function inFilter(s) {
    if (filter === "all") return true;
    const w = Store.S.workspaces.find((x) => x.workspaceId === filter);
    return !!w && (w.sessionIds || []).includes(s.sessionId);
  }

  function items() {
    if (query) {
      const q = query.toLowerCase();
      const all = [...Store.S.sessions.values()].filter((s) => !s.blank).sort((a, b) => b.updatedAt - a.updatedAt);
      const byTitle = all.filter((s) => Store.title(s.sessionId).toLowerCase().includes(q));
      const titled = new Set(byTitle.map((s) => s.sessionId));
      const byBody = all.filter((s) => hits.has(s.sessionId) && !titled.has(s.sessionId));
      const found = [...byTitle, ...byBody].map((s) => ({ kind: "card", s, snippet: hits.get(s.sessionId) }));
      const out = [];
      for (const g of groupByDay(found, (x) => x.s.updatedAt)) out.push({ kind: "label", text: g.label }, ...g.items);
      if (out.length) return out;
      return [{ kind: "empty", text: searching ? tr("Searching…") : tr("No matching sessions") }];
    }
    const { pinned, rest } = Store.groupedSessions();
    const p = pinned.filter(inFilter);
    const r = rest.filter(inFilter);
    const out = [];
    if (p.length) out.push({ kind: "label", text: tr("Pinned") }, ...p.map((s) => ({ kind: "card", s })));
    for (const g of groupByDay(r, (s) => s.updatedAt)) out.push({ kind: "label", text: g.label }, ...g.items.map((s) => ({ kind: "card", s })));
    if (!p.length && !r.length) out.push({ kind: "empty", text: tr("No sessions yet") });
    const n = Store.archivedSessions().length;
    if (n) out.push({ kind: "archive", n });
    if (window.dshVersion) {
      const d = new Date(Number(window.dshVersion));
      out.push({ kind: "foot", text: tr("Page version {0}", [`${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`]) });
    }
    return out;
  }

  function render() {
    renderFilter();
    list.render(items(), { ghost: !query });
  }

  function renderConn() {
    const c = Store.S.conn;
    banner.classList.toggle("hidden", c === "online");
    banner.textContent = c === "connecting" ? tr("Connecting…") : c === "offline" ? tr("Waiting to reconnect ({0})", [Store.S.connError || tr("Cannot reach dsh")]) : "";
  }

  const off = Store.on((topic) => {
    if (["sessions", "workspaces", "projections", "pending", "status"].includes(topic)) render();
    if (topic === "conn") renderConn();
    if (topic === "strata") pill.replaceChildren(strataPill());
  });
  const tick = setInterval(render, 30000);
  pill.replaceChildren(strataPill());
  render();
  renderConn();
  // 11/14: Ctrl/⌘+K (wide.js) opens the search; the open session's card follows the route on wide layouts
  const onSearchKey = () => { if (el.isConnected) openSearch(); };
  const onRoute = () => { if (window.dshRoute && dshRoute.wide()) render(); };
  document.addEventListener("dsh:search", onSearchKey);
  window.addEventListener("hashchange", onRoute);
  return { el, destroy() { off(); clearInterval(tick); clearTimeout(searchTimer); document.removeEventListener("dsh:search", onSearchKey); window.removeEventListener("hashchange", onRoute); } };
}

function ArchivedView(go) {
  const body = h("div", { class: "list-body" });
  const list = CardList(body, go, false);
  const el = h("div", { class: "screen archived" },
    h("header", { class: "topbar" },
      h("button", { class: "icon-btn", type: "button", "aria-label": tr("Back"), onclick: () => go("#/", "back"), html: ICONS.back }),
      h("div", { class: "topbar-title" }, tr("Archive")), h("div", { class: "icon-btn" })),
    h("div", { class: "section-note muted small" }, tr("Archived sessions cannot be continued until restored.")),
    body);

  function render() {
    const arch = Store.archivedSessions();
    list.render(arch.length ? arch.map((s) => ({ kind: "card", s })) : [{ kind: "empty", text: tr("No archived sessions") }], { ghost: true });
  }
  const off = Store.on((topic) => { if (["sessions", "workspaces", "projections", "pending", "status"].includes(topic)) render(); });
  const tick = setInterval(render, 30000);
  render();
  return { el, destroy() { off(); clearInterval(tick); } };
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? tr("Good evening") : hr < 11 ? tr("Good morning") : hr < 18 ? tr("Hello") : tr("Good evening");
}

function NewView(go) {
  let wsId = localStorageGet("dsh-mobile-workspace");
  let sel = null;
  // 11/10: 新しい会話はいつも R4・低で始める（本人）．dsh の既定（最後にどこかで選んだモデル）には左右されない．
  // この画面でモデルを選び直したときだけそれに従う．R4 が一覧にないとき（dsh の設定から消したなど）は dsh の既定
  const NEW_DEFAULT = DSH_CONFIG.newSessionModel;
  const newDefault = () => (Store.modelInfo(NEW_DEFAULT) ? NEW_DEFAULT : Store.selection(null));
  const wsChip = h("button", { class: "chip big", type: "button" });
  const composer = Composer({
    getSelection: () => sel || newDefault(),
    onSelect: (s) => { sel = s; composer.refresh(); },
    // 11/15: 押した瞬間に入力欄を空にし，この画面に仮の吹き出しを出す．会話を作れたらすぐ会話の画面へ移り（仮の吹き出しは
    // そちらへ引き継ぐ），送信は裏で続ける（Outbox）．続けて押した分は同じ新しい会話へ順に送る（会話を 2 つ作らない）．
    // 会話を作れなかったら，仮を外して本文と添付を入力欄へ戻し，元の画面に戻す．
    optimistic: true,
    onSend: (text, atts) => {
      const w = currentWs();
      if (!w) throw new Error(tr("No workspace. Add a folder first"));
      const st = Store.S.strata;
      if (atts && atts.some((a) => a.kind === "image") && st && st.online && !st.images) {   // 会話を作る前に（空の会話を残さない）
        throw new Error(tr("The running Strata cannot read images. Restart Strata, then send again (the images are still in the box)"));
      }
      const use = sel || newDefault();
      if (!creating) {
        const key = `new:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        tmpKey = key;
        creating = (async () => {
          const { sessionId } = await Api.createSession(w.workspaceId);
          if (use) await Api.selectModel(sessionId, use.provider, use.model, use.reasoningEffort).catch(() => {});
          return sessionId;
        })();
        creating.then((sessionId) => {
          if (tmpKey === key) tmpKey = sessionId; // 移るまでの間に押した分も，同じ会話の列の後ろへ
          Outbox.rekey(key, sessionId);
          if (el.isConnected) go(`#/s/${encodeURIComponent(sessionId)}`, "replace");
        }, () => { if (tmpKey === key) { tmpKey = null; creating = null; } });
      }
      const made = creating;
      Outbox.send(tmpKey, text, atts, async () => {
        const sessionId = await made;
        return atts && atts.length ? Attach.send({ sessionId, text, atts, mode: "queue", sel: use }) : Api.prompt(sessionId, text, "queue");
      }, { floor: null, inboxSeen: new Set() });
    },
  });
  let creating = null; // 新しい会話を作っている Promise（会話の ID）
  let tmpKey = null;   // 会話ができるまでの Outbox の鍵
  const sendingLog = h("div", { class: "log" });
  const sending = h("div", { class: "transcript new-sending hidden" }, sendingLog);
  const pendingEls = new Map();
  function renderSending() {
    const want = tmpKey ? Outbox.list(tmpKey).filter((x) => x.state === "sending" || x.state === "sent") : [];
    for (const [id, node] of pendingEls) if (!want.some((x) => x.id === id)) { node.remove(); pendingEls.delete(id); }
    for (const x of want) if (!pendingEls.has(x.id)) { const node = pendingBubble(x); pendingEls.set(x.id, node); sendingLog.append(node); }
    const on = want.length > 0;
    sending.classList.toggle("hidden", !on);
    hero.classList.toggle("hidden", on);
    if (on) sending.scrollTop = sending.scrollHeight;
  }
  const offOutbox = Outbox.on((entry, what) => {
    // 会話を作れずに失敗した分（鍵が仮のまま）: 仮を外して入力欄へ戻す．会話ができた後の失敗は会話の画面が戻す
    if (entry && what === "failed" && typeof entry.key === "string" && entry.key.startsWith("new:")) {
      Outbox.done(entry, "failed");
      const how = composer.restore(entry.text, entry.atts);
      if (how === "merged") toast(tr("The message that was not sent is back at the top of the box"));
      return;
    }
    renderSending();
  });

  function currentWs() {
    const list = Store.S.workspaces;
    return list.find((w) => w.workspaceId === wsId) || list[0] || null;
  }

  function pickWs(w) {
    wsId = w.workspaceId;
    localStorageSet("dsh-mobile-workspace", wsId);
    renderWs();
  }

  function renderWs() {
    const w = currentWs();
    const next = w?.workspaceId || "";
    if (Store.S.workspacesReady && wsId !== next) {
      wsId = next;
      localStorageSet("dsh-mobile-workspace", wsId);
    }
    wsChip.replaceChildren(icon("folder", "small"), w ? Store.workspaceName(w) : tr("No workspace"), icon("chevron", "small"));
  }

  // Always opens, even with a single workspace: it is also where a folder is added and a workspace renamed.
  wsChip.addEventListener("click", () => {
    const w = currentWs();
    openWorkspaceSheet({ currentId: w && w.workspaceId, onPick: pickWs, onAdded: pickWs });
  });

  const hero = h("div", { class: "hero" }, h("div", { class: "hero-mark" }, icon("code")), h("div", { class: "hero-text" }, greeting()));
  const el = h("div", { class: "screen new" },
    h("header", { class: "topbar" },
      h("button", { class: "icon-btn back-btn", type: "button", "aria-label": tr("Back"), onclick: () => go("#/", "back"), html: ICONS.back }),
      h("div", { class: "topbar-title" }, tr("Start new session")), h("div", { class: "icon-btn" })),
    hero, sending,
    h("div", { class: "bottom" }, h("div", { class: "chips" }, wsChip), composer.el));

  const off = Store.on((topic) => {
    if (topic === "workspaces") renderWs();
    if (topic === "catalog" || topic === "projections") composer.refresh();
  });
  renderWs();
  setTimeout(() => composer.focus(), 50);
  return { el, destroy() { off(); offOutbox(); } };
}

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}
