#!/usr/bin/env node
// ============================================================================
// Point-in-time backup of the LIVE Google Sheet, pulled through the live API.
//
// This is the safety net for the Postgres cutover: run it immediately before
// scripts/migrate-from-sheets.mjs, keep the directory until the new backend has
// been trusted for a while.
//
// WHAT IT CAPTURES
//   - every tab the backend reports, not just the 16 the migration imports.
//     "Conduct Master", "Sheet3" and "notes" carry no app data and are
//     deliberately NOT migrated — which is exactly why a backup must still hold
//     them. Scope of the import is not scope of the backup.
//   - the readAll envelope, the per-tab revisions, and the build stamp, so the
//     backup identifies the precise state of the backend it came from.
//
// WHY THROUGH THE API AND NOT THE XLSX EXPORT
//   Same reason migrate-from-sheets.mjs does it: the xlsx renders the numeric
//   `d4` cells as "1101.0", which padD4 does not normalise, so a restore from
//   the export would silently break every join. getValues() coerces first.
//
// FORMAT
//   <out>/tabs/<Tab>.json   array of row objects — the exact shape `write`
//                           accepts, so a restore is a POST per tab, no
//                           transformation. A .csv sits beside each one for
//                           reading without tooling.
//   <out>/readAll.json      the readAll envelope as served
//   <out>/manifest.json     source, build, revisions, per-tab row count +
//                           column list + sha256 of the JSON
//
// The default destination is OUTSIDE the repository. This is real personnel
// data and the repo is public.
//
// Usage:
//   COUGAR_AUTH=<token> node scripts/backup-sheets.mjs [--out DIR]
//   node scripts/backup-sheets.mjs --token-file ~/.cougar-token
//   node scripts/backup-sheets.mjs --verify ~/cougar-backups/<stamp>
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// The production deployment, same constant the app ships with (js/state.js:8).
const DEFAULT_URL =
  "https://script.google.com/macros/s/AKfycbzazMTu4y4XjjDXBGWN_aAE51fzP_z23zQUZnuKjWWPJ3fNNjUPbp3DbZW9T66OQysr/exec";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const VERIFY_DIR = flag("--verify");
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || DEFAULT_URL;
const TOKEN_FILE = flag("--token-file");
const COUGAR_AUTH =
  process.env.COUGAR_AUTH ||
  (TOKEN_FILE ? fs.readFileSync(TOKEN_FILE.replace(/^~/, os.homedir()), "utf8").trim() : "");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ─── verify mode: re-check an existing backup against its own manifest ──────
// A backup nobody has ever read back is a hope, not a backup.
if (VERIFY_DIR) {
  const dir = VERIFY_DIR.replace(/^~/, os.homedir());
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  let bad = 0;
  for (const t of manifest.tabs) {
    const file = path.join(dir, "tabs", `${t.file}`);
    if (!fs.existsSync(file)) { console.log(`  MISSING  ${t.tab}`); bad++; continue; }
    const raw = fs.readFileSync(file, "utf8");
    const rows = JSON.parse(raw);
    const okSum = sha256(raw) === t.sha256;
    const okCount = rows.length === t.rows;
    console.log(`  ${okSum && okCount ? "ok " : "BAD"}      ${t.tab.padEnd(16)} ${String(rows.length).padStart(5)} rows`);
    if (!okSum || !okCount) bad++;
  }
  console.log(`\n${manifest.tabs.length - bad}/${manifest.tabs.length} tabs verify against the manifest.`);
  process.exit(bad ? 1 : 0);
}

if (!COUGAR_AUTH) {
  console.error(
    "Missing auth token.\n" +
    "  COUGAR_AUTH=<token> node scripts/backup-sheets.mjs\n" +
    "or\n" +
    "  node scripts/backup-sheets.mjs --token-file ~/.cougar-token\n\n" +
    "Any device already signed in has one: DevTools console →\n" +
    "  localStorage.getItem(\"cougar-auth\")"
  );
  process.exit(1);
}

// Apps Script is slow and occasionally flaky under load; a backup that gives up
// on one 500 is worse than useless, so every call retries with backoff.
async function api(action, tab = "", tries = 4) {
  const url =
    `${APPS_SCRIPT_URL}?action=${action}` +
    (tab ? `&tab=${encodeURIComponent(tab)}` : "") +
    `&auth=${encodeURIComponent(COUGAR_AUTH)}`;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); }
      catch { throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 120)}`); }
      // The backend answers 200 with an {error} body — see the always-200
      // invariant the whole protocol is built on.
      if (body && body.error) throw new Error(body.error);
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        const wait = 2 ** attempt * 1000;
        process.stdout.write(`  retry ${attempt}/${tries - 1} in ${wait / 1000}s (${err.message})\n`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

const toCsv = (rows) => {
  if (!rows.length) return "";
  const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set())];
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
const OUT = (flag("--out") || path.join(os.homedir(), "cougar-backups", stamp)).replace(/^~/, os.homedir());

if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) {
  console.error(`Refusing to write into a non-empty directory: ${OUT}`);
  process.exit(1);
}

console.log(`Backing up ${APPS_SCRIPT_URL.slice(0, 60)}…\n  → ${OUT}\n`);

const ping = await api("ping");
const tabs = ping.sheets || [];
console.log(`  backend build ${ping.build || "?"} — ${tabs.length} tabs\n`);

fs.mkdirSync(path.join(OUT, "tabs"), { recursive: true });

// readAll first: one atomic-ish snapshot of the 12 revision-tracked tabs, and
// the revisions that stamp it. Per-tab reads follow for full coverage.
const readAll = await api("readAll");
fs.writeFileSync(path.join(OUT, "readAll.json"), JSON.stringify(readAll, null, 2));
const revs = readAll.revs || {};
fs.writeFileSync(path.join(OUT, "revs.json"), JSON.stringify(revs, null, 2));
console.log(`  readAll        ${Object.keys(readAll).filter((k) => Array.isArray(readAll[k])).length} tabs, revisions captured\n`);

const manifest = { tool: "backup-sheets.mjs", version: 1, takenAt: new Date().toISOString(),
                   source: APPS_SCRIPT_URL, backendBuild: ping.build || null,
                   sheetName: readAll.sheetName || null, revs, tabs: [] };

let total = 0;
for (const tab of tabs) {
  process.stdout.write(`  ${tab.padEnd(16)}`);
  let rows, rev = null;
  try {
    // doGet wraps a single-tab read as {rows, rev} (apps-script-Code.gs:165),
    // and the Edge Function mirrors that. An empty tab still comes back wrapped;
    // a bare array would mean the protocol changed underneath us.
    const res = await api("read", tab);
    rows = Array.isArray(res) ? res : res?.rows;
    rev = Array.isArray(res) ? null : (res?.rev ?? null);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    manifest.tabs.push({ tab, file: null, rows: null, error: err.message });
    continue;
  }
  if (!Array.isArray(rows)) {
    console.log(`SKIPPED — unexpected shape`);
    manifest.tabs.push({ tab, file: null, rows: null, error: "unexpected response shape" });
    continue;
  }
  const file = `${tab.replace(/[^A-Za-z0-9 _-]/g, "_")}.json`;
  const json = JSON.stringify(rows, null, 2);
  fs.writeFileSync(path.join(OUT, "tabs", file), json);
  fs.writeFileSync(path.join(OUT, "tabs", file.replace(/\.json$/, ".csv")), toCsv(rows));
  const cols = rows.length ? Object.keys(rows[0]) : [];
  manifest.tabs.push({ tab, file, rows: rows.length, columns: cols, sha256: sha256(json),
                       rev: rev ?? revs[tab] ?? null });
  total += rows.length;
  console.log(`${String(rows.length).padStart(5)} rows  ${cols.length} cols`);
}

manifest.totalRows = total;
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

fs.writeFileSync(path.join(OUT, "README.txt"),
`Cougar system backup — ${manifest.takenAt}
Source : ${APPS_SCRIPT_URL}
Build  : ${manifest.backendBuild}
Sheet  : ${manifest.sheetName}
Rows   : ${total} across ${manifest.tabs.filter((t) => t.file).length} tabs

REAL PERSONNEL DATA. Keep it off the repository and off shared drives.

Verify this backup:
  node scripts/backup-sheets.mjs --verify ${OUT}

Restore one tab to the Sheets backend (\`write\` REPLACES the whole tab):
  TAB=Roster
  jq -c --arg t "$TAB" --arg a "<token>" \\
     '{action:"write", tab:$t, auth:$a, data:.}' tabs/$TAB.json \\
  | curl -sL -X POST "${APPS_SCRIPT_URL}" -H 'content-type: application/json' --data @-

The JSON files are already in the shape \`write\` expects — an array of row
objects — so a restore needs no transformation.
`);

const failed = manifest.tabs.filter((t) => t.error);
console.log(`\n  ${total} rows across ${manifest.tabs.filter((t) => t.file).length} tabs → ${OUT}`);
if (failed.length) {
  console.log(`\n  ${failed.length} tab(s) FAILED: ${failed.map((t) => t.tab).join(", ")}`);
  process.exit(1);
}
console.log(`\n  Verify it:  node scripts/backup-sheets.mjs --verify ${OUT}`);
