// Syntax-checks every extension JavaScript file (`npm run check`).
// Not a linter or type check; it catches files that wouldn't even load.
// (Adapted from the 2026-10 ChatGPT review's scripts/check.mjs.)
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let n = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(p)) {
      execFileSync(process.execPath, ["--check", p]);
      n++;
    }
  }
}
walk(root);
console.log(`All ${n} JavaScript files parse.`);
