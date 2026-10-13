// DEV ONLY. Serves the extension folder, opens the UI in headless Chromium
// with dev/fake-chrome.js standing in for the real browser APIs and music
// sites, clicks through every screen, and saves screenshots.
//
//   node dev/preview.mjs [outDir]      (needs Playwright installed)
//
// Exits non-zero if the page logged any error.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PW = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(PW);
const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "..");
const out = path.resolve(process.argv[2] || path.join(here, "screenshots"));
fs.mkdirSync(out, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const file = path.join(extRoot, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(extRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/src/ui/index.html`;
const fake = fs.readFileSync(path.join(here, "fake-chrome.js"), "utf8");

const browser = await chromium.launch();
const errors = [];
let shot = 0;

async function open(scenario = {}, { dark = false, width = 1280, height = 860, hash = "" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? "dark" : "light" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${scenario.name || ""}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${scenario.name || ""} console: ${m.text()}`));
  await page.addInitScript(`window.__scenario = ${JSON.stringify(scenario)};`);
  await page.addInitScript(fake);
  await page.goto(base + hash);
  return page;
}
async function snap(page, name, full = false) {
  const file = path.join(out, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: file, fullPage: full });
  console.log("saved", path.basename(file));
}
const clickText = (page, text) => page.getByRole("button", { name: text, exact: false }).first().click();

// ---- Home ----
let page = await open({ name: "home" });
await page.waitForSelector(".conn-card.tone-success");
await snap(page, "home");
await page.close();

page = await open({ name: "home-missing", yt: "missing" });
await page.waitForSelector(".conn-card.tone-warn");
await snap(page, "home-youtube-not-open");
await page.close();

page = await open({ name: "home-dark" }, { dark: true });
await page.waitForSelector(".conn-card.tone-success");
await snap(page, "home-dark");
await page.close();

// ---- My music ----
page = await open({ name: "library" }, { hash: "#library" });
await page.waitForSelector(".playlist-card");
await snap(page, "library-playlists");
await page.locator(".playlist-card", { hasText: "Workout" }).click();
await page.waitForSelector(".track-row");
await page.locator(".track-row").nth(1).click();
await page.locator(".track-row").nth(4).click({ modifiers: ["Shift"] });
await snap(page, "library-detail-selected");
await clickText(page, "Move to");
await page.waitForSelector(".dialog");
await page.locator(".pick-option", { hasText: "A new playlist" }).click();
await page.locator(".new-name input").fill("Gym favourites");
await snap(page, "library-move-dialog");
await page.locator(".dialog button", { hasText: "Move here" }).click();
await page.waitForSelector(".toast.tone-success");
await snap(page, "library-after-move-toast");
await page.locator(".toast button", { hasText: "Undo" }).click();
await page.waitForSelector(".toast >> text=undone");
// remove flow
await page.locator(".track-row").nth(0).click();
await clickText(page, "Remove from playlist");
await page.waitForSelector(".dialog");
await snap(page, "library-remove-confirm");
await page.locator(".dialog button", { hasText: "Remove 1 song" }).click();
await page.waitForSelector(".toast.tone-success");
await page.fill(".search-input", "zzzz");
await snap(page, "library-search-empty");
await page.fill(".search-input", "");
// quick select: duplicates, by artist; save a copy
await page.locator(".quick-select button", { hasText: "Duplicates" }).click();
await page.waitForSelector(".action-bar:not([hidden])");
const dupText = await page.textContent(".action-bar-text");
// (2 planted; earlier steps in this run may have removed one of them)
if (!/[12] songs? selected/.test(dupText)) errors.push(`duplicates selected: ${dupText}`);
await snap(page, "library-duplicates-selected");
await page.locator(".action-bar button", { hasText: "Clear" }).click();
await page.locator(".quick-select button", { hasText: "By artist" }).click();
await page.waitForSelector(".dialog .pick-option");
await page.locator(".dialog .pick-option").nth(0).click();
await snap(page, "library-select-by-artist");
await page.locator(".dialog button", { hasText: "Select their songs" }).click();
await page.waitForSelector(".action-bar:not([hidden])");
await page.locator(".action-bar button", { hasText: "Clear" }).click();
await clickText(page, "Save a copy");
await page.waitForSelector(".dialog");
await snap(page, "library-save-a-copy");
const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".dialog .choice-card", { hasText: "Backup file" }).click()]);
const backupPath = path.join(out, "workout-backup.json");
await download.saveAs(backupPath);
await page.close();

page = await open({ name: "liked-dark" }, { dark: true, hash: "#library" });
await page.waitForSelector(".playlist-card");
await page.locator(".playlist-card.liked").click();
await page.waitForFunction(() => document.querySelectorAll(".track-row").length > 5);
await page.locator(".select-all-row input").check();
await snap(page, "library-liked-dark-all-selected");
await page.close();

// ---- Bring songs in: JioSaavn ----
page = await open({ name: "import" }, { hash: "#import" });
await page.waitForSelector(".choice-card");
await snap(page, "import-1-choose-app");
await page.locator(".choice-card", { hasText: "JioSaavn" }).click();
await page.waitForFunction(() => document.querySelectorAll(".conn-card.tone-success").length === 2);
await snap(page, "import-2-connect");
await clickText(page, "Continue");
await page.waitForSelector(".pick-option");
await snap(page, "import-3-pick-songs");
await clickText(page, "Find these songs");
await page.waitForSelector(".progress");
await page.waitForTimeout(700);
await snap(page, "import-4-matching");
await page.waitForSelector(".stat-grid", { timeout: 60000 });
await snap(page, "import-5-review-ready", true);
await page.locator(".stat-tile", { hasText: "Please check" }).click();
await snap(page, "import-5-review-check", true);
await page.locator(".stat-tile", { hasText: "Not found" }).click();
await snap(page, "import-5-review-missing");
await clickText(page, "Continue with");
await page.waitForSelector(".radio-card");
await snap(page, "import-6-destination");
await page.locator(".wizard-nav .btn-primary").click();
await page.waitForSelector(".dialog");
await snap(page, "import-7-confirm");
await page.locator(".dialog button", { hasText: "Yes, add them" }).click();
await page.waitForSelector(".done-screen", { timeout: 60000 });
await snap(page, "import-8-done");
// ---- History ----
await page.locator('.tabs [data-nav="history"]').click();
await page.waitForSelector(".history-card");
await snap(page, "history", true);
await page.close();

// ---- Restore from the backup saved above ----
page = await open({ name: "backup" }, { hash: "#import" });
await page.locator(".choice-card", { hasText: "backup" }).click();
await page.waitForSelector(".conn-card.tone-success");
await clickText(page, "Continue");
await page.setInputFiles("#backup-file", backupPath);
await page.waitForSelector(".resume-card");
await snap(page, "backup-3-file-chosen");
await clickText(page, "Bring back");
await page.waitForSelector(".stat-grid");
await clickText(page, "Continue with");
await page.waitForSelector(".radio-card");
await snap(page, "backup-6-destination");
await page.close();

// ---- Resume an unfinished import ----
page = await open({ name: "resume" }, { hash: "#import" });
await page.locator(".choice-card", { hasText: "JioSaavn" }).click();
await page.waitForFunction(() => document.querySelectorAll(".conn-card.tone-success").length === 2);
await clickText(page, "Continue");
await page.waitForSelector(".pick-option");
await clickText(page, "Find these songs");
await page.waitForFunction(() => /^(2\d|[3-9]\d) of/.test(document.querySelector(".progress-count")?.textContent || ""));
await clickText(page, "Stop");
await page.waitForSelector(".stat-grid");
await page.waitForTimeout(900); // let the draft save
await page.reload();
await page.waitForSelector(".resume-card");
await snap(page, "resume-banner");
await page.locator(".resume-card button", { hasText: "Continue" }).click();
await page.waitForSelector(".stat-grid", { timeout: 60000 });
const total = await page.$$eval(".stat-num", (els) => els.reduce((n, e) => n + Number(e.textContent.replace(/\D/g, "")), 0));
if (total !== 67) errors.push(`resume: expected all 67 songs checked, got ${total}`);
await clickText(page, "Continue with");
await page.locator(".wizard-nav .btn-primary").click();
await page.locator(".dialog button", { hasText: "Yes, add them" }).click();
await page.waitForSelector(".done-screen", { timeout: 60000 });
const [report] = await Promise.all([page.waitForEvent("download"), clickText(page, "Save a report")]);
const reportText = fs.readFileSync(await report.path(), "utf8");
if (!/What happened/.test(reportText) || reportText.trim().split("\n").length !== 68) errors.push("report: unexpected contents");
await page.close();

// ---- Amazon path ----
page = await open({ name: "amazon" }, { hash: "#import" });
await page.locator(".choice-card", { hasText: "Amazon" }).click();
await page.waitForFunction(() => document.querySelectorAll(".conn-card.tone-success").length === 2);
await clickText(page, "Continue");
await page.waitForSelector(".howto");
await page.waitForTimeout(300);
await snap(page, "amazon-3-instructions", true);
await clickText(page, "Read the songs from Amazon");
await page.waitForSelector(".wizard-nav >> text=Read another list");
const foundTitle = await page.textContent(".wizard-body h2");
if (!/Found 23 songs in "Gym Mix"/.test(foundTitle)) errors.push(`amazon found: ${foundTitle}`);
await snap(page, "amazon-3b-found");
await clickText(page, "Find 23 songs");
await page.waitForSelector(".stat-grid", { timeout: 60000 });
await clickText(page, "Continue with");
await snap(page, "amazon-6-destination");
await page.close();

// ---- A list of songs (any app) ----
page = await open({ name: "list" }, { hash: "#import" });
await page.locator(".choice-card", { hasText: "A list of songs" }).click();
await page.waitForSelector(".conn-card.tone-success");
await clickText(page, "Continue");
await page.waitForSelector(".list-input");
const copied = ["Gym Mix", "Playlist", "Play", "1", "Tum Hi Ho", "Arijit Singh", "Aashiqui 2", "4:22", "2", "Yellow", "Coldplay", "Parachutes", "4:26", "3", "Blinding Lights", "E", "The Weeknd", "After Hours", "3:20"].join("\n");
await page.fill(".list-input", copied);
await page.fill('input[aria-label="Name for this list"]', "Gym Mix");
await clickText(page, "Read the list");
await page.waitForSelector(".list-preview");
await snap(page, "list-3-preview", true);
await clickText(page, "Find 3 songs");
await page.waitForSelector(".stat-grid", { timeout: 60000 });
await page.close();

// ---- Problems ----
page = await open({ name: "reload", yt: "reload" }, { hash: "#library" });
await page.waitForSelector(".conn-card.tone-warn");
await page.waitForTimeout(300);
await snap(page, "problem-youtube-needs-reload");
await page.close();

page = await open({ name: "frozen", yt: "frozen" }, { hash: "#library" });
await page.waitForSelector(".conn-card.tone-warn", { timeout: 15000 });
await snap(page, "problem-youtube-not-responding");
await page.close();

page = await open({ name: "mobile" }, { width: 420, height: 860, hash: "#library" });
await page.waitForSelector(".playlist-card");
await page.locator(".playlist-card", { hasText: "Chill" }).click();
await page.waitForSelector(".track-row");
await page.locator(".track-row").nth(0).click();
await snap(page, "narrow-window-detail");
await page.close();

await browser.close();
server.close();
if (errors.length) {
  console.error("PAGE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no page errors");
