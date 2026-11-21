// Phone connection for the relay (11/15 係 R): "same Wi-Fi" (lan) and "from outside" (tailscale), set by the launcher's
// lan_remote setting. server.mjs loads this file (if it is there) and calls start() once it listens on 127.0.0.1, and route()
// for /m/remote/*. With DSH_REMOTE_MODE unset or "off" nothing here listens or answers but status (mode "off").
//
// The launcher (sync_remote.py) decides the addresses and passes them:
//   DSH_REMOTE_MODE   off | lan | tailscale
//   DSH_REMOTE_BIND   the addresses to listen on besides 127.0.0.1 (the LAN or Tailscale IPv4; never 0.0.0.0)
//   DSH_REMOTE_NAMES  the Host names a phone may use (ip:port, pc-name:port …); the first is the one in the QR code.
//                     dsh is started with the same names as --trusted-host, so its own fence lets them in too.
//   DSH_REMOTE_RUN    the launcher's run folder (only this user can read it): dsh-url.json (dsh's login URL) is read from
//                     there, and remote-key (a key for the launcher's own CLI) is written there.
//
// Logging a phone in (the "pairing"):
//  1. The page on the PC itself (127.0.0.1, logged in to dsh) asks POST /m/remote/pair. Only a request that came in on the
//     127.0.0.1 listener with a loopback Host is answered; from a phone it is refused. The answer is a one-time link
//     http://<lan>/m/pair.html#c=<code> (128 random bits, 3 minutes, one at a time: a new one cancels the last) and its QR.
//  2. The phone opens it. pair.js sends the code (from after "#", so no server log has it) in POST /m/remote/claim.
//  3. This relay checks the code (unused, not expired), forgets it, and logs the phone in to dsh for it: it asks dsh's "/"
//     with dsh's login token (from dsh-url.json; it never leaves this PC) and the phone's Host, and hands the phone the
//     login cookie dsh answered with (bound by dsh to that Host). The phone then opens /m/.
//  Only a hash of the code is kept, in memory. Neither the code nor the token is written anywhere.
//
// 11/16 (本人の決定): each phone's login lasts 30 days from its pairing, and the PC can take it back.
//  - On claim the phone also gets this relay's own device cookie (sync_dev, random, HttpOnly). Only its sha256 is kept, in
//    RUN/remote-devices.json with the device's name (from its User-Agent), when it paired, when it was last used and when it
//    ends. To go on after 30 days the phone scans a new QR code on the PC (a new pairing starts a new 30 days).
//  - On the LAN / Tailscale listener every request but the pairing page and its files needs a live device cookie; one that
//    is missing, ended or taken back gets 401 (a page load: 303 to pair.html#expired). The 127.0.0.1 listener (the PC itself,
//    and a tunnel) is not touched.
//  - GET /m/remote/me (the phone): the days left; the page shows a band when 7 days or fewer are left (device-banner.js).
//  - GET /m/remote/devices, POST /m/remote/revoke {id} | {all: true}: the PC page only (like the QR code).
//  DSH_DEVICE_TTL_S changes the 30 days (only for trying it; 5 s at least).
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { qrMatrix } from "./remote-qr.mjs";

const MODE = ["lan", "tailscale"].includes(process.env.DSH_REMOTE_MODE) ? process.env.DSH_REMOTE_MODE : "off";
const split = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const BIND = MODE === "off" ? [] : split(process.env.DSH_REMOTE_BIND).filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip !== "0.0.0.0" && !ip.startsWith("127."));
const NAMES = BIND.length ? split(process.env.DSH_REMOTE_NAMES).filter((n) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:\d{1,5}$/.test(n)) : [];
const RUN = process.env.DSH_REMOTE_RUN || "";
// 3 minutes. DSH_PAIR_TTL_S changes it (only for trying the expiry; 5 s at least)
const TTL_MS = Math.max(5, Number(process.env.DSH_PAIR_TTL_S) || 180) * 1000;
const DEVICE_MS = Math.max(5, Number(process.env.DSH_DEVICE_TTL_S) || 30 * 86400) * 1000;   // 11/16: a phone's login, 30 days
const WARN_MS = 7 * 86400 * 1000;                                                            // the band from 7 days left
const DAY_MS = 86400 * 1000;
const REMOTE = Symbol("remote listener");

let C = null;                 // what server.mjs hands over in start()
const listeners = [];         // {ip, up, error}
let pairing = null;           // {hash, until}
let localKey = null;          // for the launcher's CLI (sync remote-url --pair)
const fails = { n: 0, since: 0 };
let pairedAt = 0;          // when a phone last logged in with a code (the PC page shows "connected")

const LOOP = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const hostOf = (req) => String(req.headers.host || "").toLowerCase();
const loopHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);
// a request from the PC itself: on the 127.0.0.1 listener, from a loopback address, with a loopback Host
export const isLocal = (req) => !req[REMOTE] && LOOP.test(String(req.socket.remoteAddress || "")) && loopHost(hostOf(req));

// ---- 11/16: the phones logged in (device cookies) ----
const DEVICES_FILE = RUN ? path.join(RUN, "remote-devices.json") : "";
let devices = [];        // {id: sha256 hex of the cookie, name, created, last_used, expires}
let savedAt = 0;
function loadDevices() {
  if (!DEVICES_FILE) return;
  try { const d = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")); devices = Array.isArray(d.devices) ? d.devices : []; } catch { devices = []; }
}
function saveDevices() {
  if (!DEVICES_FILE) return;
  savedAt = Date.now();
  try {
    fs.writeFileSync(DEVICES_FILE + ".tmp", JSON.stringify({ devices }, null, 1), { mode: 0o600 });
    fs.renameSync(DEVICES_FILE + ".tmp", DEVICES_FILE);
  } catch { /* kept in memory */ }
}
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
function cookieOf(req) {
  const m = /(?:^|;\s*)sync_dev=([A-Za-z0-9_-]{20,64})/.exec(String(req.headers.cookie || ""));
  return m ? m[1] : null;
}
function deviceOf(req) {
  const c = cookieOf(req);
  if (!c) return { state: "none" };
  const id = hex(c);
  const d = devices.find((x) => x.id === id);
  if (!d) return { state: "revoked" };
  if (Date.now() >= d.expires) return { state: "expired", d };
  return { state: "ok", d };
}
function nameOf(ua) {
  ua = String(ua || "");
  const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /CriOS|Chrome\//.test(ua) ? "Chrome"
    : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [dev, br].filter(Boolean).join(" · ") || "?";
}
const daysLeft = (d) => Math.max(0, Math.ceil((d.expires - Date.now()) / DAY_MS));
// what a phone may load without a live device cookie: the pairing page and the files it needs
const OPEN = /^\/m\/(pair\.html|pair\.js|i18n\.js|lang-[a-z]+\.json|app\.css|remote\.css|icon[\w.-]*|apple-touch-icon\.png|[\w-]+\.ttf|version|remote\/claim|remote\/me)$/;
function gate(req) {   // null: pass; otherwise why not
  const p = String(req.url || "").split("?")[0];
  if (OPEN.test(p)) return null;
  const v = deviceOf(req);
  if (v.state === "ok") {
    v.d.last_used = Date.now();
    if (Date.now() - savedAt > 60000) saveDevices();
    return null;
  }
  return v.state;
}
function refuse(req, res, why) {
  const page = /text\/html/.test(String(req.headers.accept || "")) && req.method === "GET";
  if (page) {
    res.writeHead(303, { location: "/m/pair.html#expired", "cache-control": "no-store" });
    return res.end();
  }
  res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  return res.end(JSON.stringify({ ok: false, auth: false, device: why }));
}

export function start(ctx) {
  C = ctx;
  if (MODE === "off") return;
  if (!BIND.length || !NAMES.length) {
    console.log(`dsh mobile: スマホの接続（${MODE}）の番地が渡されていないので，127.0.0.1 だけで待ち受けます`);
    return;
  }
  for (const n of NAMES) ctx.allowed.add(n);
  loadDevices();
  const onRequest = ctx.server.listeners("request").slice();
  const onUpgrade = ctx.server.listeners("upgrade").slice();
  for (const ip of BIND) {
    const rec = { ip, up: false, error: null };
    listeners.push(rec);
    const s = http.createServer();
    // on this listener only the names given for it pass (not a loopback Host); then the same handlers as on 127.0.0.1
    s.on("request", (req, res) => {
      req[REMOTE] = true;
      if (!NAMES.includes(hostOf(req))) {
        res.writeHead(421, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        return res.end(JSON.stringify({ ok: false, error: "この名前（Host）では受け付けていません" }));
      }
      const why = gate(req);    // 11/16: a phone's login (30 days, can be taken back)
      if (why) { ctx.logAccess(req, res); return refuse(req, res, why); }
      for (const f of onRequest) f.call(ctx.server, req, res);
    });
    s.on("upgrade", (req, socket, head) => {
      req[REMOTE] = true;
      socket.on("error", () => socket.destroy());
      if (!NAMES.includes(hostOf(req))) return socket.end("HTTP/1.1 421 Misdirected Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      if (gate(req)) return socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      for (const f of onUpgrade) f.call(ctx.server, req, socket, head);
    });
    s.on("error", (e) => { rec.up = false; rec.error = e.code || e.message; console.log(`dsh mobile: ${ip}:${ctx.port} で待ち受けられません（${rec.error}）`); });
    s.listen(ctx.port, ip, () => { rec.up = true; console.log(`dsh mobile: スマホの接続（${MODE}）: http://${ip}:${ctx.port}/m/`); });
  }
  if (RUN) {
    localKey = crypto.randomBytes(24).toString("base64url");
    try { fs.writeFileSync(path.join(RUN, "remote-key"), localKey, { mode: 0o600 }); } catch { localKey = null; }
  }
}

function keyOk(req) {
  const k = String(req.headers["x-sync-remote-key"] || "");
  if (!localKey || !k) return false;
  const a = Buffer.from(k), b = Buffer.from(localKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// the PC page (dsh login cookie, x-dsh-mobile on a POST) or the launcher's CLI (the key file)
async function localAuth(req, post) {
  if (!isLocal(req)) return false;
  if (keyOk(req)) return true;
  if (post && req.headers["x-dsh-mobile"] !== "1") return false;
  return C.dshCookieOk(req, post);
}

const sha = (s) => crypto.createHash("sha256").update(s).digest();

function statusView(local) {
  const out = { ok: true, mode: MODE, local };
  if (!local) return out;   // a phone learns the mode only
  return { ...out, port: C.port, listening: listeners.map((l) => ({ ip: l.ip, up: l.up, error: l.error })),
    urls: NAMES.map((n) => `http://${n}/m/`), encrypted: MODE === "tailscale", paired_at: pairedAt || null,
    launcher: !!process.env.SYNC_LAUNCHER };
}

function readBody(req, max = 4096) {
  return new Promise((resolve) => {
    let n = 0;
    const parts = [];
    req.on("data", (c) => { n += c.length; if (n <= max) parts.push(c); });
    req.on("end", () => resolve(n > max ? null : Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function dshToken() {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(RUN, "dsh-url.json"), "utf8")).url || "";
    const m = /[?&]token=([^&#\s]+)/.exec(u);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

// dsh's "/" with its token and the phone's Host: dsh answers 303 with its login cookie for that Host
function dshLogin(host, token) {
  return new Promise((resolve) => {
    const q = http.request({ ...C.dsh, method: "GET", path: `/?token=${encodeURIComponent(token)}`, headers: { host } }, (r) => {
      r.resume();
      const sc = r.headers["set-cookie"];
      resolve(r.statusCode === 303 && sc && sc.length ? sc : null);
    });
    q.on("error", () => resolve(null));
    q.setTimeout(5000, () => q.destroy());
    q.end();
  });
}

// sync remote-url --json, through the launcher that started this relay (no secrets in its answer)
function launcherCheck() {
  if (!process.env.SYNC_LAUNCHER) return Promise.resolve(null);
  return new Promise((resolve) => execFile(process.env.SYNC_PYTHON || "python", ["-X", "utf8", process.env.SYNC_LAUNCHER, "remote-url", "--json"],
    { windowsHide: true, timeout: 20000, encoding: "utf8" }, (err, out) => {
      try {
        const v = JSON.parse(String(out || "").trim().split(/\r?\n/).pop());
        resolve({ setting: v.setting, live: v.live, problem: v.problem, urls: v.urls });
      } catch { resolve(null); }
    }));
}

// POST /m/settings (server.mjs hands it here first): a change of lan_remote only from the PC itself (127.0.0.1 listener,
// loopback Host). A phone, on the LAN, over Tailscale or through a tunnel, must not cut its own way or open another.
// The body is read here and replayed to the relay's own settingsRoute, so the other settings go through unchanged.
export async function settingsGuard(req, res, next) {
  const raw = await readBody(req, 16384);
  let body = null;
  try { body = JSON.parse(raw || "null"); } catch { body = null; }
  if (body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "lan_remote") && !isLocal(req)) {
    C.logAccess(req, res);
    return C.sendJson(res, { ok: false, error: "スマホの接続は PC の画面か sync settings で変えてください" }, 403);
  }
  const again = Readable.from(raw == null ? [Buffer.alloc(16385)] : [Buffer.from(raw, "utf8")]);
  for (const k of ["method", "url", "headers", "rawHeaders", "httpVersion", "socket", REMOTE]) again[k] = req[k];
  return next(again, res);
}

export async function route(req, res, url, name) {
  const send = C.sendJson;
  if (name === "remote/status" && req.method === "GET") {
    if (await localAuth(req, false)) {
      C.logAccess(req, res);
      const v = statusView(true);
      // ?check=1 (the PC page, not the CLI's key): what the launcher sees now (setting, Tailscale, whether dsh must restart)
      if (url.searchParams.get("check") === "1" && !keyOk(req)) v.check = await launcherCheck();
      return send(res, v);
    }
    if (!(await C.dshCookieOk(req))) { C.logAccess(req, res); return send(res, { ok: false, auth: false }, 401); }
    C.logAccess(req, res);
    return send(res, statusView(false));
  }
  if (name === "remote/me" && req.method === "GET") {         // 11/16: the phone asks how long its login lasts
    if (!req[REMOTE]) return send(res, { ok: true, remote: false });
    const v = deviceOf(req);
    if (v.state !== "ok") return send(res, { ok: false, auth: false, device: v.state }, 401);
    return send(res, { ok: true, remote: true, days_left: daysLeft(v.d), expires_at: v.d.expires, warn: v.d.expires - Date.now() <= WARN_MS });
  }
  if (name === "remote/devices" && req.method === "GET") {    // 11/16: the PC page lists the phones (never a phone)
    if (!(await localAuth(req, false))) return send(res, { ok: false, error: "この PC の画面からだけ見られます" }, 403);
    C.logAccess(req, res);
    return send(res, { ok: true, days: Math.round(DEVICE_MS / DAY_MS), warn_days: 7,
      devices: devices.map((d) => ({ id: d.id.slice(0, 16), name: d.name, created: d.created, last_used: d.last_used, expires: d.expires,
        days_left: daysLeft(d), expired: Date.now() >= d.expires, warn: d.expires - Date.now() <= WARN_MS })) });
  }
  if (req.method !== "POST") return send(res, { ok: false, error: "not found" }, 404);
  C.logAccess(req, res);   // the path only; the code and the link are in the bodies, never logged
  if (name === "remote/pair") {
    if (!(await localAuth(req, true))) return send(res, { ok: false, error: "この PC の画面からだけ出せます" }, 403);
    if (MODE === "off" || !listeners.some((l) => l.up)) return send(res, { ok: false, error: "スマホの接続は待ち受けていません" }, 409);
    const code = crypto.randomBytes(16).toString("base64url");
    pairing = { hash: sha(code), until: Date.now() + TTL_MS };
    const link = `http://${NAMES[0]}/m/pair.html#c=${code}`;
    const q = qrMatrix(link);
    return send(res, { ok: true, url: link, expires_in: Math.round(TTL_MS / 1000), qr: { size: q.size, rows: q.rows } });
  }
  if (name === "remote/revoke") {      // 11/16: take a phone's login back (the PC page only); it stops at its next request
    if (!(await localAuth(req, true))) return send(res, { ok: false, error: "この PC の画面からだけ取り消せます" }, 403);
    let body = null;
    try { body = JSON.parse((await readBody(req)) || "null"); } catch { body = null; }
    const before = devices.length;
    if (body && body.all === true) devices = [];
    else if (body && typeof body.id === "string" && /^[0-9a-f]{16}$/.test(body.id)) devices = devices.filter((d) => !d.id.startsWith(body.id));
    else return send(res, { ok: false, error: "id か all が要ります" }, 400);
    saveDevices();
    return send(res, { ok: true, removed: before - devices.length });
  }
  if (name === "remote/claim") {
    if (MODE === "off") return send(res, { ok: false, error: "スマホの接続は切ってあります" }, 404);
    if (fails.n >= 20 && Date.now() - fails.since < 60000) return send(res, { ok: false, error: "too many tries; wait a minute" }, 429);
    let body = null;
    try { body = JSON.parse((await readBody(req)) || "null"); } catch { body = null; }
    const code = body && typeof body.c === "string" ? body.c : "";
    const p = pairing;
    const good = !!p && /^[A-Za-z0-9_-]{22}$/.test(code) && crypto.timingSafeEqual(sha(code), p.hash);
    if (!good || Date.now() > p.until) {
      if (good) pairing = null;
      if (Date.now() - fails.since > 60000) { fails.n = 0; fails.since = Date.now(); }
      fails.n++;
      return send(res, { ok: false, expired: true, error: "This code is used or expired" }, 403);
    }
    pairing = null;   // once only, even if the login below fails
    const token = dshToken();
    const cookies = token ? await dshLogin(hostOf(req), token) : null;
    if (!cookies) return send(res, { ok: false, error: "dsh did not log the phone in" }, 502);
    pairedAt = Date.now();
    // 11/16: this relay's own device cookie (30 days from now); only its hash is kept
    const dev = crypto.randomBytes(24).toString("base64url");
    devices.push({ id: hex(dev), name: nameOf(req.headers["user-agent"]), created: pairedAt, last_used: pairedAt, expires: pairedAt + DEVICE_MS });
    saveDevices();
    res.setHeader("set-cookie", [...cookies, `sync_dev=${dev}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(DEVICE_MS / 1000)}`]);
    return send(res, { ok: true });
  }
  if (name === "remote/apply") {
    // restart dsh and this relay with the setting now in settings.json (the launcher does it; this relay ends on the way)
    if (!(await localAuth(req, true))) return send(res, { ok: false, error: "この PC の画面からだけ切り替えられます" }, 403);
    if (!process.env.SYNC_LAUNCHER) return send(res, { ok: false, error: "この中継は起動の道具から起こされていません" }, 404);
    send(res, { ok: true });
    setTimeout(() => {
      const c = spawn(process.env.SYNC_PYTHON || "python", ["-X", "utf8", process.env.SYNC_LAUNCHER, "remote-apply"], { stdio: "ignore", windowsHide: true, detached: true });
      c.unref();
    }, 300);
    return;
  }
  return send(res, { ok: false, error: "not found" }, 404);
}
