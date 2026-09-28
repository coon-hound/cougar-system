#!/usr/bin/env node
// ============================================================================
// profile-fill.mjs — fill in the profile of men who are already seated.
//
//   Preview (runs every write, then rolls back):
//     DATABASE_URL=... COUGAR_ENC_KEY=... node scripts/profile-fill.mjs late-forms.csv
//
//   Apply (one transaction):
//     ... --apply
//
// WHAT THIS IS FOR
// ----------------
// The in-processing form does not all arrive before the changeover. A man who
// filled it in late already holds a seat, so re-running the changeover is out
// and typing eight encrypted fields in by hand is how a next-of-kin number ends
// up on the wrong man. This takes the late rows in nominal-roll format (same
// headers, see docs/NOMINAL-ROLL.md) and fills the profile fields of the man in
// each row's 4D.
//
// Two rules keep it safe:
//
//   * The row's NAME must be the name on that seat (same order-independent key
//     the changeover matches on). A 4D typed one digit off would otherwise write
//     one man's next of kin onto another, and nothing would ever flag it.
//   * Only EMPTY fields are filled. Whatever a commander has since corrected in
//     the app wins over a form typed weeks ago. --overwrite lifts that.
//
// A full NRIC in the row sets that man's registry digest if he has none yet,
// which is what lets the next changeover recognise him exactly. The raw value
// stops in this process, as it does in the changeover.
//
// PRIVACY: the report prints 4Ds and field names, never values or names.
// ============================================================================

// `postgres` is imported lazily inside main(); see the note in reseat.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  ENCRYPTED, ROSTER_FROM_ROLL, nameKey, normaliseRollRow, nricKey, padD4, parseCsv,
} from "./intake-plan.mjs";

export function parseArgs(argv) {
  const out = { apply: false, overwrite: false, file: "" };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a === "--overwrite") out.overwrite = true;
    else if (!a.startsWith("--") && !out.file) out.file = a;
  }
  return out;
}

/**
 * Pair each form row with the seat it names. Pure: no database, so the part
 * that decides WHO gets written is testable on its own.
 *
 * @param {string}   text    the CSV
 * @param {object[]} roster  current-intake rows { id, name, pid }
 * @param {(s:string)=>string} hash  keyed digest for the NRIC
 * @returns {{ rows: {id, pid, fields, nricHash}[], issues: string[], unknown: string[] }}
 */
export function planFill(text, roster, hash) {
  const issues = [];
  const unknown = new Set();
  const byId = new Map(roster.map((r) => [padD4(r.id), r]));
  const seen = new Set();
  const rows = [];

  for (const [n, raw] of parseCsv(text).entries()) {
    const line = n + 2;
    const { row, unknown: u } = normaliseRollRow(raw);
    for (const h of u) unknown.add(h);

    const id = padD4(row.d4);
    const seat = byId.get(id);
    if (!seat) { issues.push(`line ${line}: ${id || "(no 4D)"} is not a seat on the current roster`); continue; }
    if (seen.has(id)) { issues.push(`line ${line}: ${id} is listed twice`); continue; }
    seen.add(id);
    if (nameKey(row.name) !== nameKey(seat.name)) {
      issues.push(`line ${line}: the name does not match the man in ${id}. Check the 4D; nothing is written on a mismatch.`);
      continue;
    }

    const nk = nricKey(row.nric);
    if (row.nric && !nk) { issues.push(`line ${line}: NRIC is not a full NRIC`); continue; }

    const fields = {};
    for (const f of ROSTER_FROM_ROLL) {
      const v = String(row[f] ?? "").trim();
      if (v) fields[f] = v;
    }
    rows.push({ id, pid: seat.pid ?? null, fields, nricHash: nk ? hash(`nric:${nk}`) : "" });
  }
  return { rows, issues, unknown: [...unknown] };
}

class Rollback extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL, COUGAR_ENC_KEY } = process.env;
  if (!args.file) {
    console.error("usage: DATABASE_URL=... COUGAR_ENC_KEY=... node scripts/profile-fill.mjs <forms.csv> [--apply] [--overwrite]");
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL || !COUGAR_ENC_KEY) {
    console.error("DATABASE_URL and COUGAR_ENC_KEY must both be set.");
    process.exitCode = 2;
    return;
  }
  const hash = (s) => crypto.createHmac("sha256", COUGAR_ENC_KEY).update(String(s)).digest("hex");

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake }] = await sql`select label from intakes where is_current limit 1`;
    const roster = await sql`
      select "id", "name", "pid" from roster where deleted_at is null and intake = ${intake}`;

    const plan = planFill(fs.readFileSync(args.file, "utf8"), roster, hash);
    if (plan.unknown.length) console.log(`Columns skipped (not stored): ${plan.unknown.join(", ")}\n`);
    if (plan.issues.length) {
      for (const i of plan.issues) console.error(`✗ ${i}`);
      console.error("\nBLOCKED. Nothing was written.");
      process.exitCode = 1;
      return;
    }

    const report = [];
    try {
      await sql.begin(async (tx) => {
        for (const r of plan.rows) {
          const filled = [], kept = [];
          for (const [f, v] of Object.entries(r.fields)) {
            const res = ENCRYPTED.has(f)
              ? await tx`update roster set ${tx(f)} = enc_col(${v}, ${COUGAR_ENC_KEY})
                          where "id" = ${r.id} and intake = ${intake} and deleted_at is null
                            and (${args.overwrite} or coalesce(dec_col(${tx(f)}, ${COUGAR_ENC_KEY}), '') = '')`
              : await tx`update roster set ${tx(f)} = ${v}
                          where "id" = ${r.id} and intake = ${intake} and deleted_at is null
                            and (${args.overwrite} or coalesce(${tx(f)}, '') = '')`;
            (res.count ? filled : kept).push(f);
          }

          let nric = "";
          if (r.nricHash && r.pid) {
            const [other] = await tx`select pid from people where nric_hash = ${r.nricHash} and pid <> ${r.pid}`;
            if (other) throw new Error(`${r.id}: that NRIC digest already belongs to ${other.pid}. Nothing was written.`);
            const res = await tx`update people set nric_hash = ${r.nricHash}
                                  where pid = ${r.pid} and nric_hash is null`;
            nric = res.count ? "NRIC digest set" : "NRIC digest already known";
          }
          report.push({ id: r.id, filled, kept, nric });
        }
        await tx`select bump_rev('Roster')`;
        if (!args.apply) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    for (const r of report) {
      console.log(`${r.id}  filled ${r.filled.length}${r.filled.length ? `: ${r.filled.join(", ")}` : ""}`);
      if (r.kept.length) console.log(`       kept (already set): ${r.kept.join(", ")}`);
      if (r.nric) console.log(`       ${r.nric}`);
    }
    console.log(args.apply
      ? `\nAPPLIED. ${report.length} profile(s) updated. Phones pick it up on their next sync.`
      : "\nPreview only: every write above ran and was rolled back. Add --apply to keep it.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
}
