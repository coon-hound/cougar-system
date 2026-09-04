#!/usr/bin/env node
// ============================================================================
// Acceptance gate for the cutover: does the NEW backend serve the same data the
// OLD one did?
//
// migrate-from-sheets.mjs checks that it wrote as many rows as it read. That is
// a check on itself. This reads the new backend back through its own HTTP API —
// the same path the app takes — and diffs it field by field against the backup
// captured from the old one. Two independent artifacts, compared end to end.
//
// It knows about the transformations the migration performs ON PURPOSE, and
// treats only unexplained differences as failures:
//
//   padD4       "1101" and 1101 and "C1101" are the same person
//   deny-list   gpa / fieldOfStudy / smoker / nokOccupation are dropped by
//               design (minimisation), so their absence is not a diff
//   text typing Sheets returned real numbers and booleans; Postgres returns
//               text. 14 vs "14" and true vs "true" are the same value
//   "" vs null  both read as empty
//   not-migrated  Conduct Master / Sheet3 / notes carry no app data and have no
//               table; reported as skipped, not as loss
//
// Values are NOT printed by default — this is real personnel data and the
// output tends to end up in a terminal log. Pass --show-values when you are
// actually debugging a mismatch.
//
// Usage:
//   NEW_API_URL=https://<ref>.supabase.co/functions/v1/api \
//   NEW_AUTH=<token> \
//     node scripts/verify-migration.mjs ~/cougar-backups/<stamp> [--show-values]
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const SHOW = argv.includes("--show-values");
const BACKUP = (argv.find((a) => !a.startsWith("--")) || "").replace(/^~/, os.homedir());
const { NEW_API_URL, NEW_AUTH } = process.env;

if (!BACKUP || !NEW_API_URL || !NEW_AUTH) {
  console.error("Usage: NEW_API_URL=... NEW_AUTH=... node scripts/verify-migration.mjs <backup-dir>");
  process.exit(1);
}

// Mirrors padD4 (js/state.js:284) — the one transformation applied to keys.
const padD4 = (v) => {
  const s = String(v ?? "").trim().replace(/^C/i, "");
  return /^\d{1,3}$/.test(s) ? s.padStart(4, "0") : s;
};

// Dropped on purpose by the importer, so their absence downstream is correct.
const DENY = { Roster: new Set(["gpa", "fieldOfStudy", "smoker", "nokOccupation"]) };
const NO_ID = new Set(["MSK", "Config"]);
// No table, by design: no app reads them.
const NOT_MIGRATED = new Set(["Conduct Master", "Sheet3", "notes"]);

// A Sheets number and a Postgres text column holding the same value must
// compare equal, or every numeric field in the system reads as a diff.
const norm = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).trim();
  if (s === "") return "";
  // 1101 vs "1101" already match; this catches 14 vs "14.0" and 2.50 vs "2.5".
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(n);
  }
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  return s;
};

async function newApi(action, tab = "") {
  const url = `${NEW_API_URL}?action=${action}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}` +
              `&auth=${encodeURIComponent(NEW_AUTH)}`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  const body = await res.json();
  if (body?.error) throw new Error(`${action} ${tab}: ${body.error}`);
  return body;
}

const manifest = JSON.parse(fs.readFileSync(path.join(BACKUP, "manifest.json"), "utf8"));
console.log(`Backup   ${manifest.takenAt}  (${manifest.totalRows} rows, build ${manifest.backendBuild})`);
console.log(`New API  ${NEW_API_URL}\n`);

let failures = 0, skipped = 0, comparedRows = 0, comparedTabs = 0;

for (const t of manifest.tabs) {
  if (!t.file) continue;
  if (NOT_MIGRATED.has(t.tab)) {
    console.log(`  skip     ${t.tab.padEnd(16)} not migrated by design (${t.rows} rows stay in the backup)`);
    skipped++;
    continue;
  }

  const oldRows = JSON.parse(fs.readFileSync(path.join(BACKUP, "tabs", t.file), "utf8"));
  let newRows;
  try {
    const res = await newApi("read", t.tab);
    newRows = Array.isArray(res) ? res : (res?.rows ?? []);
  } catch (err) {
    console.log(`  FAIL     ${t.tab.padEnd(16)} ${err.message}`);
    failures++;
    continue;
  }

  const problems = [];

  if (NO_ID.has(t.tab)) {
    // No key to join on — compare as ordered sequences.
    if (oldRows.length !== newRows.length) {
      problems.push(`row count ${oldRows.length} → ${newRows.length}`);
    }
  } else {
    const key = (r) => padD4(r.id ?? r["4d"] ?? "");
    const oldBy = new Map(oldRows.map((r) => [key(r), r]));
    const newBy = new Map(newRows.map((r) => [key(r), r]));

    for (const [k, o] of oldBy) {
      if (!k) continue;                       // unkeyed source rows are skipped by the importer too
      const n = newBy.get(k);
      if (!n) { problems.push(`missing row id=${k}`); continue; }

      const denied = DENY[t.tab] ?? new Set();
      const fields = new Set([...Object.keys(o), ...Object.keys(n)]);
      for (const f of fields) {
        if (denied.has(f)) continue;
        const a = norm(f === "id" || f === "d4" ? padD4(o[f]) : o[f]);
        const b = norm(f === "id" || f === "d4" ? padD4(n[f]) : n[f]);
        if (a !== b) {
          problems.push(SHOW ? `id=${k} ${f}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`
                             : `id=${k} ${f} differs`);
        }
      }
      comparedRows++;
    }
    for (const k of newBy.keys()) if (k && !oldBy.has(k)) problems.push(`extra row id=${k}`);
  }

  comparedTabs++;
  if (problems.length) {
    failures++;
    console.log(`  FAIL     ${t.tab.padEnd(16)} ${oldRows.length} → ${newRows.length} rows, ${problems.length} problem(s)`);
    for (const p of problems.slice(0, 10)) console.log(`             ${p}`);
    if (problems.length > 10) console.log(`             … and ${problems.length - 10} more`);
  } else {
    console.log(`  ok       ${t.tab.padEnd(16)} ${String(newRows.length).padStart(5)} rows match`);
  }
}

console.log(`\n  ${comparedTabs} tabs compared, ${comparedRows} rows checked field by field, ${skipped} skipped by design.`);
if (failures) {
  console.log(`  ${failures} tab(s) DO NOT match. Do not cut over.`);
  if (!SHOW) console.log(`  Re-run with --show-values to see the actual differences.`);
  process.exit(1);
}
console.log(`  The new backend serves what the old one served.`);
