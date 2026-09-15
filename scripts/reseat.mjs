#!/usr/bin/env node
// ============================================================================
// reseat.mjs — re-section a platoon, and move every record with the men.
//
//   Preview (reads only, writes nothing):
//     DATABASE_URL=... node scripts/reseat.mjs sections.txt --plt 9
//
//   Apply (one transaction; all of it or none of it):
//     ... --apply
//
// WHAT THIS IS FOR
// ----------------
// A 4D is a seat, not a person. Digit 1 is the platoon, digit 2 the section,
// and `roster.id` IS the 4D and IS the primary key, so re-dealing a platoon
// into new sections is a primary-key rename over a set that overlaps itself —
// the 4D somebody is moving OUT of is usually one somebody else is moving INTO.
// Every child table joins on that number, so a rename that misses a table
// detaches a man's medical history at exactly the moment it matters.
//
// So: one transaction, a two-phase rename through a temporary key, and the
// list of tables to rewrite is DISCOVERED from the catalogue rather than typed
// out here. A table added next year gets carried automatically; the failure
// mode of a hardcoded list is silent and permanent.
//
// The preview and the apply compute the SAME plan through the same code path
// (scripts/reseat-plan.mjs) and print the same report. `--apply` only decides
// whether the writes that follow the report happen.
//
// REFUSES TO RUN unless the list accounts for the whole platoon, one-to-one.
// See the closed-set note in reseat-plan.mjs — that check is what stops a
// mistyped name quietly moving one recruit's records onto another.
//
// PRIVACY: names are NOT printed unless --names is passed. The report is the
// thing that gets pasted into a chat or a PR, and 4Ds alone are enough to
// check it.
// ============================================================================

import postgres from "postgres";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { formatReseatReport, parseSections, planReseat } from "./reseat-plan.mjs";

// Exactly REV_TABS (Edge Function). A re-section can touch any of them, and a
// tab whose rev did not move is a tab every phone in the field still believes
// its stale cache of — which it will then push back over the top of this.
const REV_TABS = [
  "Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC",
  "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts",
];

// The temporary key the rename passes through. "~" sorts above every digit and
// letter and is not legal in any 4D, so a half-finished run is obvious rather
// than plausible.
const TEMP = "~";

export function parseArgs(argv) {
  const out = { apply: false, names: false, plt: "", file: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--names") out.names = true;
    else if (a === "--plt") out.plt = String(argv[++i] ?? "").trim();
    else if (!a.startsWith("--") && !out.file) out.file = a;
  }
  return out;
}

/**
 * Every table that keys on a 4D, straight out of the catalogue.
 *
 * Read rather than listed on purpose: the whole hazard of this operation is a
 * table nobody remembered, and a list in this file is exactly how that happens.
 * Views are excluded — audit_changes projects a d4 out of the audit JSON and is
 * not writable. The audit table itself is left alone deliberately: it is a
 * record of what was written at the time, and rewriting history to match the
 * present is the one thing an audit log must never do.
 */
async function d4Tables(sql) {
  const rows = await sql`
    select c.relname                                         as table,
           a.attname                                         as col,
           exists (select 1 from information_schema.columns ic
                    where ic.table_schema = 'public'
                      and ic.table_name   = c.relname
                      and ic.column_name  = 'intake')        as has_intake
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'public'
       and c.relkind = 'r'
       and a.attnum > 0 and not a.attisdropped
       and lower(a.attname) = 'd4'
       and c.relname <> 'audit'
     order by c.relname`;
  return rows;
}

/** How many rows each moving man carries, per table — for the intake_log. */
async function countRows(sql, tables, oldIds, intake) {
  const counts = new Map(oldIds.map((id) => [id, {}]));
  for (const t of tables) {
    const rows = t.has_intake
      ? await sql`select d4, count(*)::int as n from ${sql(t.table)}
                   where d4 = any(${oldIds}) and intake = ${intake}
                     and deleted_at is null group by d4`
      : await sql`select d4, count(*)::int as n from ${sql(t.table)}
                   where d4 = any(${oldIds}) group by d4`;
    for (const r of rows) if (r.n) counts.get(r.d4)[t.table] = r.n;
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL } = process.env;

  if (!args.file || !args.plt) {
    console.error("usage: DATABASE_URL=... node scripts/reseat.mjs <sections.txt> --plt <n> [--apply] [--names]");
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exitCode = 2;
    return;
  }

  const { sections, issues: parseIssues } = parseSections(fs.readFileSync(args.file, "utf8"));
  if (parseIssues.length) {
    for (const i of parseIssues) console.error(`✗ ${i.message}`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake }] = await sql`select label from intakes where is_current limit 1`;
    const roster = await sql`
      select "id", "name", "role", "pid" from roster
       where deleted_at is null and intake = ${intake}`;

    const plan = planReseat({ plt: args.plt, roster, sections });
    console.log(formatReseatReport(plan, { names: args.names }));

    if (!plan.ok) { process.exitCode = 1; return; }
    if (!plan.moves.length) {
      console.log("\nNothing to do — every man already holds the right 4D.");
      return;
    }
    if (!args.apply) {
      console.log("\nPreview only. Nothing was written. Add --apply to re-seat.");
      return;
    }

    const tables = await d4Tables(sql);
    const oldIds = plan.moves.map((m) => m.oldId);
    const carried = await countRows(sql, tables, oldIds, intake);

    // old -> temp, then temp -> new. Two phases because roster's primary key is
    // not deferrable: a single UPDATE re-keying 9301 to 9102 while 9102 still
    // exists trips the unique index the moment it reaches the first row, even
    // though the set as a whole is a clean permutation.
    const toTemp = Object.fromEntries(plan.moves.map((m) => [m.oldId, TEMP + m.oldId]));
    const toNew = Object.fromEntries(plan.moves.map((m) => [TEMP + m.oldId, m.newId]));
    const pidMap = Object.fromEntries(plan.moves.filter((m) => m.pid).map((m) => [m.pid, m.newId]));

    const touched = await sql.begin(async (tx) => {
      const n = {};

      for (const map of [toTemp, toNew]) {
        const j = tx.json(map);

        // roster."4d" is the display form of the same value — kept in step here
        // rather than by a trigger, so the two can never disagree.
        const r = await tx`
          update roster t
             set "id" = x.value, "4d" = 'C' || x.value
            from jsonb_each_text(${j}::jsonb) x
           where t."id" = x.key and t.intake = ${intake} and t.deleted_at is null`;
        n.roster = (n.roster ?? 0) + r.count;

        for (const t of tables) {
          const res = t.has_intake
            ? await tx`update ${tx(t.table)} u set d4 = x.value
                         from jsonb_each_text(${j}::jsonb) x
                        where u.d4 = x.key and u.intake = ${intake}`
            : await tx`update ${tx(t.table)} u set d4 = x.value
                         from jsonb_each_text(${j}::jsonb) x
                        where u.d4 = x.key`;
          n[t.table] = (n[t.table] ?? 0) + res.count;
        }
      }

      // The person registry. last_d4 is the seat they hold now; d4_history is
      // every seat they have ever held, oldest first, and a re-section is
      // exactly the kind of move it exists to record.
      if (Object.keys(pidMap).length) {
        await tx`
          update people p
             set last_d4    = x.value,
                 d4_history = case when p.d4_history @> array[x.value]
                                   then p.d4_history else p.d4_history || x.value end
            from jsonb_each_text(${tx.json(pidMap)}::jsonb) x
           where p.pid = x.key`;
      }

      for (const m of plan.moves) {
        await tx`
          insert into intake_log (intake, pid, name, old_d4, new_d4, matched_by, rows_moved)
          values (${intake}, ${m.pid}, ${m.name}, ${m.oldId}, ${m.newId}, 'reseat',
                  ${tx.json(carried.get(m.oldId) ?? {})})`;
      }

      for (const tab of REV_TABS) await tx`select bump_rev(${tab})`;
      return n;
    });

    console.log("\n" + "─".repeat(72));
    console.log(`APPLIED. ${plan.moves.length} men re-seated in platoon ${plan.plt}.`);
    console.log("Rows re-keyed (both phases, so twice the row count):");
    for (const [t, c] of Object.entries(touched)) if (c) console.log(`  ${t}  ${c}`);
    console.log("");
    console.log("Still to do by hand:");
    console.log("  1. Bump STORAGE_KEY in js/state.js and the ?v= in index.html, then deploy.");
    console.log("     Every phone still holds the old seating; until the cache is dropped a");
    console.log("     commander can write a row against a 4D that now belongs to someone else.");
    console.log("  2. Re-issue invites for anyone whose 4D moved.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
