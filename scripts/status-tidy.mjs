#!/usr/bin/env node
// ============================================================================
// status-tidy.mjs - write every medical status the one way the app reads it,
// and split the combined live / blank firing excuse into its two excuses.
//
//   Preview (runs every write, then rolls back):
//     DATABASE_URL=... node scripts/status-tidy.mjs
//
//   Apply (one transaction):
//     DATABASE_URL=... node scripts/status-tidy.mjs --apply
//
// WHAT IT WRITES
// --------------
// The app already folds near-duplicate spellings at load (canonMedStatus /
// normalizeMedical in js/helpers.js and js/state.js), so this changes nothing
// on screen for the renames. It makes the stored rows agree with the screen,
// so a later rename of the convention never has to reason about old spellings.
//
//  • RENAME: a row whose status the app reads differently ("excuse boots" ->
//    "Excuse Boots") gets the name the app shows.
//  • SPLIT: a row whose status is the combined "Live Firing, Firing of Blanks"
//    excuse (any of its spellings) becomes "Excuse Live Firing", and a sibling
//    row "Excuse Blank Firing" is inserted with the same man, report date,
//    reason, location, duration and permanent flag - exactly the sibling rows the medical
//    form writes for "＋ Add another status". inCamp stays on the original.
//
// The mapping is computed by loading the REAL js/helpers.js and js/state.js,
// so it cannot drift from what the phones do. Every change is backed up by
// row_history (0014), and Medical's rev is bumped so phones pull it.
//
// PRIVACY: the report prints statuses and counts only, never names or 4Ds.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class Rollback extends Error {}

// The app's own status logic, loaded the way index.html loads it.
export function loadApp() {
  const store = new Map();
  const sandbox = {
    console, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp,
    Set, Map, isNaN, parseInt, parseFloat,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  };
  vm.createContext(sandbox);
  ["js/helpers.js", "js/state.js"].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  return sandbox;
}

// rows: [{ id, status, ... }] - every live medical row.
// Returns { renames: [{id, from, to}], splits: [{id, from, keep, add: [status]}] }.
export function planTidy(rows, app = loadApp()) {
  const canon = app.normalizeMedical(rows.map(r => ({ id: r.id, d4: "0000", status: r.status })));
  const renames = [];
  const splits = [];
  rows.forEach((r, i) => {
    const from = r.status == null ? "" : String(r.status);
    const parts = app.medStatusSplit(canon[i].status);
    if (parts.length > 1) splits.push({ id: r.id, from, keep: parts[0], add: parts.slice(1) });
    else if (canon[i].status !== from) renames.push({ id: r.id, from, to: canon[i].status });
  });
  return { renames, splits };
}

// Summarise a plan as "from -> to  xN" lines, most frequent first.
export function summarise(plan) {
  const tally = new Map();
  const bump = (k) => tally.set(k, (tally.get(k) || 0) + 1);
  plan.renames.forEach(r => bump(`${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`));
  plan.splits.forEach(s => bump(`${JSON.stringify(s.from)} -> ${[s.keep, ...s.add].map(x => JSON.stringify(x)).join(" + ")}`));
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const unknown = process.argv.slice(2).filter(a => a !== "--apply");
  if (unknown.length) { console.error(`unknown argument(s): ${unknown.join(" ")}\nusage: DATABASE_URL=... node scripts/status-tidy.mjs [--apply]`); process.exitCode = 2; return; }
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) { console.error("DATABASE_URL must be set."); process.exitCode = 2; return; }

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const rows = await sql`select "id", "status" from medical where deleted_at is null`;
    const plan = planTidy(rows);
    console.log(`Medical: ${rows.length} live rows`);
    console.log(`Renamed: ${plan.renames.length}   Split in two: ${plan.splits.length}\n`);
    for (const [line, n] of summarise(plan)) console.log(`  x${String(n).padEnd(3)} ${line}`);
    if (!plan.renames.length && !plan.splits.length) { console.log("\nNothing to do."); return; }

    const stamp = Date.now().toString(36);
    let seq = 0;
    try {
      await sql.begin(async (tx) => {
        for (const r of plan.renames) {
          const res = await tx`update medical set "status" = ${r.to}
                                where "id" = ${r.id} and deleted_at is null and "status" is not distinct from ${r.from}`;
          if (res.count !== 1) throw new Error(`row ${r.id} changed under the run; nothing written`);
        }
        for (const s of plan.splits) {
          const [cur] = await tx`select * from medical where "id" = ${s.id} and deleted_at is null for update`;
          if (!cur || cur.status !== s.from) throw new Error(`row ${s.id} changed under the run; nothing written`);
          await tx`update medical set "status" = ${s.keep} where "id" = ${s.id}`;
          for (const status of s.add) {
            const id = `${stamp}-tidy-${(++seq).toString(36)}`;
            await tx`insert into medical ("id", "d4", "date", "reason", "location", "status", "startDate", "endDate", "inCamp", extra)
                     values (${id}, ${cur.d4}, ${cur.date}, ${cur.reason}, ${cur.location}, ${status}, ${cur.startDate}, ${cur.endDate}, ${"false"}, ${sql.json(cur.extra || {})})`;
          }
        }
        await tx`select bump_rev('Medical')`;
        if (!apply) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    console.log(apply
      ? `\nAPPLIED. ${plan.renames.length} renamed, ${plan.splits.length} split (${seq} rows added). Phones pick it up on their next sync.`
      : "\nPreview only: every write ran and was rolled back. Add --apply to keep it.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
}
