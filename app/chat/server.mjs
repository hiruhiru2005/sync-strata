// Pack copy (11/15 S2): made by s2/make_chat_pack.py from the relay server.mjs; only the author's-PC defaults are emptied.
// Phone UI for DeepSeek Harness (2026-10-21).
// Serves the page under /m/ and passes every other request, WebSockets included, through to dsh web unchanged.
// Cloudflare Tunnel -> 127.0.0.1:3081 (this) -> 127.0.0.1:3080 (dsh web). The Host header is passed as is,
// so dsh's own checks (trusted host, Origin, the auth cookie) still decide every /api call; this server adds none.
// /m/strata answers with a few fields of Strata's /metrics so the page can show what the model is doing, and
// /m/strata/requests with the speed of each finished request (kept in strata-requests.jsonl, see below).
// POST /m/strata/start and /m/strata/stop start and stop Strata on this PC; they are the only calls here that change
// anything, so they ask dsh whether the caller is logged in (dshLoggedIn) before doing it.
// 11/15: the Strata sheet also lists the models of models/models.json, downloads one (models/model_dl.py in its own Python
// process) and starts or switches to the one picked (POST /m/strata/start?model=<id>&r=4..7&restart=1); see "--- models".
// Usage: node server.mjs   (env: DSH_MOBILE_PORT=3081, DSH_PORT=3080, STRATA_URL=http://127.0.0.1:8080,
//                           STRATA_START=<.ps1>, STRATA_STOP=<.ps1>, UNITY_BUSY=<.json>,
//                           DSH_MOBILE_ALLOWED_HOSTS=<public name>[,<more>])
//
// 11/14 (stage 1 of release/security/PLAN.md): this server now has a gate of its own in front of everything:
//  - Host fence: only the loopback names (127.0.0.1, localhost, [::1], any port) and the public names given in
//    DSH_MOBILE_ALLOWED_HOSTS (or, when that is unset, allowed-hosts.txt beside this file) are served; any other Host
//    gets 421, WebSocket upgrades included. With neither set only loopback is served (said once at start).
//  - A request that changes something (any method but GET/HEAD) and every WebSocket upgrade must carry an Origin of
//    this same host and no Sec-Fetch-Site other than same-origin; otherwise 403.
//  - /m/strata and /m/strata/requests need a dsh login, asked of dsh the same way as for start/stop (dshCookieOk).
//  - Protective headers on every answer: CSP (strict for the phone page, frame-ancestors only for dsh's own answers
//    and the aurora pages), nosniff, Referrer-Policy no-referrer, X-Frame-Options.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const Remote = await import("./remote.mjs").catch((e) => { if (e.code !== "ERR_MODULE_NOT_FOUND") console.log(`dsh mobile: remote.mjs を読めません（${e.message}）`); return null; });   // 11/15 係 R: スマホの接続

const PORT = Number(process.env.DSH_MOBILE_PORT || 3081);
const DSH = { host: "127.0.0.1", port: Number(process.env.DSH_PORT || 3080) };
const STRATA = process.env.STRATA_URL || "http://127.0.0.1:8080";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 11/15: the page's folder and where this server keeps its logs can be moved (DSH_MOBILE_PUBLIC, DSH_MOBILE_STATE_DIR),
// so a copy can be tried beside the real one without touching its files. Unset = as before (public/ and this folder).
const PUBLIC = process.env.DSH_MOBILE_PUBLIC || path.join(HERE, "public");
const STATE_DIR = process.env.DSH_MOBILE_STATE_DIR || HERE;
// 11/15: the models the Strata sheet lists, downloads and starts (models/models.json; see "--- models" below)
const MODELS_CATALOG = process.env.DSH_MODELS_CATALOG || path.join(HERE, "models", "models.json");
const MODELS_STATE = process.env.DSH_MODELS_STATE || path.join(HERE, "models", "state");
const MODELS_DL = process.env.DSH_MODELS_DL || path.join(HERE, "models", "model_dl.py");
const MODELS_HF_ENDPOINT = process.env.DSH_MODELS_HF_ENDPOINT || ""; // only to try it against a stand-in Hugging Face
// 11/15 係 C: the Hugging Face token of this app (SYNC_HOME\hf as HF_HOME). Only for a relay the launcher started; otherwise none.
const HF_APP_HOME = process.env.SYNC_HOME ? path.join(process.env.SYNC_HOME, "hf") : null;
// 11/15 app1115: when the launcher (tools\night\launcher\sync.py) started this relay, it says where it is (SYNC_LAUNCHER, and its
// Python in SYNC_PYTHON); starting, switching and stopping Strata then go through it (sync.py up/down), and so do the settings
// (/m/settings) and "stop everything" (/m/shutdown). STRATA_CONTROL=ps1 keeps the old way (start-strata-full.ps1 with a fixed
// settings file), which is also what a relay started without SYNC_LAUNCHER (this PC's everyday one) does.
const LAUNCHER = process.env.STRATA_CONTROL === "ps1" ? null : process.env.SYNC_LAUNCHER || null;
const SYNC_PY = process.env.SYNC_PYTHON || "python";
const STRATA_START = process.env.STRATA_START || ""; // pack copy: no start script in the app (the launcher, SYNC_LAUNCHER, starts Strata)
const STRATA_STOP = process.env.STRATA_STOP || ""; // pack copy: likewise
// 11/9: the start buttons choose one of two settings, as the page asks (POST /m/strata/start?preset=syncm|syncs), with
// the same room for the other apps as the PC's shortcut: Sync-M (the usual one, higher quality) or Sync-S (faster decode,
// lower quality); both with tail skip from 11/9 night. Both read pictures (the reader starts when a picture comes), so there is
// no picture choice any more (10/30-11/9: ?mode=text|vision; an old page's request now starts Sync-M).
const STRATA_CONFIGS = {
  syncm: process.env.STRATA_CONFIG_SYNCM || "",
  syncs: process.env.STRATA_CONFIG_SYNCS || "",
};
const STRATA_OTHERS_GIB = Number(process.env.STRATA_TARGET_OTHERS_GIB || 3);
const UNITY_BUSY = process.env.UNITY_BUSY || ""; // pack copy: no Unity sessions to announce
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

// --- 11/14: the gate (Host fence, Origin, protective headers) ---
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// The public names (the tunnel's name and any other a phone really uses) come from the environment or a file, never
// from this code: "a.example.net, b.example.net:8443" or one per line in allowed-hosts.txt (# starts a comment).
// A name without a port matches a Host without a port (what a browser sends for https on 443).
function readAllowedHosts() {
  let raw = process.env.DSH_MOBILE_ALLOWED_HOSTS;
  let from = "DSH_MOBILE_ALLOWED_HOSTS";
  if (raw == null) {
    from = "allowed-hosts.txt";
    try { raw = fs.readFileSync(path.join(HERE, "allowed-hosts.txt"), "utf8"); } catch { raw = ""; from = null; }
  }
  const names = new Set();
  for (const line of raw.split(/\r?\n/)) {
    for (let w of line.replace(/#.*$/, "").split(/[\s,]+/)) {
      w = w.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (!w) continue;
      if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(w)) names.add(w);
      else console.log(`dsh mobile: ${from} の「${w}」は名前の形でないので使いません`);
    }
  }
  return { names, from };
}
const ALLOWED = readAllowedHosts();

function hostAllowed(host) {
  if (!host) return false;
  host = String(host).toLowerCase();
  if (ALLOWED.names.has(host)) return true;
  const m = host.match(/^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::\d{1,5})?$/);
  return !!m && LOOPBACK.has(m[1]);
}

// null when the request may change something; otherwise why not. Browsers send Origin with every POST/PUT/DELETE
// and every WebSocket, so a missing one is refused too (11/14: before, a missing Origin passed).
function crossSiteReason(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return `Sec-Fetch-Site: ${site}`;
  const origin = req.headers.origin;
  if (!origin) return "no Origin";
  let u;
  try { u = new URL(origin); } catch { return "bad Origin"; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.host !== String(req.headers.host || "").toLowerCase()) return "Origin of another site";
  return null;
}

// The phone page: own scripts and styles only (no inline script; inline style attributes are not needed since
// store.js h() sets style through the CSSOM), images also from data: (the background photo in app.css) and blob:
// (pictures in a conversation), fetch and the WebSocket to this host only. ws/wss are named as well as 'self' because
// older Safari did not count them as 'self'. The host is one the fence let in, so it is safe to write here.
function pageCsp(host) {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "font-src 'self'",
    `connect-src 'self' wss://${host} ws://${host}`, "media-src 'self' blob:", "manifest-src 'self'", "worker-src 'self'",
    "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join("; ");
}
// The aurora pages (a game kept on this origin until the owner decides where it goes) are one big page of inline
// scripts; a script policy would stop it, so they only get the frame and base rules.
const AURORA_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
// dsh's own answers (its PC page, /api, /plugins): its page may frame its own pages, so 'self' here, and the policy
// is added beside whatever dsh sends (two policies both apply), never instead of it.
const DSH_CSP = "frame-ancestors 'self'";
const RELAY_JSON_CSP = "default-src 'none'; frame-ancestors 'none'";

function setBaseHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function refuse(req, res, code, message) {
  logAccess(req, res);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-security-policy": RELAY_JSON_CSP, "x-frame-options": "DENY" });
  res.end(JSON.stringify({ ok: false, error: message }));
}

function sendJson(res, body, code = 200) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-security-policy": RELAY_JSON_CSP, "x-frame-options": "DENY" });
  res.end(JSON.stringify(body));
}

// The page's version: the newest modification time in public/. index.html carries it (meta tag and ?v= on every
// script and style URL), and /m/version reports the current one, so a phone that kept an old page can tell and reload.
function version() {  // pack copy: the version stamped at build time (version.json beside this file) comes first
  try { const v = JSON.parse(fs.readFileSync(path.join(HERE, "version.json"), "utf8")).version_ms; if (v) return String(v); } catch { /* none: from the files */ }
  let newest = 0;
  for (const f of fs.readdirSync(PUBLIC)) {
    try { newest = Math.max(newest, fs.statSync(path.join(PUBLIC, f)).mtimeMs); } catch { /* removed meanwhile */ }
  }
  return String(Math.round(newest));
}

// Only flat file names inside public/, so no path can climb out of it.
// no-store, not just no-cache: a phone browser or a CDN in between must never keep an older copy of these files.
// 11/14: the bundled font (public/*.ttf, 2.3 MB) is the exception: it never changes under the same name, and fetching it
// on every page load over the tunnel would be slow, so the phone may keep it for 30 days (private: not a CDN in between).
function serveStatic(req, res, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return notFound(res);
  const file = path.join(PUBLIC, name);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(name);
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".ttf" ? "private, max-age=2592000, immutable" : "no-store",
      "content-security-policy": name.startsWith("aurora") ? AURORA_CSP : pageCsp(String(req.headers.host).toLowerCase()),
      "x-frame-options": "DENY",
      ...(ext === ".html" && !name.startsWith("aurora") ? { "cross-origin-opener-policy": "same-origin" } : {}),
    });
    res.end(name === "index.html" ? data.toString("utf8").replaceAll("__V__", version()) : data);
  });
}

// One line per request for the page itself (not the dsh traffic, nor the polling), to see what a phone really fetched.
const ACCESS_LOG = path.join(STATE_DIR, "access.log");
// 10/31: a dsh token opened as /m/?token=... was written here in plain text; keep the name, hide the value.
const hideSecrets = (u) => String(u).replace(/([?&](?:token|access_token|auth)=)[^&#]*/gi, "$1***");
function logAccess(req, res) {
  res.on("finish", () => {
    const line = `${new Date().toISOString()} ${req.method} ${hideSecrets(req.url)} ${res.statusCode} ${(req.headers["user-agent"] || "").slice(0, 70)}\n`;
    fs.appendFile(ACCESS_LOG, line, () => {});
  });
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "content-security-policy": RELAY_JSON_CSP, "x-frame-options": "DENY" });
  res.end("not found");
}

// --- Strata's state and the speed of each request ---
// Strata's /metrics carries `live` (what it is doing now: state, phase "thinking"/"answering", tokens generated so far)
// and `requests` (its last 12 finished requests; ?requests=all gives the 500 it keeps). It keeps them in memory only,
// so every request seen is also written to strata-requests.jsonl: a message's speed can still be shown after Strata
// restarts. The page matches a message to its request by the output tokens and the time it ended.
const REQ_LOG = path.join(STATE_DIR, "strata-requests.jsonl");
const reqs = new Map(); // Strata's request id -> row, oldest first
let snapshot = { online: false };
let wasOnline = false;
let lastAsked = 0;

function loadRequests() {
  let text = "";
  try { text = fs.readFileSync(REQ_LOG, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    try { const r = JSON.parse(line); if (r && r.id) reqs.set(r.id, r); } catch { /* a cut-off last line */ }
  }
  // keep the file from growing for ever: the newest 20000 (a few weeks of work)
  if (reqs.size > 20000) {
    const keep = [...reqs.values()].slice(-20000);
    reqs.clear();
    for (const r of keep) reqs.set(r.id, r);
    fs.writeFileSync(REQ_LOG, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

function recordRequests(list) {
  let lines = "";
  for (const q of list || []) {
    if (!q || !q.id || reqs.has(q.id) || q.time == null) continue;
    const row = {
      id: q.id, end: Math.round((q.time + (q.duration_s || 0)) * 1000), out: q.output_tokens ?? null,
      tps: q.decode_tok_s ?? null, first: q.first_engine_token_s ?? null, dur: q.duration_s ?? null,
      prompt: q.prompt_tokens ?? null, reused: q.reused ?? null, finish: q.finish ?? null,
      // 10/31: the prompt tokens actually read (not reused) and the time they took, for the prefill speed on the page
      read: q.prompt_read ?? null, pms: q.prompt_ms ?? null,
    };
    reqs.set(row.id, row);
    lines += JSON.stringify(row) + "\n";
  }
  if (lines) fs.appendFile(REQ_LOG, lines, () => {});
}

// 11/17 係 W6: the engine's GET /v1/status says "restart_note": "seat_short" when it died in a chat and could not start again with
// enough GPU memory (or only started slow). The page then suggests a lighter model. Read every 5 s (and whenever /metrics fails,
// as the server can answer while the engine is down); null = nothing to say, or an older engine without the field.
let restartNote = null;
let noteAt = 0;
async function pollRestartNote() {
  if (Date.now() - noteAt < 5000) return;
  noteAt = Date.now();
  try {
    const r = await fetch(`${STRATA}/v1/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) { restartNote = null; return; }
    const j = await r.json();
    restartNote = typeof j.restart_note === "string" ? j.restart_note : null;
  } catch { restartNote = null; }
}

async function pollStrata() {
  pollRestartNote();
  try {
    const all = !wasOnline; // just came up (or this server just started): take every request it still keeps
    const r = await fetch(`${STRATA}/metrics${all ? "?requests=all" : ""}`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`metrics ${r.status}`);
    const m = await r.json();
    const live = m.live || {};
    snapshot = {
      online: true, state: live.state, phase: live.phase, tok_s: live.tok_s, generated: live.generated,
      max_tokens: live.max_tokens, prompt_read: live.prompt_read, prompt_total: live.prompt_total,
      images: !!(m.engine && m.engine.images), model: (m.engine && m.engine.model) || null, at: Date.now(),
    };
    recordRequests(m.requests);
    wasOnline = true;
  } catch {
    snapshot = { online: false, at: Date.now() };
    wasOnline = false;
  }
}

// Every second while a page is looking (it asks every 1-3 s), every 15 s otherwise: often enough to see each request,
// since Strata's answer lists the last 12.
async function strataLoop() {
  await pollStrata();
  setTimeout(strataLoop, Date.now() - lastAsked < 30000 ? 1000 : 15000);
}

function strataStatus(res) {
  lastAsked = Date.now();
  sendJson(res, { ...snapshot, restart_note: restartNote, job: jobView() });
}

// ?from=&to= (ms): the rows that ended in that window, at most 3000.
function strataRequests(res, url) {
  const from = Number(url.searchParams.get("from")) || 0;
  const to = Number(url.searchParams.get("to")) || Date.now() + 60000;
  const items = [...reqs.values()].filter((r) => r.end >= from && r.end <= to).slice(-3000);
  sendJson(res, { items });
}

// --- starting and stopping Strata ---
// Start runs the start script STRATA_START (push the other programs out to the pagefile, start Strata in its own
// minimized window, wait until it answers, report whether every expert fits in RAM); its output goes to a log the page
// shows. Stop runs stop-strata.ps1 (ends the server that listens on 8080, and with it the engine).
let job = null; // {kind, startedAt, endedAt, code, log}
let startsPending = 0;
let shuttingDown = false;
let updateApplying = false;

function jobView() {
  if (!job) return null;
  if (job.endedAt && Date.now() - job.endedAt > 10 * 60000) return null;
  let tail = [];
  try { tail = fs.readFileSync(job.log, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).slice(-12); } catch { /* not yet */ }
  return { kind: job.kind, mode: job.mode || null, model: job.model || null, r: job.r ?? null, restart: !!job.restart,
    startedAt: job.startedAt, endedAt: job.endedAt || null, code: job.code ?? null, tail };
}

// Not detached: Windows PowerShell started detached (without a console) exits at once without running anything
// (tried 2026-10-22). Processes started this way outlive this server anyway (tried the same day: a child and the
// program it started both kept running after node exited), so restarting the relay does not stop a Strata start.
// PowerShell itself writes every line the script prints (all streams) to the log, as UTF-8.
// 11/15: steps = [[script, extra], ...] run one after another in the same PowerShell, stopping at the first that fails
// (switching models = stop, then start). A single script with its extra still works as before.
// 11/17 W1 (I-7): on Windows the steps still run in one PowerShell as before. Elsewhere (Linux) there is no PowerShell: each
// step is the launcher's Python started directly, one after another, stopping at the first that fails. A step is
// [script, extra] (a .ps1 and its argument text, Windows only) or {exe, args: [..]} (a program and its arguments).
// job-cmd-begin
const IS_WIN = process.platform === "win32";
const step = (exe, args) => ({ exe, args });
const launcherArgs = (...a) => ["-X", "utf8", LAUNCHER, ...a];
// start (up, after a down of the running engine when restart) and stop through the launcher: the command lines
function startSteps(restart, m, r) {
  const up = launcherArgs("up", "--gui", ...(m ? ["--model", m.id] : []), ...(r ? ["--tail-skip", String(r)] : []));
  return restart ? [step(SYNC_PY, launcherArgs("down", "--engine")), step(SYNC_PY, up)] : [step(SYNC_PY, up)];
}
const stopSteps = () => [step(SYNC_PY, launcherArgs("down", "--engine"))];
// PowerShell text of an argument: the launcher's path always quoted, plain words as they are, the rest quoted
const psArg = (a) => (a === LAUNCHER || !/^[A-Za-z0-9_.\-]+$/.test(String(a)) ? psQuote(a) : String(a));
function jobPlan(steps, log, platform, powershell) {
  if (platform === "win32") {
    const add = `*>&1 | ForEach-Object { Add-Content -LiteralPath '${log}' -Encoding UTF8 -Value ('' + $_) }`;
    const body = steps.map((s) => (Array.isArray(s)
      ? `& '${s[0]}' ${s[1] || ""} ${add}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`
      : `& '${s.exe}' ${s.args.map(psArg).join(" ")} ${add}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`)).join("; ");
    // 11/15 app1115: read what programs print as UTF-8 (the launcher prints Japanese; the console's code page would garble it)
    return { via: "powershell", file: powershell, args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${body}; exit 0`] };
  }
  if (steps.some((s) => Array.isArray(s))) throw new Error("この PC では PowerShell の手順は使えません");
  return { via: "direct", steps: steps.map((s) => ({ file: s.exe, args: s.args })) };
}
// job-cmd-end
function runJob(kind, script, extra = "", mode = null, more = {}) {
  const log = path.join(STATE_DIR, `strata-${kind}.log`);
  fs.writeFileSync(log, "");
  const steps = Array.isArray(script) ? script : [[script, extra]];
  const j = { kind, startedAt: Date.now(), log, mode, ...more };
  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  let plan;
  try { plan = jobPlan(steps, log, process.platform, POWERSHELL); } catch (e) {
    j.endedAt = Date.now(); j.code = -1; fs.appendFileSync(log, `${e.message}
`); job = j; return;
  }
  job = j;
  const fail = (e) => { j.endedAt = Date.now(); j.code = -1; fs.appendFile(log, `${e.message}
`, () => {}); };
  if (plan.via === "powershell") {
    const child = spawn(plan.file, plan.args, { stdio: "ignore", windowsHide: true, env });
    child.on("exit", (code) => { j.endedAt = Date.now(); j.code = code; });
    child.on("error", fail);
    child.unref();
    return;
  }
  // Linux: the programs write to the log themselves (stdout and stderr to the same file). Detached, so a Strata start does not
  // end with this relay.
  let fd;
  try { fd = fs.openSync(log, "a"); } catch (e) { fail(e); return; }
  let i = 0;
  let over = false;
  const finish = (code, err) => {
    if (over) return;
    over = true;
    try { fs.closeSync(fd); } catch { /* closed */ }
    if (err) fail(err); else { j.endedAt = Date.now(); j.code = code; }
  };
  const next = () => {
    if (i >= plan.steps.length) return finish(0);
    const s = plan.steps[i++];
    let child;
    try { child = spawn(s.file, s.args, { stdio: ["ignore", fd, fd], detached: true, env }); } catch (e) { return finish(-1, e); }
    child.on("error", (e) => finish(-1, e));
    child.on("exit", (code) => { if (code) finish(code); else next(); });
    child.unref();
  };
  next();
}

// What could make starting Strata a bad idea right now: Unity running (Strata takes ~23 GiB of RAM at start and
// pushes everything else out to the pagefile, which makes a Unity build crawl), and the Unity work other Claude
// sessions have announced (unity-busy.json, written by the session that receives their messages).
function unityGuard() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq Unity.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const running = !err && /"Unity\.exe"/i.test(stdout || "");
      let announced = [];
      try { announced = JSON.parse(fs.readFileSync(UNITY_BUSY, "utf8")).sessions || []; } catch { /* none */ }
      resolve({ unityRunning: running, announced });
    });
  });
}

// The start and stop calls change this PC, so the caller must be logged in to dsh: dsh is asked about its own index
// page with the caller's Host and Cookie (200 only for a valid login cookie). They must also be POSTs carrying the
// x-dsh-mobile header, which another site's page cannot send without a preflight this server never answers.
function dshLoggedIn(req) {
  if (req.method !== "POST" || req.headers["x-dsh-mobile"] !== "1") return Promise.resolve(false);
  // 11/14: the gate already refused a missing or foreign Origin; this stays as a second look
  if (crossSiteReason(req)) return Promise.resolve(false);
  return dshCookieOk(req, true);
}

// 11/14: is the caller logged in to dsh? Asked of dsh's index page with the caller's Host and Cookie (200 only for a
// valid login cookie), as start/stop always did. /m/strata is polled every 1-3 s, so a yes is kept for 30 s per
// Host+Cookie (only a hash of them is kept); start/stop (fresh) always ask again.
const loginSeen = new Map(); // sha256(host, cookie) -> until (ms)
function dshCookieOk(req, fresh = false) {
  const cookie = req.headers.cookie || "";
  if (!cookie) return Promise.resolve(false);
  const key = crypto.createHash("sha256").update(`${req.headers.host || ""}\0${cookie}`).digest("hex");
  if (!fresh && (loginSeen.get(key) || 0) > Date.now()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const q = http.request({ ...DSH, method: "GET", path: "/", headers: { host: req.headers.host || "", cookie } }, (r) => {
      r.resume();
      const ok = r.statusCode === 200;
      if (ok) {
        if (loginSeen.size > 200) loginSeen.clear();
        loginSeen.set(key, Date.now() + 30000);
      } else loginSeen.delete(key);
      resolve(ok);
    });
    q.on("error", () => resolve(false));
    q.setTimeout(5000, () => q.destroy());
    q.end();
  });
}

async function strataControl(req, res, action) {
  if (!(await dshLoggedIn(req))) return sendJson(res, { ok: false, error: "dsh にログインしていません" }, 403);
  const busy = job && !job.endedAt;
  if (action === "guard") return sendJson(res, { ok: true, ...(await unityGuard()) });
  if (busy) return sendJson(res, { ok: false, error: job.kind === "start" ? "起動の途中です" : "終了の途中です" });
  if (action === "start") {
    if (modelDirectoryBlocked()) return sendJson(res, { ok: false, error: modelDirectoryRestart }, 409);
    // 11/15: ?model=<id in models.json>&r=4..7 (tail skip of this start; none = the model's own setting) and restart=1
    // (when Strata runs: stop it, then start the chosen one, in one job). The 11/9 ?preset=syncm|syncs still works.
    const q = new URL(req.url, "http://x").searchParams;
    const cat = readCatalog();
    const legacy = q.get("preset") === "syncs" ? "syncs" : "syncm";
    let m = null;
    if (q.get("model")) {
      m = modelById(cat, q.get("model"));
      if (!m) return sendJson(res, { ok: false, error: "一覧にないモデルです" });
    } else {
      m = (cat.models || []).find((x) => x.preset === legacy) || null;
    }
    let r = null;
    if (q.get("r") != null && q.get("r") !== "") {
      r = Number(q.get("r"));
      // 11/15 本人: 選べるのは R4・R7・R10（R10＝省かない．エンジンへは 0）．R5・R6 は前の画面のために受ける
      if (![4, 5, 6, 7, 10].includes(r)) return sendJson(res, { ok: false, error: "tail skip は 4・7・10 です" });
    }
    const restart = q.get("restart") === "1";
    startsPending++;
    try { await pollStrata(); } finally { startsPending--; }
    if (job && !job.endedAt) return sendJson(res, { ok: false, error: "起動か終了の途中です" });
    if (snapshot.online && !restart) return sendJson(res, { ok: false, error: "Strata はもう動いています" });
    if (LAUNCHER) {
      // 11/15 app1115: the launcher decides the rest (settings.json, then this model and quality/speed; auto = it looks at the PC)
      if (m) {
        const d = dlStatus(m.id);
        if (d && DL_ACTIVE.has(d.state)) return sendJson(res, { ok: false, error: `${m.name} はダウンロードか検査の途中です` });
        if (!localState(m).complete) return sendJson(res, { ok: false, error: `${m.name} は手元にありません（先にダウンロード）` });
      }
      const miss = sharedState(readCatalog()).filter((x) => !x.optional && !x.local.complete).map((x) => x.name);
      if (miss.length) return sendJson(res, { ok: false, error: `起動に要る共通の部品がありません: ${miss.join(", ")}` });
      const mode = m ? m.preset || m.id : legacy;
      runJob("start", startSteps(snapshot.online, m, r), "", mode, { model: m ? m.id : null, r, restart: snapshot.online });
      return sendJson(res, { ok: true, mode, model: m ? m.id : null, r, restart: snapshot.online, via: "launcher" });
    }
    let cfg = STRATA_CONFIGS[legacy];
    if (m) {
      const d = dlStatus(m.id);
      if (d && DL_ACTIVE.has(d.state)) return sendJson(res, { ok: false, error: `${m.name} はダウンロードか検査の途中です` });
      const loc = localState(m);
      if (!loc.complete) return sendJson(res, { ok: false, error: `${m.name} は手元にありません（先にダウンロード）` });
      const miss = sharedMissing(m);
      if (miss.length) return sendJson(res, { ok: false, error: `起動に要るファイルがありません: ${miss.join(", ")}` });
      // an environment override of the 11/9 settings still wins for those two
      const envCfg = m.preset === "syncm" ? process.env.STRATA_CONFIG_SYNCM : m.preset === "syncs" ? process.env.STRATA_CONFIG_SYNCS : null;
      try { cfg = configFor(m, r, envCfg || m.start_config); } catch (e) { return sendJson(res, { ok: false, error: `起動の設定を作れませんでした: ${e.message}` }); }
      saveChoice({ model: m.id, r });
    }
    const start = [STRATA_START, `-Config ${psQuote(cfg)} -TargetOthersGiB ${STRATA_OTHERS_GIB}`];
    const steps = snapshot.online ? [[STRATA_STOP, ""], start] : [start];
    const mode = m ? m.preset || m.id : legacy;
    runJob("start", steps, "", mode, { model: m ? m.id : null, r, restart: snapshot.online });
    return sendJson(res, { ok: true, mode, model: m ? m.id : null, r, restart: snapshot.online });
  }
  if (LAUNCHER) runJob("stop", stopSteps());
  else runJob("stop", STRATA_STOP);
  return sendJson(res, { ok: true });
}

// --- 11/15 app1115: the start settings (/m/settings) and "stop everything" (/m/shutdown), through the launcher ---
function launcher(args, timeout = 20000) {
  return new Promise((resolve) => execFile(SYNC_PY, ["-X", "utf8", LAUNCHER, ...args], { windowsHide: true, timeout, encoding: "utf8" },
    (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(out || ""), err: String(errOut || "") })));
}

function readBody(req, max = 16384) {
  return new Promise((resolve) => {
    let n = 0;
    const parts = [];
    req.on("data", (c) => { n += c.length; if (n <= max) parts.push(c); });
    req.on("end", () => resolve(n > max ? null : Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

let savingSettings = false;
let changingModelDirectory = false;
let modelDirectoryChanged = false;
const modelDirectoryRestart = "Stop everything and reopen Sync-Strata to use the new model directory.";
const modelDirectoryBlocked = () => changingModelDirectory || modelDirectoryChanged;

async function settingsRoute(req, res) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません（設定は sync settings で）" }, 404);
  if (req.method === "GET") {
    if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  } else if (!(await dshLoggedIn(req))) return sendJson(res, { ok: false, error: "dsh にログインしていません" }, 403);
  logAccess(req, res);
  if (req.method === "POST") {
    let body = null;
    try { body = JSON.parse((await readBody(req)) || "null"); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, { ok: false, error: "{名前: 値} の形で送ってください" }, 400);
    const entries = Object.entries(body);
    const changesDirectory = Object.hasOwn(body, "models_dir");
    const local = localStorageSettings(req);
    if (!local && entries.some(([k]) => ["models_dir", "sessions_dir", "dsh_home"].includes(k)))
      return sendJson(res, { ok: false, error: "Storage paths can only be changed on this PC." }, 403);
    for (const [k, v] of entries) {
      if (!/^[a-z_]{2,32}$/.test(k) || (typeof v !== "string" && typeof v !== "number")) return sendJson(res, { ok: false, error: `${k} の値が読めません` }, 400);
    }
    if (savingSettings) return sendJson(res, { ok: false, error: "Another setting is being saved. Try again." }, 409);
    if (changesDirectory && (entries.length !== 1 || typeof body.models_dir !== "string" || !body.models_dir.trim()))
      return sendJson(res, { ok: false, error: "Send the model directory separately as an absolute path or auto." }, 400);
    if (changesDirectory && modelDeleteBusy(readCatalog()))
      return sendJson(res, { ok: false, error: "Finish or cancel all model downloads and checks, and wait for any start or stop to finish before changing the model directory." }, 409);
    savingSettings = true;
    changingModelDirectory = changesDirectory;
    try {
      if (changesDirectory) {
        const before = await launcher(["settings", "get", "--json"]);
        if (!lastJsonLine(before.out)?.models_directory?.configurable)
          return sendJson(res, { ok: false, error: "This installation uses a fixed model catalog." }, 409);
      }
      for (const [k, v] of entries) {
        const r = await launcher(["settings", "set", k, String(v), "--json"]);
        if (r.code !== 0) return sendJson(res, { ok: false, error: (r.err || r.out).trim() || `${k} を変えられませんでした` });
        if (changesDirectory && lastJsonLine(r.out)?.path_changed !== false) modelDirectoryChanged = true;
      }
      return await sendSettings(req, res);
    } finally {
      savingSettings = changingModelDirectory = false;
    }
  }
  return sendSettings(req, res);
}

function localStorageSettings(req) {
  return Remote?.isLocal(req) && !Object.keys(req.headers).some((k) => k === "forwarded" || k.startsWith("x-forwarded-"));
}

async function sendSettings(req, res) {
  const r = await launcher(["settings", "get", "--json"]);
  try {
    const data = JSON.parse(r.out);
    if (!localStorageSettings(req)) delete data.models_directory;
    return sendJson(res, { ok: true, ...data });
  } catch { return sendJson(res, { ok: false, error: (r.err || "設定を読めませんでした").trim() }); }
}

async function shutdownRoute(req, res, url) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
  if (!(await dshLoggedIn(req))) return sendJson(res, { ok: false, error: "dsh にログインしていません" }, 403);
  logAccess(req, res);
  const what = url.searchParams.get("what") === "all" ? "all" : "engine";
  if (changingModelDirectory) return sendJson(res, { ok: false, error: "Wait for the model directory to finish saving." }, 409);
  if (what === "engine") {
    if (job && !job.endedAt) return sendJson(res, { ok: false, error: "起動か終了の途中です" });
    runJob("stop", stopSteps());
    return sendJson(res, { ok: true, what });
  }
  // everything, this relay included: answer first, then start the launcher on its own (it outlives this process)
  shuttingDown = true;
  sendJson(res, { ok: true, what });
  setTimeout(() => {
    const c = spawn(SYNC_PY, ["-X", "utf8", LAUNCHER, "down", "--all"], { stdio: "ignore", windowsHide: true, detached: true });
    c.unref();
  }, 300);
}

// --- models (11/15): the list, what is on this PC, downloads and checks ---
// models/models.json lists each model: its files on Hugging Face (name and size), where it goes on this PC (local_dir) and
// the start settings that use it (start_config). Paths stay here; the page gets names, sizes and states only.
// A download (or a check of files already here) runs models/model_dl.py in its own Python process, which writes its
// progress to models/state/dl-<id>.json; this server reads that file. Stopping one: a stop file the process looks at
// between chunks, and after 8 s, if it is still there, the process this server started (by its own handle, no other).
const GIB = 1024 ** 3;
const DL_ACTIVE = new Set(["starting", "downloading", "verifying"]);
const downloads = new Map(); // id -> {child, stopFile, stopAsked, verifyOnly}
// 11/17 W1 (D): downloading a model also downloads the shared parts it needs first. true = the parts marked "optional" in
// models.json too (本人の決定 11/17); false = only the parts that are not optional. This is the one line that switches it.
const AUTO_DOWNLOAD_OPTIONAL = true;
// 11/17 W1 (E): the waiting list of downloads (ids, the one running first), kept so that it goes on after the app is closed and
// opened again. Another download may be added while one runs; they run one after another.
const QUEUE_FILE = path.join(MODELS_STATE, "queue.json");
const DISK_MARGIN = 2 * 1024 ** 3;   // kept free beyond what the list still has to fetch
fs.mkdirSync(MODELS_STATE, { recursive: true });

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function readCatalog() {
  try { return JSON.parse(fs.readFileSync(MODELS_CATALOG, "utf8").replace(/^﻿/, "")); } catch (e) { return { models: [], error: String(e.message || e) }; }
}
const modelById = (cat, id) => (cat.models || []).find((m) => m.id === id) || null;
// 11/15 app1115: the shared parts (GGUF, MTP, tokenizer, mmproj) of models.json "shared"; downloaded the same way
const itemById = (cat, id) => [...(cat.models || []), ...(cat.shared || [])].find((m) => m.id === id) || null;
function freeBytes(dir) {
  let d = path.resolve(String(dir || "."));
  for (let i = 0; i < 12; i++) {
    try { const st = fs.statfsSync(d); return Number(st.bavail) * Number(st.bsize); } catch { /* not there yet */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
function sharedState(cat) {
  return (cat.shared || []).map((x) => ({
    id: x.id, name: x.name, optional: !!x.optional, local: localState(x), download: dlView(x),
    downloadable: !!(x.hf && x.hf.repo), free_bytes: freeBytes(x.local_dir),
  }));
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); } catch { return null; } };
const sameDir = (a, b) => {
  const key = (v) => process.platform === "win32" ? path.resolve(v).toLowerCase() : path.resolve(v);
  return !!a && !!b && key(a) === key(b);
};

// What is on disk: the files whose size is as listed, and the bytes of a download that was cut off (huggingface_hub's
// .incomplete files, from which a resumed download goes on). "verified": the last check (model_dl.py) passed and no
// file changed since (size and modification time as recorded then).
function localState(m) {
  let have = 0;
  let whole = 0;
  const files = m.files || [];
  for (const f of files) {
    try {
      if (fs.statSync(path.join(m.local_dir, f.path)).size === f.bytes) { have += f.bytes; whole++; }
    } catch { /* not there */ }
  }
  let partial = 0;
  const inc = path.join(m.local_dir, ".cache", "huggingface", "download");
  try {
    for (const n of fs.readdirSync(inc)) if (n.endsWith(".incomplete")) partial += fs.statSync(path.join(inc, n)).size;
  } catch { /* none */ }
  const total = files.reduce((s, f) => s + f.bytes, 0);
  return { complete: files.length > 0 && whole === files.length, have_bytes: have, partial_bytes: partial, total_bytes: total, verified: verifiedOk(m) };
}

function verifiedOk(m) {
  const v = readJson(path.join(MODELS_STATE, `verified-${m.id}.json`));
  if (!v || !v.ok || !sameDir(v.local_dir, m.local_dir)) return false;
  for (const f of m.files || []) {
    const rec = v.files && v.files[f.path];
    if (!rec) return false;
    try {
      const st = fs.statSync(path.join(m.local_dir, f.path), { bigint: true });
      if (Number(st.size) !== rec.bytes || String(st.mtimeNs) !== String(rec.mtime_ns)) return false;
    } catch { return false; }
  }
  return true;
}

// The files the start settings need beside the model's own (the shared GGUF, the draft layers, the tokenizer, the engine).
// Only their names go to the page.
function sharedMissing(m) {
  const c = readJson(m.start_config);
  if (!c) return [path.basename(String(m.start_config || "start_config"))];
  const need = [];
  const a = c.args || [];
  for (const k of ["--native", "--ple-gguf", "--mtp"]) { const i = a.indexOf(k); if (i >= 0 && a[i + 1]) need.push(a[i + 1]); }
  if (c.exe) need.push(c.exe);
  if (c.tokenizer) need.push(c.tokenizer);
  return [...new Set(need)].filter((p) => !fs.existsSync(p)).map((p) => path.basename(p));
}

// The settings file for a start: the model's own when the tail skip asked is its own (or none is asked), otherwise a
// copy with STRATA_ROUTE_TAIL_SKIP changed, kept in models/state/cfg/ (made again on every start, from the model's own).
function configFor(m, r, base) {
  const c = readJson(base);
  if (!c) throw new Error(`${path.basename(base)} を読めません`);
  const a = c.args || [];
  const i = a.indexOf("--pack");
  if (i >= 0 && !sameDir(a[i + 1], m.local_dir)) throw new Error(`${path.basename(base)} の --pack が一覧の置き場と違います`);
  const own = Number((c.env || {}).STRATA_ROUTE_TAIL_SKIP ?? 0);
  const want = r === 10 ? 0 : r; // 11/15: R10 は「省かない」＝エンジンの 0（エンジンは 0〜9 に切るので 10 は送らない）
  if (r == null || want === own) return base;
  const dir = path.join(MODELS_STATE, "cfg");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${m.id}-r${r}.json`);
  const note = `${c.note ? `${c.note} | ` : ""}11/15 会話の画面の Strata の欄が ${path.basename(base)} から作った写し（tail skip ${own} → ${want}${r === 10 ? "（R10＝省かない）" : ""} だけ変えた）`;
  fs.writeFileSync(out, JSON.stringify({ ...c, env: { ...(c.env || {}), STRATA_ROUTE_TAIL_SKIP: String(want) }, note }, null, 1));
  return out;
}

// --- 11/15: the PC's spec and the tail skip recommended for it (GET /m/spec). A phone asking gets the PC's numbers. ---
// There is no estimate of the decode speed from the parts yet, so the fallback rule decides: R7 when VRAM is 16 GB or more, or
// RAM 48 GB or more with VRAM 12 GB or more; R4 otherwise (a PC like 本人's: RTX 3080 12 GB, RAM 32 GB, 8 cores 16 threads).
// DSH_SPEC_OVERRIDE (JSON, only for trying the page) replaces the measured numbers.
let specCache = null;
function nvidiaSmi() {
  return new Promise((resolve) => execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 8000 },
    (err, out) => {
      if (err) return resolve(null);
      const rows = String(out).trim().split(/\r?\n/).map((l) => l.split(",").map((x) => x.trim())).filter((r) => r.length >= 2);
      if (!rows.length) return resolve(null);
      const best = rows.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
      resolve({ gpu: best[0], vram_gib: Math.round((Number(best[1]) / 1024) * 10) / 10 });
    }));
}
async function specView() {
  if (!specCache || Date.now() - specCache.at > 10 * 60000) {
    const g = (await nvidiaSmi()) || { gpu: null, vram_gib: 0 };
    const cpus = os.cpus() || [];
    specCache = { at: Date.now(), ram_gib: Math.round((os.totalmem() / GIB) * 10) / 10, vram_gib: g.vram_gib, gpu: g.gpu,
      cpu: cpus[0] ? cpus[0].model.trim() : null, threads: cpus.length };
  }
  let sp = { ...specCache };
  try { if (process.env.DSH_SPEC_OVERRIDE) sp = { ...sp, ...JSON.parse(process.env.DSH_SPEC_OVERRIDE) }; } catch { /* ignore */ }
  const high = sp.vram_gib + 0.5 >= 16 || (sp.ram_gib + 1 >= 48 && sp.vram_gib + 0.5 >= 12);
  return { ok: true, ram_gib: sp.ram_gib, vram_gib: sp.vram_gib, gpu: sp.gpu, cpu: sp.cpu, threads: sp.threads, recommended_r: high ? 7 : 4,
    basis: "fallback", reason: { vram_gib: sp.vram_gib, ram_gib: sp.ram_gib, r: high ? 7 : 4 } };
}

const choiceFile = () => path.join(MODELS_STATE, "choice.json");
function saveChoice(c) { try { fs.writeFileSync(choiceFile(), JSON.stringify({ ...c, at: Date.now() })); } catch { /* not kept */ } }

// The download's state as model_dl.py last wrote it. One that says it is still working but has not written for 20 s and is
// not a process of this server is shown as cut off (it can be resumed).
function dlStatus(id) {
  const s = readJson(path.join(MODELS_STATE, `dl-${id}.json`));
  if (!s) return null;
  const d = downloads.get(id);
  const alive = !!(d && d.child.exitCode == null && !d.child.killed);
  if (DL_ACTIVE.has(s.state) && !alive && Date.now() / 1000 - (s.updated_at || 0) > 20) return { ...s, state: "interrupted" };
  return s;
}
const activeDownload = (cat) => [...(cat.models || []), ...(cat.shared || [])].map((m) => m.id).find((id) => { const s = dlStatus(id); return s && DL_ACTIVE.has(s.state); }) || null;

let downloadsStarting = 0;
let pythonExe = process.env.DSH_MODELS_PYTHON || null;
function findPython(cat) {
  if (cat.python) return Promise.resolve(cat.python);
  if (pythonExe) return Promise.resolve(pythonExe);
  // python.exe itself, not py.exe: stopping py.exe would leave its python child running
  return new Promise((resolve, reject) => execFile("py", ["-3", "-c", "import sys; print(sys.executable)"], { windowsHide: true, timeout: 15000 },
    (err, out) => { if (err || !String(out).trim()) reject(new Error("Python（py -3）が見つかりません")); else resolve(pythonExe = String(out).trim()); }));
}

async function startDownload(id, verifyOnly) {
  const cat = readCatalog();
  const m = itemById(cat, id);
  if (!m) return { ok: false, error: "一覧にないモデルです" };
  if (!verifyOnly && !(m.hf && m.hf.repo)) return { ok: false, error: `${m.name} の置き場（Hugging Face）がまだ決まっていません` };
  const busy = activeDownload(cat);
  if (busy) return { ok: false, error: busy === id ? "もう進んでいます" : `${itemById(cat, busy).name} のダウンロードか検査の途中です（1 つずつ）` };
  if (job && !job.endedAt && job.model === id) return { ok: false, error: `${m.name} の起動の途中です` };
  if (verifyOnly && !localState(m).complete) return { ok: false, error: `${m.name} は手元にそろっていません` };
  let py;
  downloadsStarting++;
  try { py = await findPython(cat); } catch (e) { return { ok: false, error: e.message }; } finally { downloadsStarting--; }
  const status = path.join(MODELS_STATE, `dl-${id}.json`);
  const stopFile = path.join(MODELS_STATE, `dl-${id}.stop`);
  fs.rmSync(stopFile, { force: true });
  fs.writeFileSync(status, JSON.stringify({ id, local_dir: m.local_dir, state: "starting", mode: verifyOnly ? "verify" : "download", updated_at: Date.now() / 1000, started_at: Date.now() / 1000 }));
  const args = ["-X", "utf8", MODELS_DL, "--catalog", MODELS_CATALOG, "--id", id, "--status", status, "--stop-file", stopFile, "--verified-dir", MODELS_STATE];
  if (verifyOnly) args.push("--verify-only");
  if (MODELS_HF_ENDPOINT) args.push("--endpoint", MODELS_HF_ENDPOINT);
  if (HF_APP_HOME) args.push("--hf-home", HF_APP_HOME);   // 11/15 係 C
  const out = fs.openSync(path.join(MODELS_STATE, `dl-${id}.out`), "w");
  // The Hugging Face key is never handled here: huggingface_hub in that process reads the PC's own login.
  const child = spawn(py, args, { stdio: ["ignore", out, out], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  fs.closeSync(out);
  const d = { child, stopFile, stopAsked: false, verifyOnly: !!verifyOnly };
  downloads.set(id, d);
  child.on("error", (e) => {
    if (downloads.get(id) === d) downloads.delete(id);
    fs.writeFileSync(status, JSON.stringify({ id, local_dir: m.local_dir, state: "failed", error: e.message, updated_at: Date.now() / 1000 }));
  });
  child.on("exit", (code) => {
    const s = readJson(status) || { id };
    if (DL_ACTIVE.has(s.state)) {  // ended without saying so (stopped by force, or it broke)
      fs.writeFileSync(status, JSON.stringify({ ...s, state: d.stopAsked ? "stopped" : "failed", speed_bps: null, eta_s: null,
        error: d.stopAsked ? null : `ダウンロードの道具が途中で終わりました（終了コード ${code}）`, updated_at: Date.now() / 1000 }));
    }
    if (downloads.get(id) === d) downloads.delete(id);
    if (!d.verifyOnly) queueWrite(queueRead().filter((x) => x !== id));   // 11/17 W1: done, failed or stopped: it leaves the list
    setTimeout(() => queueTick().catch(() => {}), 300);                  // and the next one starts
  });
  return { ok: true };
}

// --- 11/17 W1 (D, E): the waiting list ---
function queueRead() {
  const q = readJson(QUEUE_FILE);
  return Array.isArray(q && q.items) ? q.items.filter((x) => typeof x === "string") : [];
}
function queueWrite(items) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify({ items, at: Date.now() })); } catch { /* not kept */ }
}
const itemLeft = (m) => { const l = localState(m); return Math.max(0, l.total_bytes - l.have_bytes - l.partial_bytes); };
const rootOf = (dir) => path.parse(path.resolve(String(dir || "."))).root.toLowerCase();
// the shared parts a model's download brings along: not here yet, with a place to fetch from (the optional ones per AUTO_DOWNLOAD_OPTIONAL)
function sharedWanted(cat) {
  return (cat.shared || []).filter((s) => s.hf && s.hf.repo && (AUTO_DOWNLOAD_OPTIONAL || !s.optional) && !localState(s).complete);
}
// Whether the whole list fits the disks (per drive: what every item still has to fetch, plus the margin, against the free space).
function queueDiskError(cat, ids) {
  const need = new Map();
  const free = new Map();
  for (const id of ids) {
    const m = itemById(cat, id);
    if (!m) continue;
    const root = rootOf(m.local_dir);
    need.set(root, (need.get(root) || 0) + itemLeft(m));
    if (!free.has(root)) free.set(root, freeBytes(m.local_dir));
  }
  const g = (b) => `${(b / GIB).toFixed(1)} GiB`;
  for (const [root, n] of need) {
    const fr = free.get(root);
    if (n > 0 && fr != null && fr < n + DISK_MARGIN) return `空きが足りません（ダウンロード待ちの分 ${g(n)} に対して，空きは ${g(fr)}）`;
  }
  return null;
}

// POST /m/models/download?id=: puts the item on the list. A model brings the shared parts it lacks, ahead of everything that
// waits (behind the one running); a model that is already here only brings the parts.
function enqueueDownload(id) {
  const cat = readCatalog();
  const m = itemById(cat, id);
  if (!m) return { ok: false, error: "一覧にないモデルです" };
  if (!(m.hf && m.hf.repo)) return { ok: false, error: `${m.name} の置き場（Hugging Face）がまだ決まっていません` };
  const isModel = (cat.models || []).some((x) => x.id === id);
  const q = queueRead().filter((x) => itemById(cat, x));
  const act = activeDownload(cat);
  const deps = isModel ? sharedWanted(cat).map((s) => s.id) : [];
  const own = isModel && localState(m).complete ? [] : [id];
  if (!deps.length && !own.length) return { ok: false, error: `${m.name} はもう手元にあります` };
  const head = act && q.includes(act) ? [act] : [];
  const order = [...new Set([...head, ...deps, ...q.filter((x) => !deps.includes(x)), ...own])];
  if (order.length === q.length && order.every((x, i) => x === q[i])) return { ok: true, already: true, queued: q };
  const why = queueDiskError(cat, order);
  if (why) return { ok: false, error: why };
  queueWrite(order);
  queueTick().catch(() => {});
  return { ok: true, queued: order };
}

// Starts the head of the list when nothing is running. One that cannot start is dropped and the next one is tried.
let ticking = false;
async function queueTick() {
  if (ticking || modelDirectoryBlocked()) return;
  ticking = true;
  try {
    for (let guard = 0; guard < 50; guard++) {
      const cat = readCatalog();
      const q = queueRead().filter((x) => itemById(cat, x));
      // a download's own process counts as running until it has really ended (its status file can say "done" a moment before)
      const running = [...downloads.values()].some((d) => d.child.exitCode == null && d.child.signalCode == null);
      if (running || activeDownload(cat) || !q.length) { if (q.length !== queueRead().length) queueWrite(q); break; }
      const r = await startDownload(q[0], false);
      if (r.ok) break;
      queueWrite(q.slice(1));
    }
  } finally { ticking = false; }
}

function cancelDownload(id) {
  if (!itemById(readCatalog(), id)) return { ok: false, error: "一覧にないモデルです" };
  const s = dlStatus(id);
  const q = queueRead();
  const waiting = q.includes(id);
  if (waiting) queueWrite(q.filter((x) => x !== id));   // 11/17 W1: taken off the list (the running one too: it does not start again)
  if (!s || !DL_ACTIVE.has(s.state)) return waiting ? { ok: true } : { ok: false, error: "進んでいるダウンロードも待ちもありません" };
  fs.writeFileSync(path.join(MODELS_STATE, `dl-${id}.stop`), "1");
  const d = downloads.get(id);
  if (d) {
    d.stopAsked = true;
    setTimeout(() => { if (d.child.exitCode == null && !d.child.killed) d.child.kill(); }, 8000);
  }
  return { ok: true };
}

const DL_FIELDS = ["state", "mode", "file", "files_done", "files_total", "done_bytes", "total_bytes", "speed_bps", "eta_s", "error", "message", "verify", "updated_at"];
DL_FIELDS.push("error_kind");   // 11/15 係 C: "auth" = a private model and no (or a wrong) token
function dlView(m) {
  const s = dlStatus(m.id);
  if (!s || !sameDir(s.local_dir, m.local_dir)) return null;
  const v = {};
  for (const k of DL_FIELDS) if (s[k] !== undefined) v[k] = k === "verify" && s.verify ? { done_bytes: s.verify.done_bytes, total_bytes: s.verify.total_bytes, bad: s.verify.bad } : s[k];
  return v;
}

// The waiting list for the page: the running one first. kind tells a model from a shared part.
function queueView(cat) {
  const act = activeDownload(cat);
  return queueRead().map((id) => ({ id, m: itemById(cat, id) })).filter((x) => x.m).map(({ id, m }) => ({
    id, name: m.name, kind: (cat.models || []).some((x) => x.id === id) ? "model" : "shared", active: id === act }));
}

// Which one suits this PC: the largest whose experts all fit in this RAM (fits_ram_gib, in the GB a PC is sold with:
// a "32 GB" PC reports about 31.6 GiB, hence the 1 GiB of slack), otherwise the smallest.
function modelDeleteBusy(cat) {
  if (startsPending || (job && !job.endedAt) || shuttingDown || updateApplying) return true;
  if (downloadsStarting || downloads.size || queueRead().length || activeDownload(cat)) return true;
  // A worker from a previous relay can still be alive even if its progress file has gone stale.
  return [...(cat.models || []), ...(cat.shared || [])].some(({ id }) => {
    const s = dlStatus(id);
    if (s?.state !== "interrupted" || !Number.isSafeInteger(s.pid) || s.pid <= 0) return false;
    try { process.kill(s.pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
  });
}

async function engineStoppedForDelete() {
  if (LAUNCHER) {
    const r = await launcher(["status", "--json"]);
    const engine = lastJsonLine(r.out)?.engine;
    // The launcher can own an engine that is not yet healthy (starting or restarting).
    if (r.code !== 0 || engine?.up !== false || engine?.own !== false) return false;
  }
  try {
    // A responding but unhealthy engine (or a timeout) is not evidence of a stop.
    await fetch(`${STRATA}/metrics`, { signal: AbortSignal.timeout(2500), redirect: "error" });
    return false;
  } catch (e) { return e.cause?.code === "ECONNREFUSED"; }
}

function catalogFile(item, file) {
  const parts = typeof file.path === "string" ? file.path.split(/[\\/]/) : [];
  if (typeof item.local_dir !== "string" || !item.local_dir || !parts.length ||
      parts.some((p) => !p || p === "." || p === ".." || /[:\x00]/.test(p) || /[. ]$/.test(p))) {
    throw new Error("Unsafe catalog path");
  }
  return path.resolve(item.local_dir, ...parts);
}

function existingFile(file, stat) {
  try { return stat(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

function modelDeleteFiles(cat, m) {
  const key = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  const protectedFiles = new Set();
  for (const other of [...(cat.models || []), ...(cat.shared || [])]) {
    if (other === m) continue;
    for (const f of other.files || []) {
      const file = catalogFile(other, f);
      protectedFiles.add(key(file));
      const real = existingFile(file, fs.realpathSync.native);
      if (real) protectedFiles.add(key(real));
    }
  }
  const files = new Map();
  for (const f of m.files || []) {
    const file = catalogFile(m, f);
    const st = existingFile(file, fs.lstatSync);
    if (!st) continue;
    // Refuse links/junctions in the target path and never remove a directory or a shared entry.
    const real = key(fs.realpathSync.native(file));
    if (!st.isFile() || real !== key(file) || protectedFiles.has(real)) throw new Error("Unsafe model file");
    files.set(real, file);
  }
  return [...files.values()];
}

async function deleteModel(id) {
  const fail = (error) => ({ ok: false, error });
  const busy = () => fail("起動・終了・更新・ダウンロード・検査が終わってから削除してください");
  const jobBefore = job;
  try {
    let cat = readCatalog();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || !modelById(cat, id)) return fail("一覧にないモデルです");
    if (modelDeleteBusy(cat)) return busy();
    if (!(await engineStoppedForDelete())) return fail("Strata を停止してから削除してください");
    // Re-read after the probe. Keep the checks and unlinks synchronous so relay jobs cannot interleave.
    cat = readCatalog();
    if (modelDirectoryBlocked() || job !== jobBefore || modelDeleteBusy(cat)) return busy();
    const m = modelById(cat, id);
    if (!m || m.pending || [...(cat.models || []), ...(cat.shared || [])].filter((x) => x.id.toLowerCase() === id.toLowerCase()).length !== 1) {
      return fail("削除できるモデルではありません");
    }
    const files = modelDeleteFiles(cat, m);
    if (!files.length) return fail("削除するモデルファイルがありません");
    for (const name of [`verified-${id}.json`, `dl-${id}.json`, `dl-${id}.json.tmp`, `dl-${id}.stop`, `dl-${id}.out`]) {
      fs.rmSync(path.join(MODELS_STATE, name), { force: true });
    }
    for (const file of files) fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    console.error("Model deletion failed:", e.message);
    return fail("モデルファイルを削除できませんでした。一覧を確認してください");
  }
}

function modelsView() {
  const cat = readCatalog();
  // 11/15 本人: RAM 32 GB でも VRAM が 12 GB 未満なら Sync-XS を勧める．fits_vram_gib＝これだけの VRAM が要る
  // （RAM が vram_waived_ram_gib 以上なら要らない）．VRAM が分からないとき（まだ調べていない・nvidia-smi が無い）は RAM だけで決める．
  if (!specCache || Date.now() - specCache.at > 10 * 60000) specView().catch(() => {});
  let sp = specCache ? { ram_gib: os.totalmem() / GIB, vram_gib: specCache.vram_gib } : { ram_gib: os.totalmem() / GIB, vram_gib: 0 };
  try { if (process.env.DSH_SPEC_OVERRIDE) sp = { ...sp, ...JSON.parse(process.env.DSH_SPEC_OVERRIDE) }; } catch { /* ignore */ }
  const ram = sp.ram_gib;
  const vram = sp.vram_gib > 0 ? sp.vram_gib : null;
  const ramShort = (m) => ram + 1 < (m.fits_ram_gib || 0);
  const vramShort = (m) => vram != null && !!m.fits_vram_gib && vram + 0.5 < m.fits_vram_gib && !(m.vram_waived_ram_gib && ram + 1 >= m.vram_waived_ram_gib);
  const fitsOf = (m) => !ramShort(m) && !vramShort(m);
  // 11/15: pending（一覧にはあるが pack がまだ無いモデル）はおすすめにしない
  const bySize = (cat.models || []).filter((m) => !m.pending).sort((a, b) => (b.experts_gib || 0) - (a.experts_gib || 0));
  const rec = bySize.find(fitsOf) || bySize[bySize.length - 1] || null;
  const runningModel = snapshot.online ? (cat.models || []).find((m) => m.match && new RegExp(m.match, "i").test(snapshot.model || "")) : null;
  const choice = readJson(choiceFile());
  const shared = sharedState(cat);
  const wanted = sharedWanted(cat);
  const queue = queueView(cat);
  const inQueue = new Set(queue.map((x) => x.id));
  const models = (cat.models || []).map((m) => {
    const loc = localState(m);
    return {
      id: m.id, name: m.name, preset: m.preset || null, match: m.match || m.id, description: m.description || {}, experts_gib: m.experts_gib || null,
      fits_ram_gib: m.fits_ram_gib || null, fits: fitsOf(m), short: ramShort(m) ? "ram" : vramShort(m) ? "vram" : null, recommended: !!rec && rec.id === m.id, default_r: m.default_r ?? null, pending: !!m.pending,
      local: loc, shared_missing: loc.complete ? (LAUNCHER ? shared.filter((x) => !x.optional && !x.local.complete).map((x) => x.name) : sharedMissing(m)) : [],
      free_bytes: freeBytes(m.local_dir), download: dlView(m), running: !!runningModel && runningModel.id === m.id,
      // 11/17 W1: the shared parts its download would bring (not here, not already on the list), and how much they are
      shared_pending: wanted.filter((s) => !inQueue.has(s.id)).map((s) => s.name), shared_bytes: wanted.filter((s) => !inQueue.has(s.id)).reduce((a, s) => a + itemLeft(s), 0),
    };
  });
  return {
    ok: true, ram_gib: Math.round(ram * 10) / 10, models, active: activeDownload(cat), queue, catalog_error: cat.error || null,
    delete_blocked: snapshot.online || modelDeleteBusy(cat),
    running: runningModel ? { model: runningModel.id, r: choice && choice.model === runningModel.id ? choice.r ?? null : null } : null,
    choice: choice ? { model: choice.model, r: choice.r ?? null } : null,
    // 11/15 app1115: the shared parts, whether this is a first run (no model, or a shared part missing), and whether the launcher
    // is behind this relay (settings and "stop everything" are offered only then)
    shared, first_run: !models.some((m) => m.local.complete) || shared.some((x) => !x.optional && !x.local.complete),
    launcher: !!LAUNCHER, free_bytes: freeBytes((cat.models || [])[0] && cat.models[0].local_dir),
  };
}

async function modelsRoute(req, res, url, action) {
  if (!action || action === "progress") {
    if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false, models: [] }, 401); }
    lastAsked = Date.now();
    if (!action) return sendJson(res, modelsView());
    const cat = readCatalog();
    return sendJson(res, { ok: true, active: activeDownload(cat), queue: queueView(cat), downloads: Object.fromEntries([...(cat.models || []), ...(cat.shared || [])].map((m) => [m.id, dlView(m)])) });
  }
  if (!(await dshLoggedIn(req))) return sendJson(res, { ok: false, error: "dsh にログインしていません" }, 403);
  logAccess(req, res);
  if (modelDirectoryBlocked()) return sendJson(res, { ok: false, error: modelDirectoryRestart }, 409);
  const id = url.searchParams.get("id") || "";
  if (action === "delete") return sendJson(res, await deleteModel(id));
  if (action === "cancel") return sendJson(res, cancelDownload(id));
  if (action === "verify") return sendJson(res, await startDownload(id, true));
  return sendJson(res, enqueueDownload(id));   // 11/17 W1: a download is put on the list (D: with its shared parts, E: behind the others)
}

function proxy(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const up = http.request({ ...DSH, method: req.method, path: req.url, headers }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    // 11/14: our frame rule beside dsh's own policy (both apply); dsh's other headers win over setBaseHeaders()
    const csp = out["content-security-policy"];
    out["content-security-policy"] = csp ? [].concat(csp, DSH_CSP) : DSH_CSP;
    if (!out["x-frame-options"]) out["x-frame-options"] = "SAMEORIGIN";
    res.writeHead(r.statusCode, r.statusMessage, out);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web is not running");
  });
  req.pipe(up);
}

// 11/14: what every request and upgrade passes first. null = go on; otherwise [status, message].
function gate(req) {
  if (!hostAllowed(req.headers.host)) return [421, "この名前（Host）では受け付けていません"];
  const changes = req.method !== "GET" && req.method !== "HEAD";
  if (changes || req.headers.upgrade) {
    const why = crossSiteReason(req);
    if (why) return [403, `ほかのサイトからの要求は受け付けません（${why}）`];
  }
  return null;
}

// 11/14: Strata's state and request log only for a dsh login (they tell when and how much the PC is used).
// 401 with an empty answer of the usual shape, so a page that is not logged in just shows "offline".
async function strataRead(req, res, url, name) {
  if (!(await dshCookieOk(req))) {
    logAccess(req, res);
    return sendJson(res, name === "strata" ? { online: false, auth: false } : { items: [], auth: false }, 401);
  }
  return name === "strata" ? strataStatus(res) : strataRequests(res, url);
}


// --- 11/15 係 C: the context settings (GET /m/ctx = sync.py ctx --json) and the Hugging Face read token (/m/hf-token, status only since 11/17) ---
// The token lives in this app's own place (SYNC_HOME\hf, given to huggingface_hub as HF_HOME); the PC's own login is not
// used or read. It goes to models/model_dl.py on its standard input, never in a command line, a log or an answer.
async function ctxRoute(req, res) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
  if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  logAccess(req, res);
  const r = await launcher(["ctx", "--json"]);
  try { return sendJson(res, { ok: true, ...JSON.parse(r.out) }); } catch { return sendJson(res, { ok: false, error: (r.err || "コンテキストの設定を読めませんでした").trim() }); }
}

// --- 11/16 係 G2: GET /m/strata/ctx = the numbers dsh really runs with (the chat's "where compaction starts") ---
// Read from the two files the launcher writes at every start (nothing is computed here from a table that could drift):
//   SYNC_HOME\run\dsh-ctx.patch.yml                         headroomTokens and thresholdRatio of compaction-basic (and the summary's maxTokens)
//   SYNC_HOME\dsh-home\profiles\web\cordis.patch.yml        each model's contextWindow and maxTokens (the reply limit)
// compact_at = min(window * thresholdRatio, window - maxTokens - headroom) (dsh-compaction-basic's rule), also given per model.
// The page asks when it opens a conversation and when the sheet opens; a changed setting shows after the next start.
// DSH_CTX_PATCH and DSH_PROFILE_PATCH move the two files (only for trying). Without them and without SYNC_HOME: ok false (the page
// then keeps its own estimate).
const CTX_PATCH = process.env.DSH_CTX_PATCH || (process.env.SYNC_HOME ? path.join(process.env.SYNC_HOME, "run", "dsh-ctx.patch.yml") : "");
const PROFILE_PATCH = process.env.DSH_PROFILE_PATCH || (process.env.SYNC_HOME ? path.join(process.env.SYNC_HOME, "dsh-home", "profiles", "web", "cordis.patch.yml") : "");
function readCtxNumbers() {
  if (!CTX_PATCH || !PROFILE_PATCH) return null;
  let a, b;
  try { a = fs.readFileSync(CTX_PATCH, "utf8"); b = fs.readFileSync(PROFILE_PATCH, "utf8"); } catch { return null; }
  const num = (re, t) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const headroom = num(/^\s*headroomTokens:\s*(\d+)/m, a);
  const ratio = num(/^\s*thresholdRatio:\s*([0-9.]+)/m, a);
  const summary = num(/^\s*maxTokens:\s*(\d+)/m, a);
  const models = {};
  let cur = null;   // the model entry being read (a "- id: strata-…" line up to the next "- id:" line)
  for (const line of b.split(/\r?\n/)) {
    const idm = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idm) { cur = /^strata-/.test(idm[1]) ? (models[idm[1]] = { context: null, max_tokens: null }) : null; continue; }
    if (!cur) continue;
    const w = /^\s*contextWindow:\s*(\d+)/.exec(line);
    const t = /^\s*maxTokens:\s*(\d+)/.exec(line);
    if (w) cur.context = Number(w[1]);
    if (t) cur.max_tokens = Number(t[1]);
  }
  for (const id of Object.keys(models)) if (!models[id].context || !models[id].max_tokens) delete models[id];
  const ids = Object.keys(models);
  if (headroom == null || ratio == null || !ids.length) return null;
  const at = (c, mt) => Math.max(0, Math.floor(Math.min(c * ratio, c - mt - headroom)));
  for (const id of ids) models[id].compact_at = at(models[id].context, models[id].max_tokens);
  const f = models[ids[0]];
  return { ok: true, context: f.context, max_tokens: f.max_tokens, headroom, threshold_ratio: ratio, summary_max: summary, compact_at: f.compact_at, models,
    updated: Math.max(fs.statSync(CTX_PATCH).mtimeMs, fs.statSync(PROFILE_PATCH).mtimeMs) };
}
async function strataCtxRoute(req, res) {
  if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  const v = readCtxNumbers();
  return sendJson(res, v || { ok: false, error: "no ctx numbers" });
}

function hfTokenTool(args, input) {
  return findPython(readCatalog()).then((py) => new Promise((resolve) => {
    const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
    for (const k of ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_TOKEN_PATH", "HF_STORED_TOKENS_PATH"]) delete env[k];
    const c = spawn(py, ["-X", "utf8", MODELS_DL, "token", ...args, "--hf-home", HF_APP_HOME, ...(MODELS_HF_ENDPOINT ? ["--endpoint", MODELS_HF_ENDPOINT] : [])],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
    let out = "";
    const t = setTimeout(() => c.kill(), 60000);
    c.stdout.on("data", (b) => { if (out.length < 4096) out += b; });
    c.on("error", () => { clearTimeout(t); resolve({ ok: false, error: "トークンの道具を起こせませんでした" }); });
    c.on("close", () => {
      clearTimeout(t);
      try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ ok: false, error: "トークンの道具が答えませんでした" }); }
    });
    c.stdin.end(input ? `${input}\n` : "");
  }), (e) => ({ ok: false, error: e.message }));
}

// 11/17 W1 (C): the token field is gone from the page, so the relay no longer sets or clears it (POST is refused; 404).
// Only the status stays (GET: whether a token is saved). A token is put in from a terminal (model_dl.py token set --hf-home <SYNC_HOME>/hf).
async function hfTokenRoute(req, res) {
  if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  if (!HF_APP_HOME) return sendJson(res, { ok: true, available: false, set: false });
  const r = await hfTokenTool(["status"]);
  return sendJson(res, { ok: !!r.ok, available: true, set: !!r.set, ...(r.ok ? {} : { error: r.error }) });
}


// --- 11/15 係 C env: whether this PC can run Strata (GET /m/env = sync.py env --json). Keys and values only; the page words them. ---
async function envRoute(req, res) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
  if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  logAccess(req, res);
  const r = await launcher(["env", "--json"]);
  let d;
  try { d = JSON.parse(r.out); } catch { return sendJson(res, { ok: false, error: (r.err || "対応環境を調べられませんでした").trim() }); }
  const pick = (it) => Object.fromEntries(["key", "gpu", "driver", "need", "vram_gib", "ram_gib"].filter((k) => it && it[k] != null).map((k) => [k, it[k]]));
  const blockers = (d.blockers || []).map(pick);
  return sendJson(res, { ok: true, supported: !blockers.length, blockers, warnings: (d.warnings || []).map(pick) });
}

// --- 11/17 係 W5: how much memory the other apps use (GET /m/sysmem = sync.py mem --json) ---
// RAM, the Windows commit, VRAM, the biggest other apps and Strata's own share, as keys and numbers only; the page words them.
// The page polls it every few seconds while the memory view is open, so an answer is kept for 4 s and one run is shared by
// callers that arrive meanwhile (the probe takes 1-2 s).
const memCache = { at: 0, body: null, pending: null };
async function sysmemRoute(req, res) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
  if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  if (memCache.body && Date.now() - memCache.at < 4000) return sendJson(res, memCache.body);
  if (!memCache.pending) {
    memCache.pending = launcher(["mem", "--json"], 15000).then((r) => {
      let b;
      try { b = JSON.parse(r.out.trim().split("\n").pop()); } catch { b = { ok: false, error: (r.err || "メモリを調べられませんでした").trim() }; }
      memCache.body = b;
      memCache.at = b && b.ok ? Date.now() : 0;
      return b;
    }).finally(() => { memCache.pending = null; });
  }
  return sendJson(res, await memCache.pending);
}

// --- 11/18 係 W9: updates. GET /m/update = sync.py update check --json (reads the list of new versions, downloads nothing; ?local=1 = no
// network, only the version now); POST /m/update/apply = sync.py update apply --json (starts the updater apart from the app and returns;
// the updater closes everything, this relay included, swaps the changed parts and starts the app again). ---
// "From the PC only": applying closes the app on the PC, so it is refused for a phone (LAN, Tailscale or tunnel), the same fence as lan_remote.
const LOOP_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
function isPcRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  return LOOP_ADDR.test(String(req.socket.remoteAddress || "")) && LOOP_ADDR.test(String(req.socket.localAddress || ""))
    && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) && !req.headers["x-forwarded-for"] && !req.headers["cf-connecting-ip"];
}
const updCache = { at: 0, body: null, pending: null };
// what a phone does not need to see: where on the PC things are (the PC's own page keeps the folders for "put the zip here")
const updView = (b, pc) => { const o = { ...b, pc }; delete o.tool; delete o.app; if (!pc) { delete o.folders; delete o.zip; } return o; };
const lastJsonLine = (s) => { const l = String(s || "").trim().split("\n").reverse().find((x) => x.startsWith("{")); try { return l ? JSON.parse(l) : null; } catch { return null; } };
async function updateCheckRoute(req, res, url) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
  if (!(await dshCookieOk(req))) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
  const local = url.searchParams.get("local") === "1";
  const pc = isPcRequest(req);
  if (!local && updCache.body && Date.now() - updCache.at < 20000) return sendJson(res, updView(updCache.body, pc));
  if (local) {
    const r = await launcher(["update", "check", "--json", "--local"], 20000);
    return sendJson(res, updView(lastJsonLine(r.out) || { ok: false, kind: "old_tool" }, pc));
  }
  if (!updCache.pending) {
    updCache.pending = launcher(["update", "check", "--json"], 90000).then((r) => {
      const b = lastJsonLine(r.out) || { ok: false, kind: "old_tool", detail: (r.err || r.out).trim().split("\n").pop() };   // an old launcher has no "update"
      updCache.body = b;
      updCache.at = b && b.ok ? Date.now() : 0;
      return b;
    }).finally(() => { updCache.pending = null; });
  }
  return sendJson(res, updView(await updCache.pending, pc));
}
async function updateApplyRoute(req, res, url) {
  if (!LAUNCHER) return sendJson(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
  if (!(await dshLoggedIn(req))) return sendJson(res, { ok: false, error: "dsh にログインしていません" }, 403);
  logAccess(req, res);
  if (!isPcRequest(req)) return sendJson(res, { ok: false, kind: "pc_only", error: "更新は PC の画面から行ってください" }, 403);
  if (job && !job.endedAt) return sendJson(res, { ok: false, kind: "busy", error: "起動か終了の途中です" });
  const lang = url.searchParams.get("lang");
  if (updateApplying) return sendJson(res, { ok: false, kind: "busy", error: "更新の途中です" });
  updateApplying = true;
  const r = await launcher(["update", "apply", "--json", ...(["ja", "en", "zh"].includes(lang) ? ["--lang", lang] : [])], 20000);
  const d = lastJsonLine(r.out) || { ok: false, kind: "old_tool", error: (r.err || r.out).trim().split("\n").pop() };
  updateApplying = !!d.started;
  updCache.at = 0;
  return sendJson(res, { ok: !!d.ok, started: !!d.started, window: !!d.window, log: d.log, kind: d.kind, error: d.error || d.detail });
}

const server = http.createServer((req, res) => {
  setBaseHeaders(res);
  const refused = gate(req);
  if (refused) return refuse(req, res, ...refused);
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/m") {
    res.writeHead(301, { location: "/m/" });
    return res.end();
  }
  if (url.pathname.startsWith("/m/")) {
    const name = url.pathname.slice(3);
    const control = name.match(/^strata\/(guard|start|stop)$/);
    if (control) return strataControl(req, res, control[1]);
    // 11/15: GET /m/models (the list), GET /m/models/progress, POST /m/models/download|cancel|verify|delete?id=<model>
    if (Remote && name.startsWith("remote/")) return Remote.route(req, res, url, name);   // 11/15 係 R: /m/remote/status|pair|claim|apply
    if (Remote && name === "settings" && req.method === "POST") return Remote.settingsGuard(req, res, settingsRoute);   // 11/15 係 R: lan_remote は PC からだけ
    if (name === "settings" && (req.method === "GET" || req.method === "POST")) return settingsRoute(req, res);   // 11/15 app1115
    if (name === "shutdown" && req.method === "POST") return shutdownRoute(req, res, url);
    if (name === "ctx" && req.method === "GET") return ctxRoute(req, res);   // 11/15 係 C
    if (name === "env" && req.method === "GET") return envRoute(req, res);   // 11/15 係 C env
    if (name === "sysmem" && req.method === "GET") return sysmemRoute(req, res);   // 11/17 係 W5
    if (name === "update" && req.method === "GET") return updateCheckRoute(req, res, url);   // 11/18 係 W9
    if (name === "update/apply" && req.method === "POST") return updateApplyRoute(req, res, url);
    if (name === "hf-token" && req.method === "GET") return hfTokenRoute(req, res);
    const models = name.match(/^models(?:\/(progress|download|cancel|verify|delete))?$/);
    if (models && (["download", "cancel", "verify", "delete"].includes(models[1]) ? req.method === "POST" : req.method === "GET" || req.method === "HEAD")) {
      return modelsRoute(req, res, url, models[1] || null);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
    if (name === "strata/ctx") return strataCtxRoute(req, res);   // 11/16 係 G2
    if (name === "strata" || name === "strata/requests") return strataRead(req, res, url, name);
    if (name === "version") return sendJson(res, { v: version() });
    if (name === "spec") {   // 11/15: the PC's spec and the recommended tail skip (the same login check as /m/strata)
      return dshCookieOk(req).then(async (ok) => {
        if (!ok) { logAccess(req, res); return sendJson(res, { ok: false, auth: false }, 401); }
        return sendJson(res, await specView());
      });
    }
    logAccess(req, res);
    return serveStatic(req, res, name === "" ? "index.html" : name);
  }
  proxy(req, res);
});

// WebSocket upgrades (dsh's /api/remote.mux): replay the request head to dsh and splice the two sockets.
// 11/14: after the same gate as above (421 / 403 answered on the raw socket, nothing reaches dsh).
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const refused = gate(req);
  if (refused) {
    const [code] = refused;
    socket.end(`HTTP/1.1 ${code} ${code === 421 ? "Misdirected Request" : "Forbidden"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    return;
  }
  const up = net.connect(DSH.port, DSH.host, () => {
    let text = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(text + "\r\n");
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// A second start (the port is already taken, usually by this same server) ends with a note instead of a stack trace.
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.log(`ポート ${PORT} はもう使われています．スマホ用の中継はすでに動いているので，この窓は閉じて大丈夫です．`);
  process.exit(0);
});

specView().catch(() => {});   // 11/15: the model list needs the VRAM size for its recommendation
server.listen(PORT, "127.0.0.1", () => {
  console.log(`dsh mobile: http://127.0.0.1:${PORT}/m/ -> dsh web at ${DSH.host}:${DSH.port}`);
  console.log(ALLOWED.names.size
    ? `dsh mobile: 受け付ける名前: loopback と ${[...ALLOWED.names].join(", ")}（${ALLOWED.from}）`
    : "dsh mobile: 公開名の設定（DSH_MOBILE_ALLOWED_HOSTS か allowed-hosts.txt）が無いので，loopback の名前だけを受け付けます");
  try { if (Remote) Remote.start({ server, port: PORT, allowed: ALLOWED.names, dshCookieOk, sendJson, logAccess, dsh: DSH }); } catch (e) { console.log(`dsh mobile: スマホの接続を始められません（${e.message}）`); }   // 11/15 係 R
  loadRequests();
  strataLoop();
  // 11/17 W1 (E): a list left from before the app was closed goes on (a half-fetched file continues where it stopped)
  queueTick().catch(() => {});
  setInterval(() => queueTick().catch(() => {}), 5000).unref();
});
