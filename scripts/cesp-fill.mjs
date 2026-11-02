#!/usr/bin/env node
// ============================================================================
// cesp-fill.mjs - load the CESP BADGE ELIGIBILITY form into the roster.
//
//   Preview (runs every write, then rolls back):
//     DATABASE_URL=... node scripts/cesp-fill.mjs "CESP BADGE ELIGIBILITY (Responses).csv"
//
//   Apply (one transaction):
//     ... --apply
//
//   Resolve a row the script could not match (form line N is the man in 9302):
//     ... --pin 84=9302 --pin 12=7104
//
// WHAT IT WRITES, per matched man
// -------------------------------
//   pes, socLevel, thtPrimary, thtSecondary   real columns (0015)
//   quals += "CPR/AED", "Basic Drone"          when the form says QUALIFIED
//
// Only EMPTY columns are filled; whatever a commander has since set in the app
// wins over a self-reported form. --overwrite lifts that for the four columns.
// Quals are only ever added, never removed: "NOT QUALIFIED" on a form is not
// evidence enough to strip a qualification someone recorded.
//
// WHO GETS WRITTEN
// ----------------
// The form carries a name, platoon and section, but no 4D and no NRIC. A row is
// written only when its name is an EXACT order-independent match (nameKey) for
// exactly one man on the current roster AND that man's seat is in the platoon
// and section the form gives. Anything short of that is reported with the
// closest seats and skipped; --pin settles it by hand. Fuzzy names are never
// trusted here (see CLAUDE.md, "Names in this dataset").
//
// PRIVACY: the report prints form line numbers, 4Ds and field names, never
// names or values. The CSV stays outside the repo (*.csv is gitignored).
// ============================================================================

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { nameKey, nameSimilarity, padD4, parseCsv } from "./intake-plan.mjs";

export const COLUMNS = ["pes", "socLevel", "thtPrimary", "thtSecondary"];
export const QUAL_CPR = "CPR/AED";
export const QUAL_DRONE = "Basic Drone";
const WEAPONS = new Set(["MATADOR", "LMG", "M203"]);

export function parseArgs(argv) {
  const out = { apply: false, overwrite: false, file: "", pins: new Map(), errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--overwrite") out.overwrite = true;
    else if (a === "--pin") {
      const m = String(argv[++i] ?? "").match(/^(\d+)=(\d{1,4})$/);
      if (m) out.pins.set(+m[1], padD4(m[2]));
      else out.errors.push(`--pin wants LINE=4D, got "${argv[i] ?? ""}"`);
    } else if (!a.startsWith("--") && !out.file) out.file = a;
    else out.errors.push(`unknown argument "${a}"`);
  }
  return out;
}

// Header → field, by a fragment of the lower-cased, alphanumeric-only header.
// The form's headers are long ("THT-TRAINED WEAPON ELIGIBILITY (NON SAR)
// [PRIMARY WEAPON]"); matching on fragments survives a re-worded question.
const canon = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADERS = [
  [h => h.startsWith("rankname") || h === "name", "name"],
  [h => h.startsWith("platoon"), "plt"],
  [h => h.startsWith("section"), "sect"],
  [h => h.includes("primaryweapon"), "thtPrimary"],
  [h => h.includes("secondaryweapon"), "thtSecondary"],
  [h => h.startsWith("pes"), "pes"],
  [h => h.startsWith("cpr"), "cpr"],
  [h => h.includes("drone"), "drone"],
  [h => h.includes("soc"), "socLevel"],
];

// One form cell → the stored value, or { error }.
export function cespValue(field, raw) {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (field === "thtPrimary" || field === "thtSecondary") {
    if (!s || s === "NOT TRAINED" || s === "NIL") return "";
    return WEAPONS.has(s) ? s : { error: `${field} "${s}" is not MATADOR, LMG, M203 or NOT TRAINED` };
  }
  if (field === "pes") {
    if (!s) return "";
    return /^[A-F]\d?$/.test(s) ? s : { error: `PES "${s}" is not a PES grade` };
  }
  if (field === "socLevel") {
    if (!s) return "";
    if (/^SOC ?[1-5]$/.test(s)) return s.replace(" ", "");
    if (/NEVER/.test(s)) return "None";
    return { error: `SOC "${s}" is not SOC1-SOC5 or "Never do SOC"` };
  }
  if (field === "cpr" || field === "drone") {
    if (s === "QUALIFIED") return true;
    if (s === "NOT QUALIFIED" || !s) return false;
    return { error: `${field} "${s}" is not QUALIFIED / NOT QUALIFIED` };
  }
  return s;
}

export function parseCesp(text) {
  return parseCsv(text).map((raw, n) => {
    const v = {};
    for (const [header, value] of Object.entries(raw)) {
      const h = canon(header);
      const field = HEADERS.find(([test]) => test(h))?.[1];
      if (field && !(field in v)) v[field] = value;
    }
    const issues = [];
    const out = { line: n + 2, name: String(v.name ?? "").trim(), plt: String(v.plt ?? "").trim(), sect: String(v.sect ?? "").trim(), columns: {}, quals: [] };
    for (const f of COLUMNS) {
      const r = cespValue(f, v[f]);
      if (r && typeof r === "object") issues.push(r.error); else if (r) out.columns[f] = r;
    }
    for (const [f, q] of [["cpr", QUAL_CPR], ["drone", QUAL_DRONE]]) {
      const r = cespValue(f, v[f]);
      if (r && typeof r === "object") issues.push(r.error); else if (r === true) out.quals.push(q);
    }
    out.issues = issues;
    return out;
  });
}

// Platoon/section of a seat: digits 1 and 2 of the 4D (getPlt/getSect).
const seatPlt = id => (String(id).match(/^(\d)\d/) || [])[1] || "";
const seatSect = id => (String(id).match(/^\d(\d)/) || [])[1] || "";

/**
 * Pair each form row with a seat. Pure: no database.
 * @param {string}   text    the CSV
 * @param {object[]} roster  current-intake rows { id, name }
 * @param {Map<number,string>} pins  form line → 4D, set by hand
 * @returns {{ rows: {line, id, columns, quals, how}[], skipped: {line, why, near}[] }}
 */
export function planCesp(text, roster, pins = new Map()) {
  const byId = new Map(roster.map(r => [padD4(r.id), r]));
  const byKey = new Map();
  for (const r of roster) {
    const k = nameKey(r.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const near = name => roster
    .map(r => ({ id: padD4(r.id), score: nameSimilarity(name, r.name) }))
    .filter(x => x.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(x => `${x.id} (${Math.round(x.score * 100)}%)`);

  const rows = [], skipped = [];
  for (const f of parseCesp(text)) {
    if (f.issues.length) { skipped.push({ line: f.line, why: f.issues.join("; "), near: [] }); continue; }
    let seat = null, how = "";
    if (pins.has(f.line)) {
      seat = byId.get(pins.get(f.line));
      if (!seat) { skipped.push({ line: f.line, why: `pinned to ${pins.get(f.line)}, which is not a seat on the current roster`, near: [] }); continue; }
      how = "pinned";
    } else {
      const hits = byKey.get(nameKey(f.name)) || [];
      if (hits.length !== 1) {
        skipped.push({ line: f.line, why: hits.length ? `name matches ${hits.length} seats (${hits.map(h => padD4(h.id)).join(", ")})` : "no exact name match", near: hits.length ? [] : near(f.name) });
        continue;
      }
      seat = hits[0];
      const id = padD4(seat.id);
      if ((f.plt && f.plt !== seatPlt(id)) || (f.sect && f.sect !== seatSect(id))) {
        skipped.push({ line: f.line, why: `name matches ${id}, but the form says platoon ${f.plt} section ${f.sect}`, near: [] });
        continue;
      }
      how = "exact";
    }
    rows.push({ line: f.line, id: padD4(seat.id), columns: f.columns, quals: f.quals, how });
  }

  // Two form rows landing on one seat: neither is trusted.
  const count = new Map();
  rows.forEach(r => count.set(r.id, (count.get(r.id) || 0) + 1));
  const dup = rows.filter(r => count.get(r.id) > 1);
  for (const r of dup) skipped.push({ line: r.line, why: `${r.id} is matched by more than one form row`, near: [] });
  return { rows: rows.filter(r => count.get(r.id) === 1), skipped: skipped.sort((a, b) => a.line - b.line) };
}

// Add quals to a roster.quals string ("CPR@2027-03-31, Range Safety"), keeping
// every existing entry and its expiry. Mirrors getQuals/serializeQuals.
export function addQuals(existing, add) {
  const items = String(existing || "").split(",").map(s => s.trim()).filter(Boolean);
  const names = new Set(items.map(i => { const at = i.lastIndexOf("@"); return (at > 0 ? i.slice(0, at) : i).trim(); }));
  const added = add.filter(q => !names.has(q));
  return { value: [...items, ...added].join(", "), added };
}

class Rollback extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL } = process.env;
  if (args.errors.length || !args.file) {
    for (const e of args.errors) console.error(e);
    console.error('usage: DATABASE_URL=... node scripts/cesp-fill.mjs <form.csv> [--pin LINE=4D]... [--overwrite] [--apply]');
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL) { console.error("DATABASE_URL must be set."); process.exitCode = 2; return; }

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake }] = await sql`select label from intakes where is_current limit 1`;
    const roster = await sql`select "id", "name" from roster where deleted_at is null and intake = ${intake}`;
    const plan = planCesp(fs.readFileSync(args.file, "utf8"), roster, args.pins);

    const report = [];
    try {
      await sql.begin(async (tx) => {
        for (const r of plan.rows) {
          const filled = [], kept = [];
          for (const [f, v] of Object.entries(r.columns)) {
            const res = await tx`update roster set ${tx(f)} = ${v}
                                  where "id" = ${r.id} and intake = ${intake} and deleted_at is null
                                    and (${args.overwrite} or coalesce(${tx(f)}, '') = '' or ${tx(f)} = ${v})`;
            (res.count ? filled : kept).push(f);
          }
          let added = [];
          if (r.quals.length) {
            const [cur] = await tx`select extra ->> 'quals' as quals from roster
                                    where "id" = ${r.id} and intake = ${intake} and deleted_at is null for update`;
            const q = addQuals(cur?.quals, r.quals);
            added = q.added;
            if (added.length) {
              await tx`update roster set extra = jsonb_set(extra, '{quals}', to_jsonb(${q.value}::text))
                        where "id" = ${r.id} and intake = ${intake} and deleted_at is null`;
            }
          }
          report.push({ ...r, filled, kept, added });
        }
        await tx`select bump_rev('Roster')`;
        if (!args.apply) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    for (const r of report) {
      const bits = [`set ${r.filled.length ? r.filled.join(", ") : "nothing"}`];
      if (r.added.length) bits.push(`quals + ${r.added.join(", ")}`);
      if (r.kept.length) bits.push(`kept (already set): ${r.kept.join(", ")}`);
      console.log(`line ${String(r.line).padStart(3)}  ${r.id}  ${r.how === "pinned" ? "[pinned] " : ""}${bits.join(" · ")}`);
    }
    if (plan.skipped.length) {
      console.log(`\nSKIPPED ${plan.skipped.length} row(s), nothing written for them:`);
      for (const s of plan.skipped) console.log(`  line ${String(s.line).padStart(3)}  ${s.why}${s.near.length ? `  - closest: ${s.near.join(", ")}` : ""}`);
      console.log("  Check each against the roster and re-run with --pin LINE=4D.");
    }
    console.log(args.apply
      ? `\nAPPLIED. ${report.length} man/men updated. Phones pick it up on their next sync.`
      : `\nPreview only: ${report.length} matched; every write above ran and was rolled back. Add --apply to keep it.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
}
