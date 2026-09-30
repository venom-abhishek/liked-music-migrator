// "Is X open and signed in?" checks for YouTube Music, JioSaavn and Amazon
// Music, plus the one-click fixes a non-technical user needs when the answer
// is no: open the site, switch to its tab, or reload it. None of these need
// extra permissions — extension pages can always create, focus and reload
// tabs.

import { findYtMusicTab, makeYtMusicClient } from "../ytmusic/client.js";
import { findJioSaavnTab, makeJioSaavnClient } from "../sources/jiosaavnClient.js";
import { findAmazonTab, makeAmazonClient } from "../sources/amazonClient.js";
import { h, icon, button, sleep } from "./dom.js";

export const SERVICES = {
  youtube: {
    name: "YouTube Music",
    url: "https://music.youtube.com/",
    find: findYtMusicTab,
    async probe() {
      const s = await makeYtMusicClient().status();
      return s.signedIn ? "ok" : "signed-out";
    },
  },
  jiosaavn: {
    name: "JioSaavn",
    url: "https://www.jiosaavn.com/",
    find: findJioSaavnTab,
    async probe() {
      await makeJioSaavnClient().ping();
      return "ok";
    },
  },
  amazon: {
    name: "Amazon Music",
    url: "https://music.amazon.in/my/library",
    find: findAmazonTab,
    async probe(tab) {
      await makeAmazonClient(tab.id).getPageInfo();
      return "ok";
    },
  },
};

/**
 * Returns { state, tab } where state is:
 *  "ok" | "missing" (no tab) | "signed-out" | "reload" (tab open but the
 *  extension isn't running in it yet) | "loading" (tab still loading)
 */
export async function checkService(key) {
  const svc = SERVICES[key];
  const tab = await svc.find();
  if (!tab) return { state: "missing", tab: null };
  if (tab.status === "loading") return { state: "loading", tab };
  try {
    const state = await svc.probe(tab);
    return { state, tab };
  } catch (err) {
    const msg = String((err && err.message) || err);
    // An older copy of the page script (from before the extension was
    // updated) doesn't know the status action — it is reachable, though.
    if (/Unknown action/i.test(msg)) return { state: "ok", tab };
    if (/Not signed in|__Secure-3PAPISID/i.test(msg)) return { state: "signed-out", tab };
    return { state: "reload", tab };
  }
}

export async function openService(key) {
  const tab = await chrome.tabs.create({ url: SERVICES[key].url, active: true });
  return tab;
}

export async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null && chrome.windows) await chrome.windows.update(tab.windowId, { focused: true });
}

export async function reloadTab(tab) {
  await chrome.tabs.reload(tab.id);
}

const COPY = {
  ok: (n) => ({ title: `${n} is connected`, text: "Everything's ready.", tone: "success", iconName: "checkCircle" }),
  missing: (n) => ({ title: `${n} isn't open`, text: `Open ${n} in a tab and sign in. Keep that tab open while you use this.`, tone: "warn", iconName: "alert" }),
  "signed-out": (n) => ({ title: `You're not signed in to ${n}`, text: `Sign in on the ${n} tab, then come back here.`, tone: "warn", iconName: "alert" }),
  reload: (n) => ({ title: `${n} needs a quick reload`, text: `The ${n} tab was opened before this extension started. Reloading it fixes that.`, tone: "warn", iconName: "refresh" }),
  loading: (n) => ({ title: `${n} is still loading…`, text: "Give it a moment.", tone: "neutral", iconName: "refresh" }),
};

/**
 * A card showing one service's connection state, with the fix button for
 * that state. Re-checks by itself every few seconds until `stop()` is called
 * (or the card leaves the page), and calls onChange(state) when it changes.
 */
export function connectionCard(key, { onChange, compact = false } = {}) {
  const svc = SERVICES[key];
  const card = h("div", { class: `conn-card${compact ? " compact" : ""}`, "aria-live": "polite" });
  let current = null;
  let stopped = false;
  let busy = false;

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const result = await checkService(key);
      const changed = !current || current.state !== result.state || (current.tab && result.tab && current.tab.id !== result.tab.id);
      current = result;
      if (changed) {
        render();
        onChange && onChange(result.state, result);
      }
    } finally {
      busy = false;
    }
  }

  function render() {
    const { state, tab } = current;
    const c = COPY[state](svc.name);
    const actions = [];
    if (state === "missing") actions.push(button(`Open ${svc.name}`, { kind: "primary", iconName: "external", onClick: () => openService(key).then(() => poll(8)) }));
    if (state === "signed-out") actions.push(button(`Go to ${svc.name} to sign in`, { kind: "primary", iconName: "external", onClick: () => focusTab(tab).then(() => poll(20)) }));
    if (state === "reload")
      actions.push(
        button("Reload it for me", {
          kind: "primary",
          iconName: "refresh",
          onClick: async () => {
            await reloadTab(tab);
            poll(8);
          },
        })
      );
    if (state === "ok" && !compact) actions.push(button("Show tab", { kind: "ghost", size: "sm", iconName: "external", onClick: () => focusTab(tab) }));
    card.className = `conn-card tone-${c.tone}${compact ? " compact" : ""}`;
    card.replaceChildren(
      h("div", { class: "conn-icon" }, icon(c.iconName)),
      h("div", { class: "conn-text" }, h("strong", {}, c.title), compact && state === "ok" ? null : h("span", { class: "muted" }, c.text)),
      actions.length ? h("div", { class: "conn-actions" }, actions) : null
    );
  }

  // Quick re-checks right after the user did something (opened/reloaded a tab).
  async function poll(times) {
    for (let i = 0; i < times && !stopped; i++) {
      await sleep(1500);
      await refresh();
      if (current && current.state === "ok") return;
    }
  }

  card.append(h("div", { class: "conn-icon" }, icon("refresh")), h("div", { class: "conn-text" }, h("strong", {}, `Checking ${svc.name}…`)));
  refresh();
  const timer = setInterval(() => {
    if (stopped || !card.isConnected) {
      clearInterval(timer);
      return;
    }
    // Only re-check while the card is actually on screen (not on a hidden
    // screen, and not while this whole tab is in the background).
    if (card.offsetParent === null || document.hidden) return;
    refresh();
  }, 4000);

  card.stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  card.recheck = refresh;
  card.getState = () => current && current.state;
  return card;
}
