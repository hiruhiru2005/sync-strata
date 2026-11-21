// App-wide state kept live from dsh: the session list ($events emits), workspaces (workspace/follow),
// per-session projections such as title, model and queue (session/control), and pending approvals and
// questions ($events waterfalls). Views subscribe with Store.on(fn) and re-render on the topic they care about.
"use strict";

const Store = (() => {
  const S = {
    conn: "connecting", // connecting | online | offline | unauthorized | forbidden
    connError: "",
    clientId: null,
    sessions: new Map(), // sessionId -> SessionSummary
    children: new Map(), // 11/2: subagents' sessions (parentSessionId set), kept apart from the list: sessionId -> SessionSummary
    workspaces: [], // WorkspaceView {workspaceId, path, title, sessionIds}
    workspacesReady: false,
    archived: new Set(),
    pinned: [], // sessionIds, most recently pinned first
    projections: new Map(), // sessionId -> {title, modelSelection, inbox, userQuestions, ...}
    pending: new Map(), // eventId -> {event, agentId, request}
    errors: new Map(), // sessionId -> last agent error outside a turn
    catalog: null,
    strata: null,
  };
  const listeners = new Set();
  let stops = [];
  let retry = null;
  let backoff = 1000;
  let generation = 0;

  const emit = (topic, id) => { for (const f of listeners) f(topic, id); };
  // Forks have a parentSessionId for lineage, but only subagents need a parent address.
  const isTop = (s) => s.origin !== "subagent";

  function stopStreams() {
    for (const stop of stops.splice(0)) stop();
  }

  function setConn(conn, message = "") {
    S.conn = conn;
    S.connError = message;
    emit("conn");
  }

  function fail(e) {
    // 11/16 係 G2: the relay's own 401 for a phone whose login was taken back / ended carries {"device": …}: go to the pairing page,
    // which says so (dsh's own 401, a missing dsh login, goes on to the "log in to dsh" screen as before)
    if (e.status === 401 && /"device"\s*:/.test(String(e.message || ""))) { location.replace("/m/pair.html#expired"); return; }
    if (e.status === 401) return setConn("unauthorized");
    if (e.status === 403) return setConn("forbidden");
    setConn("offline", e.message);
    scheduleRetry();
  }

  function scheduleRetry() {
    if (retry || document.hidden) return;
    retry = setTimeout(() => { retry = null; start(); }, backoff);
    backoff = Math.min(backoff * 2, 15000);
  }

  async function start() {
    const gen = ++generation;
    clearTimeout(retry);
    retry = null;
    stopStreams();
    if (S.conn !== "online") setConn("connecting");
    let list;
    try {
      list = await Api.listSessions();
    } catch (e) {
      if (gen === generation) fail(e);
      return;
    }
    if (gen !== generation) return;
    S.sessions = new Map(list.items.filter(isTop).map((s) => [s.sessionId, s]));
    S.children = new Map(list.items.filter((s) => !isTop(s)).map((s) => [s.sessionId, s]));
    if (!S.catalog) Api.modelCatalog().then((c) => { S.catalog = c; emit("catalog"); }).catch(() => {});
    const onErr = (err) => { if (err.code !== "socket-closed") console.warn("stream error", err); };
    stops.push(Api.mux.open("$events", {}, { item: onEvent, error: onErr }));
    stops.push(Api.mux.open("workspace/follow", {}, { item: onWorkspace, error: onErr }));
    stops.push(Api.mux.open("session/control", {}, { item: onControl, error: onErr }));
    backoff = 1000;
    setConn("online");
    emit("sessions");
    emit("reconnected");
  }

  function onEvent(item) {
    if (item.type === "ready") {
      S.clientId = item.clientId;
      S.pending.clear(); // still-open waterfalls are delivered again to this new client
      emit("pending");
    } else if (item.type === "emit") {
      const [a, b] = item.args || [];
      // 11/2: a subagent's session goes to S.children (10/31 dropped them, so a long conversation whose subagents were
      // started before the loaded part of its history showed none)
      const mapOf = (id) => (S.sessions.has(id) ? S.sessions : S.children.has(id) ? S.children : null);
      if (item.event === "api-session/added") {
        if (a) (isTop(a) ? S.sessions : S.children).set(a.sessionId, a);
        emit("sessions");
      } else if (item.event === "api-session/removed") {
        S.sessions.delete(a);
        // a subagent's session is let go from dsh's memory when it finishes (it stays on disk and in session/list):
        // keep it, as not running
        if (S.children.has(a)) S.children.set(a, { ...S.children.get(a), running: false });
        emit("sessions");
      } else if (item.event === "api-session/status") {
        const m = mapOf(a);
        if (m) m.set(a, { ...m.get(a), running: !!b });
        emit("sessions");
        emit("status", a);
      } else if (item.event === "api-session/activity") {
        const m = mapOf(a);
        if (m) m.set(a, { ...m.get(a), updatedAt: b, blank: false }); // 11/2: a session you wrote to is no longer blank (it stayed hidden in the list until a reload)
        emit("sessions");
      } else if (item.event === "api-session/error") {
        S.errors.set(a, String(b || ""));
        emit("error", a);
      }
    } else if (item.type === "waterfall") {
      if (item.event === "approval/request" || item.event === "user-questions/request") {
        S.pending.set(item.eventId, { event: item.event, agentId: item.agentId, request: item.request });
        emit("pending");
        if (navigator.vibrate) navigator.vibrate(80);
      } else {
        // Anything this page does not show must still be answered, or the agent waits for us.
        Api.settle(S.clientId, item.eventId, { kind: "next" }).catch(() => {});
      }
    } else if (item.type === "cancel") {
      if (S.pending.delete(item.eventId)) emit("pending");
    }
  }

  function onWorkspace(f) {
    if (f.type === "baseline") {
      S.workspaces = [...f.value.items];
      S.workspacesReady = true;
      S.archived = new Set(f.value.archivedSessionIds || []);
      S.pinned = [...(f.value.pinnedSessionIds || [])];
    } else if (f.type === "upsert") {
      const i = S.workspaces.findIndex((w) => w.workspaceId === f.workspace.workspaceId);
      if (i >= 0) S.workspaces[i] = f.workspace;
      else S.workspaces.push(f.workspace);
    } else if (f.type === "remove") {
      removeWorkspace(f.workspaceId);
      return;
    } else if (f.type === "order") {
      const by = new Map(S.workspaces.map((w) => [w.workspaceId, w]));
      S.workspaces = f.workspaceIds.map((id) => by.get(id)).filter(Boolean);
    } else if (f.type === "archived") {
      S.archived = new Set(f.archivedSessionIds);
    } else if (f.type === "pinned") {
      S.pinned = [...f.pinnedSessionIds];
    }
    emit("workspaces");
  }

  function onControl(f) {
    if (f.type === "baseline") {
      S.projections = new Map(Object.entries(f.value.projections || {}).map(([id, p]) => [id, { ...(p.values || {}) }]));
      emit("projections");
    } else if (f.type === "projection") {
      const p = S.projections.get(f.sessionId) || {};
      p[f.key] = f.value;
      S.projections.set(f.sessionId, p);
      emit("projections", f.sessionId);
    }
  }

  // Every second while something moves (Strata reading or writing, a session running, Strata starting or stopping),
  // so the counts beside "考え中" keep up; every 3 s otherwise.
  async function pollStrata() {
    if (!document.hidden) {
      try {
        S.strata = await (await fetch("/m/strata", { cache: "no-store" })).json();
      } catch {
        S.strata = null;
      }
      emit("strata");
    }
    const st = S.strata;
    const moving = (st && st.online && (st.state === "reading" || st.state === "generating"))
      || (st && st.job && !st.job.endedAt) || runningAll().length > 0;
    setTimeout(pollStrata, moving ? 1000 : 3000);
  }

  Api.mux.onDown = () => {
    if (S.conn === "online") setConn("offline", tr("Connection lost"));
    scheduleRetry();
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (S.conn === "offline" || !Api.mux.connected())) start();
  });
  window.addEventListener("online", () => start());

  // --- read helpers used by the views ---
  function title(id) {
    const p = S.projections.get(id);
    const s = S.sessions.get(id);
    const t = (p && p.title) || (s && s.projections && s.projections.values && s.projections.values.title);
    return typeof t === "string" && t.trim() ? t.trim() : tr("New session");
  }

  // --- subagents (11/2) ---
  const valuesOf = (s) => (s && s.projections && s.projections.values) || {};
  // the sessions that run now, the list's and the subagents'
  function runningAll() {
    return [...S.sessions.values(), ...S.children.values()].filter((s) => s.running);
  }
  // a session's own subagents, newest activity first
  function childrenOf(id) {
    return [...S.children.values()].filter((s) => s.parentSessionId === id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  // subagents running under a session, at any depth
  function runningUnder(id) {
    let n = 0;
    for (const c of childrenOf(id)) n += (c.running ? 1 : 0) + runningUnder(c.sessionId);
    return n;
  }
  // a subagent's name: its label (dsh's "subagent" projection, e.g. "build:maze"), else the start of its task
  function subLabel(id) {
    const p = S.projections.get(id) || {};
    const v = valuesOf(S.children.get(id));
    // the list carries it as {mode, label, seq}; a live projection may wrap it as {identity: {...}}
    const one = (x) => (x && (x.identity || x)) || null;
    const ident = one(p.subagent) || one(v.subagent);
    if (ident && typeof ident.label === "string" && ident.label.trim()) return ident.label.trim();
    const t = p.title || v.title;
    return typeof t === "string" && t.trim() ? t.trim().slice(0, 40) : null;
  }
  const isChild = (id) => S.children.has(id);
  // where a session opens: a subagent through its parent (#/s/<parent>/sub/<child>), others by their own id
  function routeOf(id) {
    const c = S.children.get(id);
    return c && c.parentSessionId
      ? `#/s/${encodeURIComponent(c.parentSessionId)}/sub/${encodeURIComponent(id)}`
      : `#/s/${encodeURIComponent(id)}`;
  }

  function workspaceOf(id) {
    return S.workspaces.find((w) => (w.sessionIds || []).includes(id)) || null;
  }

  function workspaceName(w) {
    if (!w) return "";
    if (w.title) return w.title;
    const parts = String(w.path || "").split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || w.path || "";
  }

  function pendingFor(id) {
    return [...S.pending.entries()].filter(([, p]) => p.agentId === id).map(([eventId, p]) => ({ eventId, ...p }));
  }

  function selection(id) {
    const p = S.projections.get(id);
    const ms = p && p.modelSelection;
    return (ms && (ms.next || ms.lastUsed)) || (S.catalog && S.catalog.default) || null;
  }

  function modelInfo(sel) {
    if (!S.catalog || !sel) return null;
    const g = S.catalog.groups.find((x) => x.id === sel.provider);
    return (g && g.models.find((m) => m.id === sel.model)) || null;
  }

  function sortedSessions() {
    return [...S.sessions.values()].filter((s) => !S.archived.has(s.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Sessions that are not archived, split into the pinned ones (in pin order) and the rest (newest first).
  function groupedSessions() {
    const live = sortedSessions().filter((s) => !s.blank);
    const byId = new Map(live.map((s) => [s.sessionId, s]));
    const pinned = S.pinned.map((id) => byId.get(id)).filter(Boolean);
    const pinnedIds = new Set(pinned.map((s) => s.sessionId));
    return { pinned, rest: live.filter((s) => !pinnedIds.has(s.sessionId)) };
  }

  function archivedSessions() {
    return [...S.sessions.values()].filter((s) => S.archived.has(s.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const isPinned = (id) => S.pinned.includes(id);
  const isArchived = (id) => S.archived.has(id);

  // dsh's answers to pin/archive calls carry the whole new set; use them at once instead of waiting for workspace/follow.
  function applyRegistry(value) {
    if (value && value.pinnedSessionIds) S.pinned = [...value.pinnedSessionIds];
    if (value && value.archivedSessionIds) S.archived = new Set(value.archivedSessionIds);
    emit("workspaces");
  }

  function removeWorkspace(id) {
    const remaining = S.workspaces.filter((w) => w.workspaceId !== id);
    if (remaining.length === S.workspaces.length) return;
    S.workspaces = remaining;
    emit("workspaces");
  }

  function setTitle(id, title) {
    const p = S.projections.get(id) || {};
    p.title = title;
    S.projections.set(id, p);
    emit("projections", id);
  }

  return {
    S, start, pollStrata, title, workspaceOf, workspaceName, pendingFor, selection, modelInfo, sortedSessions,
    groupedSessions, archivedSessions, isPinned, isArchived, applyRegistry, removeWorkspace, setTitle,
    runningAll, childrenOf, runningUnder, subLabel, isChild, routeOf,
    on(f) { listeners.add(f); return () => listeners.delete(f); },
  };
})();

// --- small DOM and text helpers shared by the views ---
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    // 11/14: style through the CSSOM, not as an attribute: the page's CSP (no 'unsafe-inline' for styles) refuses style attributes
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return tr("just now");
  if (s < 3600) return tr("{0} min", [Math.floor(s / 60)]);
  if (s < 86400) return tr("{0} h", [Math.floor(s / 3600)]);
  return tr("{0} d", [Math.floor(s / 86400)]);
}

const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" /></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" class="fill" /></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" class="fill" /><circle cx="12" cy="12" r="1.6" class="fill" /><circle cx="12" cy="19" r="1.6" class="fill" /></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>',
  laptop: '<svg viewBox="0 0 24 24"><path d="M5 6h14v9H5zM3 18h18" /></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12" /></svg>',
  tool: '<svg viewBox="0 0 24 24"><path d="M14 6a4 4 0 00-5 5l-5 5 2 2 5-5a4 4 0 005-5l-2 2-2-2z" /></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6" /></svg>',
  archive: '<svg viewBox="0 0 24 24"><path d="M4 5h16v4H4zM5.5 9v9a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V9M10 13h4" /></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 108-8 8 8 0 00-6 2.7M4 4v4h4" /></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M5 19l1-4L16.5 4.5a2 2 0 013 3L9 18zM14.5 6.5l3 3" /></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6" /></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>',
  folderPlus: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM12 10.5v5M9.5 13h5" /></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3.5v8M6.6 6.9a7.5 7.5 0 1010.8 0" /></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4 17l5-5 4 4 2.5-2.5L20 17" /></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 015.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z" /><circle cx="12" cy="13" r="3.5" /></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18" /></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3z" /></svg>',
};
const icon = (name, cls = "") => h("span", { class: `icon ${cls}`, html: ICONS[name] });
