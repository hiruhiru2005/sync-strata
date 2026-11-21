// Talks to dsh web the way its own page does (wire format: ../README.md).
// Unary calls: POST /api/<namespace>/<method> with {type:"client-request", rpcId, method, payload:{args}}.
// Streams: one WebSocket at /api/remote.mux carrying {type:"open"|"cancel", streamId, endpoint, payload} out and
// {type:"item"|"end"|"error", streamId, ...} back. dsh pings every 2 s and drops a socket that misses two pings,
// so a phone that sleeps loses it; the app reopens every stream after a reconnect.
"use strict";

class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

const Api = (() => {
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function call(endpoint, args = {}) {
    let res;
    try {
      res = await fetch(`/api/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ type: "client-request", rpcId: uuid(), method: endpoint, payload: { args } }),
      });
    } catch (e) {
      throw new ApiError("network", String(e.message || e), 0);
    }
    if (!res.ok) throw new ApiError(res.status === 401 ? "unauthorized" : `http-${res.status}`, await res.text(), res.status);
    const env = await res.json();
    const result = env && env.result;
    if (!result || !result.ok) {
      const err = (result && result.error) || {};
      throw new ApiError(err.code || "unknown", err.message || "", 200);
    }
    return result.value;
  }

  // One socket shared by every stream. `onDown` runs once per lost socket so the app can reconnect.
  const mux = {
    ws: null,
    streams: new Map(),
    queue: [],
    onDown: () => {},
    onUp: () => {},

    connected() {
      return this.ws && this.ws.readyState === WebSocket.OPEN;
    },

    connect() {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
      const url = new URL("/api/remote.mux", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        for (const f of this.queue.splice(0)) ws.send(JSON.stringify(f));
        this.onUp();
      };
      ws.onmessage = (m) => {
        let f;
        try { f = JSON.parse(m.data); } catch { return; }
        const s = this.streams.get(f.streamId);
        if (!s) return;
        if (f.type === "item") s.item(f.value);
        else if (f.type === "end") { this.streams.delete(f.streamId); s.end(); }
        else if (f.type === "error") { this.streams.delete(f.streamId); s.error(f.error || {}); }
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.queue = [];
        const dead = [...this.streams.values()];
        this.streams.clear();
        for (const s of dead) s.error({ code: "socket-closed" });
        this.onDown();
      };
    },

    send(frame) {
      if (this.connected()) this.ws.send(JSON.stringify(frame));
      else this.queue.push(frame);
    },

    // handlers: {item(value), end(), error(err)}; returns a function that cancels the stream.
    open(endpoint, args, handlers) {
      const streamId = uuid();
      const s = { item: () => {}, end: () => {}, error: () => {}, ...handlers };
      this.streams.set(streamId, s);
      this.connect();
      this.send({ type: "open", streamId, endpoint, payload: { args } });
      return () => {
        if (!this.streams.delete(streamId)) return;
        this.send({ type: "cancel", streamId });
      };
    },

    close() {
      if (this.ws) this.ws.close();
    },
  };

  return {
    uuid,
    call,
    mux,
    listSessions: () => call("session/list", { _request: {} }),
    createSession: (workspaceId, agentPreset) => call("session/create", { request: { workspaceId, agentPreset } }),
    forkSession: (sessionId, atSeq) => call("session/fork", { request: { sessionId, atSeq } }),
    // parts: 画像 {type:"image", mediaType, data, name} やファイル {type:"file", receiptId}（attach.js）．文字が空でも部品があれば送れる
    prompt: (sessionId, text, mode = "queue", parts = []) =>
      call("session/prompt", {
        request: {
          requestId: uuid(), sessionId, mode,
          content: [...(text ? [{ type: "text", text }] : []), ...parts],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    // 10/30: ファイルを dsh に預ける（中身をそのまま送る道．dsh-client-file-upload と同じ）．返り値 {receiptId, file}
    uploadFile: async (sessionId, file) => {
      let res;
      try {
        res = await fetch(`/api/session/uploadFileBinary?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name || "file")}`, {
          method: "POST", headers: { "content-type": "application/octet-stream" }, credentials: "same-origin", body: file,
        });
      } catch (e) {
        throw new ApiError("network", String(e.message || e), 0);
      }
      if (!res.ok) throw new ApiError(res.status === 401 ? "unauthorized" : `http-${res.status}`, await res.text(), res.status);
      const r = await res.json();
      if (!r || !r.ok) throw new ApiError((r && r.error && r.error.code) || "upload-failed", (r && r.error && r.error.message) || tr("Could not upload the file"), 200);
      return r.value;
    },
    cancel: (sessionId) => call("session/cancel", { request: { sessionId } }),
    updateQueue: (sessionId, itemId, kind) => call("session/updateQueue", { request: { sessionId, itemId, action: { kind } } }),
    page: (address, throughSeq, beforeSeq) =>
      call("session/page", { request: { address, throughSeq, beforeSeq, maxMessages: 40, turnWindow: { minMessages: 20, minTurns: 1 } } }),
    // 10/31: an image the session log refers to (a picture you sent, or one the agent read): {attachment, data: base64}
    attachment: (sessionId, attachmentId) => call("session/attachment", { request: { sessionId, attachmentId } }),
    modelCatalog: () => call("session/modelCatalog", {}),
    selectModel: (sessionId, provider, model, reasoningEffort) =>
      call("session/selectModel", { request: { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }),
    // Waterfalls (approvals, questions) are settled through $events/result with the clientId from the `ready` item.
    settle: (clientId, eventId, outcome) => call("$events/result", { clientId, eventId, outcome }),
    rename: (sessionId, title) => call("session/rename", { request: { sessionId, title } }),
    // 11/10: 権限（dsh の permission presets）．選べるものは permissionPresets/catalog（{options:[{value,name?,description?}]}），
    // 切り替えは dsh の画面と同じく「/permission <名前>」の命令（commands/execute．返り値 undefined はその命令がない）．
    // いまの値は session/control の permissions.currentValue（Store.S.projections）
    permissionCatalog: () => call("permissionPresets/catalog", {}),
    // 11/14: 入力欄のスラッシュ命令（composer.js）も同じ道．添付は session/prompt と同じ形の部品（Attach.parts）を submittedAttachments に．
    // 一覧は commands/list: [{definitionId?, name（先頭の / なしの小文字）, description, input?: {hint, attachments?}}]
    command: (sessionId, line, submittedAttachments = []) => call("commands/execute", { agentId: sessionId, line, submittedAttachments }),
    commands: (sessionId) => call("commands/list", { agentId: sessionId }),
    // Content search over all sessions (at most 20 hits): [{sessionId, snippet}].
    search: (query) => call("session/search", { request: { query } }),
    // Pin and archive state lives in the workspace registry and comes back through workspace/follow.
    pin: (sessionId) => call("workspace/pinSession", { request: { sessionId } }),
    unpin: (sessionId) => call("workspace/unpinSession", { request: { sessionId } }),
    archive: (sessionId, stopActivity = false) =>
      call("workspace/archiveSession", { request: { sessionId, ...(stopActivity ? { stopActivity: true } : {}) } }),
    unarchive: (sessionId) => call("workspace/unarchiveSession", { request: { sessionId } }),
    createWorkspace: (path) => call("workspace/create", { request: { path } }),
    // dsh deletes only the registration, not its directory or sessions.
    removeWorkspace: (workspaceId) => call("workspace/delete", { request: { workspaceId } }),
    renameWorkspace: (workspaceId, title) => call("workspace/rename", { request: { workspaceId, title } }),
  };
})();
