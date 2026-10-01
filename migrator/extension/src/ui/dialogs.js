// In-page dialogs and toasts, replacing the browser's alert/confirm/prompt
// boxes (which look like error popups, can't explain anything, and can't be
// styled). Every dialog is keyboard-usable: Esc cancels, Enter confirms,
// focus starts on the safe choice for dangerous actions.

import { h, icon, button } from "./dom.js";

const dialogRoot = () => document.getElementById("dialog-root");
const toastRoot = () => document.getElementById("toast-root");

/**
 * Generic modal. `render(close)` returns the body; `actions` are buttons.
 * Resolves with whatever value close() is called with (undefined on Esc).
 */
export function openDialog({ title, iconName, tone = "neutral", body, actions = [], wide = false, focusIndex }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const backdrop = h("div", { class: "dialog-backdrop" });
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(value);
    };
    const buttons = actions.map((a) =>
      button(a.label, { kind: a.kind || "secondary", iconName: a.iconName, onClick: () => close(a.value) })
    );
    const dialog = h(
      "div",
      { class: `dialog${wide ? " dialog-wide" : ""} tone-${tone}`, role: "dialog", "aria-modal": "true", "aria-labelledby": "dialog-title" },
      h(
        "div",
        { class: "dialog-head" },
        iconName ? h("div", { class: `dialog-icon tone-${tone}` }, icon(iconName)) : null,
        h("h2", { id: "dialog-title" }, title)
      ),
      h("div", { class: "dialog-body" }, typeof body === "function" ? body(close) : body),
      buttons.length ? h("div", { class: "dialog-actions" }, buttons) : null
    );
    backdrop.append(dialog);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close(undefined);
    });
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(undefined);
      } else if (e.key === "Tab") {
        // keep focus inside the dialog
        const focusable = [...dialog.querySelectorAll("button, input, select, textarea, a[href]")].filter((x) => !x.disabled);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    dialogRoot().append(backdrop);
    const input = dialog.querySelector("input[type=text]");
    const target = input || buttons[focusIndex ?? buttons.length - 1];
    if (target) setTimeout(() => target.focus(), 0);
  });
}

/** Yes/no question. Resolves true/false. */
export async function confirmDialog({ title, message, confirmText = "Yes, continue", cancelText = "Cancel", danger = false, details }) {
  const result = await openDialog({
    title,
    iconName: danger ? "alert" : "help",
    tone: danger ? "danger" : "neutral",
    body: h("div", {}, paragraphs(message), details || null),
    actions: [
      { label: cancelText, kind: "ghost", value: false },
      { label: confirmText, kind: danger ? "danger" : "primary", value: true },
    ],
    // For risky actions, start on Cancel so a stray Enter doesn't do damage.
    focusIndex: danger ? 0 : 1,
  });
  return result === true;
}

/** Ask for a line of text. Resolves the trimmed text, or null if cancelled. */
export async function promptDialog({ title, message, label, value = "", placeholder = "", confirmText = "OK" }) {
  const input = h("input", { type: "text", class: "input", value, placeholder, "aria-label": label || title });
  const result = await openDialog({
    title,
    iconName: "plus",
    body: h("div", {}, paragraphs(message), label ? h("label", { class: "field-label" }, label) : null, input),
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      { label: confirmText, kind: "primary", value: "ok" },
    ],
  });
  if (result !== "ok") return null;
  return input.value.trim() || null;
}

/** An explanation with a single OK button. */
export function infoDialog({ title, message, tone = "neutral", iconName = "help", details }) {
  return openDialog({
    title,
    iconName,
    tone,
    body: h("div", {}, paragraphs(message), details || null),
    actions: [{ label: "OK", kind: "primary", value: true }],
  });
}

/** Friendly error with the technical text tucked away. */
export function errorDialog(err, { title = "Something went wrong" } = {}) {
  const { message, fix } = explainError(err);
  return openDialog({
    title,
    iconName: "alert",
    tone: "danger",
    body: h(
      "div",
      {},
      paragraphs(message),
      fix ? h("p", {}, h("strong", {}, "What to do: "), fix) : null,
      h("details", { class: "tech-details" }, h("summary", {}, "Technical details"), h("code", {}, String((err && err.message) || err)))
    ),
    actions: [{ label: "OK", kind: "primary", value: true }],
  });
}

function paragraphs(message) {
  if (!message) return null;
  if (message instanceof Node) return message;
  return String(message)
    .split("\n\n")
    .map((p) => h("p", {}, p));
}

/**
 * Turns the raw error strings the extension produces into plain language.
 * Returns { message, fix }.
 */
export function explainError(err) {
  const raw = String((err && err.message) || err || "");
  if (/No open music\.youtube\.com tab/i.test(raw))
    return { message: "YouTube Music isn't open.", fix: "Open music.youtube.com in a tab, sign in, and try again." };
  if (/__Secure-3PAPISID|Not signed in/i.test(raw))
    return { message: "You're not signed in to YouTube Music.", fix: "Sign in on the YouTube Music tab, then try again." };
  if (/YouTube Music tab isn't responding/i.test(raw))
    return { message: "Your YouTube Music tab stopped responding.", fix: "Reload the YouTube Music tab — or close it and open music.youtube.com again — then try again. If YouTube Music won't load at all, even on its own, wait a while: the problem is on YouTube's side." };
  if (/JioSaavn tab isn't responding/i.test(raw))
    return { message: "Your JioSaavn tab stopped responding.", fix: "Reload the JioSaavn tab, then try again." };
  if (/Receiving end does not exist|Couldn't reach the YouTube Music tab/i.test(raw))
    return { message: "The extension can't talk to your YouTube Music tab yet.", fix: "Reload the YouTube Music tab (press F5 in it), then try again." };
  if (/Couldn't reach the JioSaavn tab/i.test(raw))
    return { message: "The extension can't talk to your JioSaavn tab yet.", fix: "Reload the JioSaavn tab (press F5 in it), then try again." };
  if (/Couldn't reach the Amazon Music tab|capture script isn't running/i.test(raw))
    return { message: "The extension can't talk to your Amazon Music tab yet.", fix: "Reload the Amazon Music tab (press F5 in it), then try again." };
  if (/HTTP 401|HTTP 403/i.test(raw))
    return { message: "The music service said you don't have permission — usually that means you've been signed out.", fix: "Sign in again in that tab, then try again." };
  if (/HTTP 429/i.test(raw))
    return { message: "The music service is asking us to slow down.", fix: "Wait a few minutes, then try again." };
  if (/Failed to fetch|NetworkError|network/i.test(raw))
    return { message: "The connection dropped.", fix: "Check your internet connection, then try again." };
  if (/refused to/i.test(raw)) return { message: raw, fix: "Try again. If it keeps happening, reload the YouTube Music tab." };
  return { message: raw || "An unexpected error happened.", fix: "Try again. If it keeps happening, reload the YouTube Music tab." };
}

/**
 * Small notice in the corner that disappears by itself.
 * `action`: { label, onClick } shows a button (e.g. Undo) until it times out.
 */
export function toast(message, { tone = "neutral", action, duration = 8000 } = {}) {
  const el = h(
    "div",
    { class: `toast tone-${tone}`, role: "status" },
    icon(tone === "success" ? "checkCircle" : tone === "danger" ? "alert" : "help"),
    h("span", { class: "toast-text" }, message)
  );
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.append(
      button(action.label, {
        kind: "ghost",
        size: "sm",
        iconName: action.iconName,
        onClick: async () => {
          dismiss();
          await action.onClick();
        },
      })
    );
  }
  el.append(h("button", { class: "toast-close", "aria-label": "Dismiss", onclick: dismiss }, icon("x")));
  toastRoot().append(el);
  timer = setTimeout(dismiss, duration);
  return dismiss;
}
