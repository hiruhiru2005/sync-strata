// What the list and the chat can do to a session (pin, archive, rename) and to workspaces (pick, rename, add a
// folder). dsh keeps a session in the workspace of the folder it was created in and has no call that moves it
// to another one, so a workspace can only be chosen when a session is created.
"use strict";

async function setPinned(id, on) {
  try {
    Store.applyRegistry(await (on ? Api.pin(id) : Api.unpin(id)));
    return true;
  } catch (e) {
    toast(errorText(e));
    return false;
  }
}

// A session that still runs something is refused by dsh; after asking, the same call is repeated with stopActivity.
async function setArchived(id, on) {
  try {
    if (!on) {
      Store.applyRegistry(await Api.unarchive(id));
      toast(tr("Restored"));
      return true;
    }
    try {
      Store.applyRegistry(await Api.archive(id));
    } catch (e) {
      if (e.code !== "workspace/session-active") throw e;
      const ok = await confirmSheet({
        title: tr("Stop the running work and archive?"),
        message: tr("This conversation is working now. It will be stopped, then archived."),
        okLabel: tr("Stop and archive"), danger: true,
      });
      if (!ok) return false;
      Store.applyRegistry(await Api.archive(id, true));
    }
    toast(tr("Session archived"));
    return true;
  } catch (e) {
    toast(errorText(e));
    return false;
  }
}

function renameSession(id) {
  const t = Store.title(id);
  openPrompt({
    title: tr("Rename session"), value: t === tr("New session") ? "" : t, placeholder: tr("Session name"),
    onSubmit: async (v) => { const r = await Api.rename(id, v); Store.setTitle(id, r.title); },
  });
}

function sheetItem(iconName, label, fn, cls = "") {
  return h("button", { class: `sheet-item with-icon ${cls}`, type: "button", onclick: fn }, icon(iconName), label);
}

// 11/10: セッションの権限（本人「右上メニューに，セッションの権限変更を追加してほしい」）．dsh の permission presets
// （いまは 閲覧のみ・ワークスペース内で編集・フルアクセス）から選ぶ．いまの値は session/control の permissions.currentValue，
// 切り替えは「/permission <名前>」（dsh の画面の選び方と同じ）．フルアクセスは dsh の画面と同じく一度だけ確かめる
const PERMISSION_NAMES = () => ({
  "read-only": [tr("Read only"), tr("Reads only. Asks before any change")],
  "workspace-write": [tr("Edit in workspace"), tr("Free to change inside the work folder. Asks outside it")],
  "danger-full-access": [tr("Full access"), tr("Runs anything without asking")],
  auto: [tr("Auto review"), tr("An AI checks each action before it runs (experimental)")],
  custom: [tr("Custom"), ""],
});
const permissionOf = (id) => { const p = Store.S.projections.get(id); return (p && p.permissions && p.permissions.currentValue) || null; };
const permissionName = (v, name) => (v && PERMISSION_NAMES()[v] && PERMISSION_NAMES()[v][0]) || name || v || "—";
let permCatalog = null;   // the last catalog read; the sheet opens with it at once and reads it again behind

function permissionItem(id, fn) {
  const b = sheetItem("shield", tr("Change permissions"), fn);
  const v = permissionOf(id);
  if (v) b.append(h("span", { class: "sheet-item-val" }, permissionName(v)));
  return b;
}

async function openPermissionSheet(id) {
  const fresh = Api.permissionCatalog().then((c) => { permCatalog = c; return c; });
  let cat = permCatalog;
  if (!cat) {
    try { cat = await fresh; } catch (e) { toast(errorText(e)); return; }
  } else fresh.catch(() => {});
  const options = (cat && cat.options) || [];
  if (!options.length) { toast(tr("This dsh has no permission choices")); return; }
  const cur = permissionOf(id);
  const pick = async (o) => {
    if (o.value === cur) { s.close(); return; }
    const name = permissionName(o.value, o.name);
    if (o.value === "danger-full-access" || o.value === "auto") {
      s.close(true);
      if (!(await confirmSheet({ title: tr("Switch to {0}?", [name]), okLabel: tr("Switch"), danger: o.value === "danger-full-access" }))) return;
    } else s.close();
    try {
      const r = await Api.command(id, `/permission ${o.value}`);
      if (r === undefined || r === null) throw new Error(tr("dsh has no /permission command"));
      toast(tr("Permissions set to “{0}”", [name]));
    } catch (e) { toast(errorText(e)); }
  };
  const s = openSheet([
    h("div", { class: "msel-head" },
      h("button", { class: "msel-x", type: "button", "aria-label": tr("Close"), html: ICONS.close, onclick: () => s.close() }),
      h("div", { class: "msel-title" }, tr("Choose permissions")),
      h("div", { class: "msel-x-pad" })),
    h("div", { class: "msel-group" }, options.map((o) => {
      const on = o.value === cur;
      const names = PERMISSION_NAMES();
      const note = (names[o.value] && names[o.value][1]) || o.description || "";
      return h("button", { class: `msel-item${on ? " current" : ""}`, type: "button", onclick: () => pick(o) },
        h("div", { class: "msel-text" }, h("div", { class: "msel-name" }, permissionName(o.value, o.name)),
          note ? h("div", { class: "msel-note" }, note) : null),
        on ? h("span", { class: "msel-check", html: ICONS.check }) : null);
    }))]);
}

// The menu behind a card's "…" button, a long press, and the chat's menu. opts.after(kind) runs once an action
// succeeded; opts.extra(close) adds more rows (the chat's reload and stop); opts.footer is a small note at the end.
function openSessionActions(id, opts = {}) {
  const archived = Store.isArchived(id);
  const pinned = Store.isPinned(id);
  const w = Store.workspaceOf(id);
  const run = (fn, kind) => async () => {
    s.close(true);
    if ((await fn()) !== false && opts.after) opts.after(kind);
  };
  const s = openSheet([
    h("div", { class: "sheet-title" }, Store.title(id)),
    w ? h("div", { class: "sheet-note muted" }, `${Store.workspaceName(w)} • ${w.path}`) : null,
    archived ? null : sheetItem("pin", pinned ? tr("Unpin") : tr("Pin"), run(() => setPinned(id, !pinned), pinned ? "unpin" : "pin")),
    sheetItem("edit", tr("Rename"), () => { s.close(true); renameSession(id); }),
    archived
      ? sheetItem("restore", tr("Restore from archive"), run(() => setArchived(id, false), "unarchive"))
      : sheetItem("archive", tr("Archive"), run(() => setArchived(id, true), "archive")),
    opts.extra ? opts.extra((instant) => s.close(instant)) : null,
    opts.footer ? h("div", { class: "sheet-note muted" }, opts.footer) : null,
  ]);
}

// --- workspaces ---

const workspaceRemovals = new Set();

async function confirmWorkspaceRemoval(w) {
  const id = w.workspaceId;
  if (workspaceRemovals.has(id)) return;
  workspaceRemovals.add(id);
  try {
    const ok = await confirmSheet({
      title: tr("Remove workspace {0}?", [Store.workspaceName(w)]),
      message: tr("This removes {0} from the workspace list. The folder, project files, and session logs are kept. Existing sessions remain available outside this workspace, and running work is not stopped.", [w.path]),
      okLabel: tr("Remove workspace"), danger: true,
    });
    if (!ok) return;
    await Api.removeWorkspace(id);
    Store.removeWorkspace(id);
    toast(tr("Workspace removed"));
  } catch (e) {
    toast(errorText(e));
  } finally {
    workspaceRemovals.delete(id);
  }
}

// onPick(workspace | {workspaceId: "all"}) after a row is tapped. includeAll adds the "すべて" row used as a list filter.
function openWorkspaceSheet({ currentId, includeAll = false, title = tr("Workspace"), onPick, onAdded }) {
  const list = h("div", { class: "ws-list" });

  function selectedId() {
    const workspaces = Store.S.workspaces;
    if (workspaces.some((w) => w.workspaceId === currentId)) return currentId;
    return includeAll ? "all" : workspaces[0]?.workspaceId;
  }

  function row(id, name, sub, w) {
    const cur = id === selectedId();
    return h("div", { class: `ws-row${cur ? " current" : ""}` },
      h("button", { class: "ws-main", type: "button", onclick: () => { s.close(); onPick(w || { workspaceId: id }); } },
        h("div", { class: "ws-name" }, name, cur ? icon("check", "small") : null),
        sub ? h("div", { class: "ws-path muted small" }, sub) : null),
      w ? h("button", { class: "icon-btn small", type: "button", "aria-label": tr("Rename"), html: ICONS.edit, onclick: () => renameWorkspace(w) }) : null,
      w ? h("button", { class: "icon-btn small", type: "button", title: tr("Remove workspace"),
        "aria-label": tr("Remove workspace {0}", [name]), html: ICONS.close, onclick: () => confirmWorkspaceRemoval(w) }) : null);
  }

  function render() {
    const rows = [];
    if (includeAll) rows.push(row("all", tr("All workspaces"), "", null));
    for (const w of Store.S.workspaces) rows.push(row(w.workspaceId, Store.workspaceName(w), w.path, w));
    if (!Store.S.workspaces.length) rows.push(h("div", { class: "empty muted small" }, tr("No workspaces. Add a folder.")));
    list.replaceChildren(...rows);
  }

  function renameWorkspace(w) {
    openPrompt({
      title: tr("Rename workspace"), value: Store.workspaceName(w), placeholder: tr("Workspace name"),
      note: tr("The PC's dsh page shows the new name too."),
      onSubmit: async (v) => { await Api.renameWorkspace(w.workspaceId, v); },
    });
  }

  const off = Store.on((topic) => { if (topic === "workspaces") render(); });
  const s = openSheet([
    h("div", { class: "sheet-title" }, title),
    list,
    sheetItem("folderPlus", tr("Add a folder…"), () => { s.close(true); openAddWorkspace({ onAdded }); }),
  ], { onClose: off });
  render();
}

// dsh composes its folder browser only for remote setups; on this PC it offers a native dialog that opens on the
// PC's own screen, which a phone cannot use. So the folder is typed as a path and dsh checks that it exists.
function openAddWorkspace({ onAdded }) {
  openPrompt({
    title: tr("Add a folder"), placeholder: tr("e.g. {0}", [DSH_CONFIG.workspacePathExample]), okLabel: tr("Add"),
    note: tr("Type the path of a folder on this PC. It becomes a workspace, and work happens there."),
    onSubmit: async (v) => {
      const r = await Api.createWorkspace(v.replace(/^["']+|["']+$/g, "").trim());
      toast(r.created ? tr("Added as a workspace") : tr("This folder is already registered"));
      if (onAdded) onAdded(r.workspace);
    },
  });
}