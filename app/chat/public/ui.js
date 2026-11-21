// Shared pieces for the screens: bottom sheets that slide in and out (and can be dragged away), a text prompt,
// a yes/no confirmation, a toast, long-press, and the small animation helpers. All motion is skipped when the
// phone asks for reduced motion.
"use strict";

const reducedMotion = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

// A short, human reading of the error codes dsh sends back for the actions on these screens.
function errorText(e) {
  const code = (e && e.code) || "";
  if (code === "session/title-invalid") return tr("That name cannot be used");
  if (code === "workspace/name-conflict") return tr("A workspace with that name already exists");
  if (code === "workspace/invalid-path") return tr("That folder cannot be a workspace");
  if (code === "workspace/session-active") return tr("Something is still running");
  if (code === "directory-picker/unreadable") return tr("That folder cannot be opened");
  if (code === "directory-picker/exists") return tr("A folder with that name already exists");
  if (code === "directory-picker/create-failed") return tr("Could not create the folder");
  if (code === "network") return tr("Cannot reach dsh");
  return (e && (e.message || e.code)) || tr("Failed");
}

function toast(text) {
  const el = h("div", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 3500);
}

// children: nodes for the sheet body. Returns {close, sheet}. Tapping outside, or dragging the grip down, closes it.
function openSheet(children, opts = {}) {
  const grip = h("div", { class: "sheet-grip-zone" }, h("div", { class: "sheet-grip" }));
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", tabindex: "-1" }, grip, children);
  const scrim = h("div", { class: "scrim" }, sheet);
  let closed = false;
  // 11/14: with a keyboard (PC, iPad), Esc closes the sheet on top and the focus goes back to where it was
  const before = document.activeElement;
  const finish = () => {
    scrim.remove();
    const i = sheets.indexOf(entry);
    if (i >= 0) sheets.splice(i, 1);
    // only with a keyboard: on a phone, focusing the box again would bring the on-screen keyboard up
    if (hasKeyboard() && before && before.isConnected && before.focus && !document.querySelector(".scrim")) before.focus({ preventScroll: true });
    if (opts.onClose) opts.onClose();
  };

  // instant: skip the slide-out, used when another sheet opens in its place.
  function close(instant) {
    if (closed) return;
    closed = true;
    if (instant === true || reducedMotion()) return finish();
    scrim.classList.add("closing");
    let done = false;
    const once = () => { if (!done) { done = true; finish(); } };
    sheet.addEventListener("animationend", once, { once: true });
    setTimeout(once, 320);
  }

  // A sheet opened by a long press appears under the finger; the click that follows the release must not close it.
  const openedAt = performance.now();
  scrim.addEventListener("click", (e) => { if (e.target === scrim && performance.now() - openedAt > 400) close(); });

  let startY = null;
  let dy = 0;
  grip.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    dy = 0;
    grip.setPointerCapture(e.pointerId);
    sheet.style.animation = "none";
    sheet.style.transition = "none";
  });
  grip.addEventListener("pointermove", (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const release = () => {
    if (startY == null) return;
    startY = null;
    sheet.style.transition = "transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)";
    if (dy > 90 && !closed) {
      closed = true;
      scrim.classList.add("fading");
      sheet.style.transform = "translateY(100%)";
      setTimeout(finish, 230);
    } else {
      sheet.style.transform = "";
    }
  };
  grip.addEventListener("pointerup", release);
  grip.addEventListener("pointercancel", release);

  const entry = { close: () => close() };
  sheets.push(entry);
  document.body.append(scrim);
  if (hasKeyboard()) setTimeout(() => { if (!closed && !sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true }); }, 0);
  return { close, sheet };
}

// The open sheets, the newest last (Esc closes the newest; app.js asks whether one is open before its own keys).
const sheets = [];
const sheetOpen = () => sheets.length > 0;
// A fine pointer that can hover: a mouse or a trackpad (PC, iPad with one). Used only to choose defaults.
const hasKeyboard = () => !!(window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !sheets.length || e.isComposing) return;
  e.preventDefault();
  sheets[sheets.length - 1].close();
});

// A sheet with one text field. onSubmit(value) may throw: the message is shown under the field and the sheet stays.
function openPrompt({ title, value = "", placeholder = "", okLabel = null, note = "", maxLength = 200, onSubmit }) {
  const input = h("input", { class: "text-input", type: "text", value, placeholder, maxlength: maxLength, enterkeyhint: "done", autocomplete: "off" });
  const err = h("div", { class: "form-error bad hidden" });
  const ok = h("button", { class: "btn primary", type: "button" }, okLabel || tr("Save"));
  async function submit() {
    const v = input.value.trim();
    if (!v || ok.disabled) return;
    ok.disabled = true;
    err.classList.add("hidden");
    try {
      await onSubmit(v);
      s.close();
    } catch (e) {
      err.textContent = errorText(e);
      err.classList.remove("hidden");
      ok.disabled = false;
    }
  }
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
  const s = openSheet([
    h("div", { class: "sheet-title" }, title),
    note ? h("div", { class: "sheet-note muted" }, note) : null,
    input, err,
    h("div", { class: "form-actions" }, h("button", { class: "btn ghost", type: "button", onclick: () => s.close() }, tr("Cancel")), ok),
  ]);
  setTimeout(() => { input.focus(); input.select(); }, 80);
  return s;
}

// Resolves true when the red/blue button is pressed, false on any other way of closing.
function confirmSheet({ title, message = "", okLabel = null, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => { answered = true; resolve(v); s.close(); };
    const s = openSheet([
      h("div", { class: "sheet-title" }, title),
      message ? h("div", { class: "sheet-note muted" }, message) : null,
      h("div", { class: "form-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: () => answer(false) }, tr("Not now")),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "button", onclick: () => answer(true) }, okLabel || tr("OK"))),
    ], { onClose: () => { if (!answered) resolve(false); } });
  });
}

// fn(event) runs after a press held for `ms` without moving; the click that follows the release is swallowed.
function onLongPress(el, fn, ms = 480) {
  let timer = null;
  let fired = false;
  let sx = 0;
  let sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    fired = false;
    sx = e.clientX;
    sy = e.clientY;
    timer = setTimeout(() => { timer = null; fired = true; if (navigator.vibrate) navigator.vibrate(15); fn(e); }, ms);
  });
  el.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(t, clear);
  el.addEventListener("click", (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// Fade an element in while it rises a little (list cards, new messages).
function rise(el, delay = 0) {
  if (reducedMotion() || !el.animate) return;
  el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
    { duration: 280, delay, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 11/14: the page's own settings, kept in this browser (nothing secret). The language is I18n's.
const Prefs = (() => {
  const K = "dsh-mobile-pref-";
  const get = (k) => { try { return localStorage.getItem(K + k); } catch { return null; } };
  const set = (k, v) => { try { if (v == null) localStorage.removeItem(K + k); else localStorage.setItem(K + k, v); } catch { /* private mode */ } };
  const applyText = () => { document.documentElement.dataset.text = ["s", "m", "l"].includes(get("text")) ? get("text") : "auto"; };
  return {
    get, set, applyText,
    // "send" | "newline" | null = auto (Enter sends with a mouse or trackpad: PC, iPad with a keyboard)
    enterSends() { const v = get("enter"); return v === "send" ? true : v === "newline" ? false : hasKeyboard(); },
    // "s" | "m" | "l" | null = auto (s on phone widths, m on wider screens: app.css)
    setText(v) { set("text", v); applyText(); },
  };
})();
