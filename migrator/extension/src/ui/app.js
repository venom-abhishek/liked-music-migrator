// App shell: the top navigation, the Home screen, and switching between the
// three main screens (My music, Bring songs in, History). The screens
// themselves live in library.js, import-wizard.js and history.js.

import { h, icon, mount } from "./dom.js";
import { connectionCard } from "./connection.js";
import { initLibrary, showLibrary } from "./library.js";
import { initImportWizard, showImportWizard, importIsBusy } from "./import-wizard.js";
import { initHistory, showHistory, recentActivity } from "./history.js";

const VIEWS = ["home", "library", "import", "history"];
const containers = {};
let currentView = null;

function navigate(view) {
  if (!VIEWS.includes(view)) view = "home";
  currentView = view;
  for (const v of VIEWS) containers[v].hidden = v !== view;
  document.querySelectorAll("[data-nav]").forEach((b) => {
    const active = b.dataset.nav === view;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  if (view === "home") showHome();
  if (view === "library") showLibrary();
  if (view === "import") showImportWizard();
  if (view === "history") showHistory();
  window.scrollTo(0, 0);
}

async function showHome() {
  const root = containers.home;
  const bigCard = (view, iconName, title, text) =>
    h("button", { class: "home-card", onclick: () => navigate(view) }, h("div", { class: "home-card-icon" }, icon(iconName)), h("strong", {}, title), h("span", { class: "muted" }, text), h("span", { class: "home-card-go" }, "Start ", icon("forward")));

  const recent = h("div", { class: "recent" });
  mount(
    root,
    h("div", { class: "hero" }, h("h1", {}, "What would you like to do?"), h("p", { class: "muted lead" }, "Everything here works with the YouTube Music you're already signed in to. Nothing changes without asking you first, and anything can be undone.")),
    connectionCard("youtube"),
    h(
      "div",
      { class: "home-grid" },
      bigCard("import", "download", "Bring songs in", "Copy your liked songs and playlists from JioSaavn or Amazon Music into YouTube Music."),
      bigCard("library", "music", "Tidy up my music", "Look through your playlists and Liked songs. Move, remove or un-like songs in bulk.")
    ),
    recent
  );
  try {
    const rows = await recentActivity(3);
    if (rows.length) {
      mount(recent, h("div", { class: "row-between" }, h("h3", {}, "Recent changes"), h("button", { class: "link-btn", onclick: () => navigate("history") }, "See all ", icon("forward"))), h("div", { class: "recent-list" }, rows));
    }
  } catch (_e) {
    // history is optional on the home screen
  }
}

function init() {
  for (const v of VIEWS) containers[v] = document.getElementById(`view-${v}`);
  initLibrary(containers.library);
  initImportWizard(containers.import, { navigate });
  initHistory(containers.history);

  document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.nav)));
  window.addEventListener("hashchange", () => {
    const v = location.hash.slice(1);
    if (v !== currentView) navigate(v);
  });
  // Closing the tab mid-import would stop it halfway; ask first.
  window.addEventListener("beforeunload", (e) => {
    if (importIsBusy()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  navigate(location.hash.slice(1) || "home");
}

init();
