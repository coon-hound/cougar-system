// Static load-time guards — catch the failure class that twice reached prod:
//  (a) a duplicate top-level const across scripts that threw on load and blanked
//      the dashboard, and (b) a write path that forgot to bump the revision.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { suite, test, ok } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const REV_TABS = ["Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC",
  "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts"];

module.exports = async function run() {
  suite("static: load-time guards");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  // All local <script src="js/....js?v=NN"> in document order.
  const scriptRe = /<script\s+src="(js\/[^"?]+)(?:\?v=(\d+))?"><\/script>/g;
  const scripts = [];
  let m;
  while ((m = scriptRe.exec(html)) !== null) scripts.push({ src: m[1], v: m[2] });

  await test("found the frontend scripts in index.html", () => {
    ok(scripts.length >= 6, "expected several js/*.js script tags, got " + scripts.length);
  });

  // (a) Concatenate all scripts in load order and COMPILE as one program — this
  // reproduces the browser's shared global lexical scope, so a duplicate top-level
  // `const`/`let` across files (the STATE_TO_TAB blank-dashboard bug) is an early
  // SyntaxError here. Compile-only: never executes, so browser globals are fine.
  await test("all scripts parse together (no duplicate top-level declarations)", () => {
    const bundle = scripts.map(s => fs.readFileSync(path.join(ROOT, s.src), "utf8")).join("\n;\n");
    new vm.Script(bundle, { filename: "bundle.js" }); // throws on dup const/let or syntax error
  });

  // (b) Every local script must share one cache-busting ?v=NN — a mismatch ships
  // partly-stale JS (e.g. new index.html + old cached api.js).
  await test("all script tags use the same ?v= cache version", () => {
    const versions = [...new Set(scripts.map(s => s.v))];
    ok(scripts.every(s => s.v), "every js script has a ?v= version: " + JSON.stringify(scripts.map(s => s.src + "?v=" + s.v)));
    ok(versions.length === 1, "expected one version across all scripts, found: " + JSON.stringify(versions));
  });

  suite("static: no unbumped tracked-tab writes (heuristic)");

  // (c) Heuristic lint: any DIRECT write primitive called with a tracked-tab
  // STRING LITERAL (i.e. bypassing doPost's withRevLock, which passes `tab` as a
  // variable) must have a bumpRev("<sameTab>") within a few lines — otherwise the
  // change silently misses every client's revCheck (the Telegram leak class).
  await test("direct tracked-tab writes are followed by a bumpRev", () => {
    const gs = fs.readFileSync(path.join(ROOT, "apps-script-Code.gs"), "utf8").split("\n");
    const callRe = /\b(appendRow|appendMany|upsertRow|writeTab|deleteRowById|updateRow)\(\s*"([A-Za-z]+)"/;
    const offenders = [];
    for (let i = 0; i < gs.length; i++) {
      const mm = gs[i].match(callRe);
      if (!mm) continue;
      const tab = mm[2];
      if (REV_TABS.indexOf(tab) === -1) continue;        // untracked tab → irrelevant
      const windowText = gs.slice(i, i + 16).join("\n");  // look ahead (multi-line literal + comments)
      const bumped = new RegExp('bumpRev\\(\\s*"' + tab + '"').test(windowText)
        || /withRevLock\(/.test(gs.slice(Math.max(0, i - 3), i + 1).join("\n"));
      if (!bumped) offenders.push((i + 1) + ": " + gs[i].trim());
    }
    ok(offenders.length === 0, "tracked-tab writes missing a nearby bumpRev:\n   " + offenders.join("\n   "));
  });
};
