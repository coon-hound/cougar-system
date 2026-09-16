#!/usr/bin/env node
// ============================================================================
// intake-migrate.mjs — run a change of intake.
//
//   Preview (reads only, writes nothing):
//     DATABASE_URL=... COUGAR_ENC_KEY=... \
//       node scripts/intake-migrate.mjs roll.csv --label 26/02 --prev 25/08 \
//                                       --cutoff 2026-02-16
//
//   Apply (one transaction; all of it or none of it):
//     ... --apply
//
// A name that nearly matches someone we know BLOCKS by default and must be
// settled by hand — `--override 1101=P4F2A9C1B0` for the same person,
// `--override 1101=NEW` for a stranger who happens to share two name tokens.
// `--accept-fuzzy` takes them all, and is for the operator who has read every
// one of them.
//
// The preview and the apply compute the SAME plan through the same code path
// (scripts/intake-plan.mjs) and print the same report. `--apply` only decides
// whether the writes that follow the report actually happen, so what you read
// and approved is exactly what runs.
//
// WHAT "ARCHIVE" MEANS HERE
// -------------------------
// Nothing is exported and nothing is deleted. Every row of the outgoing cohort
// is stamped with its intake label and soft-deleted, which takes it out of the
// app's view (every read in the Edge Function is `where deleted_at is null`)
// while leaving it in Postgres, indexed and queryable forever:
//
//     select * from medical where intake = '25/08';
//
// The outgoing roster's ids and its children's `d4`s are re-keyed to
// "1101@25-08" first, because `roster.id` IS the 4D and IS the primary key —
// the incoming cohort needs those seats back. See 0004_intake.sql.
//
// REFUSES TO RUN on any blocking issue. An ambiguous name is not something to
// resolve by coin flip: the failure mode is one recruit inheriting another's
// medical history, which is both invisible afterwards and unsafe.
// ============================================================================

// `postgres` is imported lazily inside main(), NOT at the top level.
// `.github/workflows/test.yml` runs `node test/run.js` with no `npm install`,
// so anything a unit test can reach must not pull in an npm package on load -
// it passes locally, where node_modules exists, and fails only in CI with
// ERR_MODULE_NOT_FOUND. A test only has to NAME this file in a string for the
// static guard to count it as reachable, which is how this surfaced.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CARRY_RULES, archiveKey, formatReport, parseCsv, planIntake } from "./intake-plan.mjs";

const { DATABASE_URL, COUGAR_ENC_KEY } = process.env;

// Columns encrypted at rest (0002). Mirrors ENCRYPTED in the Edge Function.
const ENCRYPTED = new Set([
  "dob", "bloodType", "allergies", "otherMedical",
  "address", "nokName", "nokRelation", "nokPhone",
]);

// Exactly REV_TABS (Edge Function) — every tab the client tracks a revision
// for. All of them change here, so all of them must be bumped.
const REV_TABS = [
  "Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC",
  "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts",
  "Duty", "Calendar", "OilRules",
];

// Tables that get archived at a changeover.
//
// Conducts used to be excluded, on 0004's premise that it is a vocabulary of
// conduct names that recur every intake. It is not: intake 16 created a fresh
// "ENDURANCE RUN 1" two days in rather than reuse the previous cohort's entry,
// and the registry had grown to 112 rows in one flat <select>. 0010 gave it the
// intake stamp and the two archive guards; this list is what keeps the next
// changeover from having to do it by hand again.
const COHORT_TABLES = [
  "roster", "medical", "attendance", "ippt", "routemarch", "soc",
  "polarflow", "conductdetail", "appointments", "leave", "msk", "conducts",
  // The duty schedule (0009). These hold commander rows only, and commanders
  // are skipped by the archive step and rolled forward - so they never
  // actually archive. They are here so the ROLL-FORWARD loop picks them up: a
  // commander row left on a departed cohort's label can be soft-deleted in the
  // app and then never revived, because keep_archived_archived silently
  // declines it and the user sees a write that reports success and does
  // nothing. `calendar` is absent on purpose: it is recurring unit vocabulary,
  // not a cohort's property, and is not intake-stamped at all.
  "duty", "oil_rule",
];

// Cohort tables with no `d4` to re-key: every row belongs to the outgoing
// cohort's training calendar rather than to a person, so the whole table
// archives. Roster is special-cased separately (its id IS the 4D).
const NO_D4_TABLES = new Set(["attendance", "conducts"]);

// ── Argument parsing ────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { apply: false, acceptFuzzy: false, overrides: {}, roll: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--accept-fuzzy") out.acceptFuzzy = true;
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--prev") out.prev = argv[++i];
    else if (a === "--cutoff") out.cutoff = argv[++i];
    else if (a === "--override") {
      // --override 1101=P4F2A9C1B0  |  --override 1102=NEW
      const [d4, pid] = String(argv[++i] ?? "").split("=");
      if (d4 && pid) out.overrides[d4.trim()] = pid.trim();
    } else if (!a.startsWith("--") && !out.roll) out.roll = a;
  }
  return out;
}

/**
 * Keyed digest. Keyed, not plain, because the only thing ever hashed is an NRIC
 * - a space small enough that a plain SHA-256 gives it straight
 * back to anyone holding the digest and a wordlist. With the key held only in
 * the environment, the stored digest is useless on its own.
 */
function makeHash(key) {
  return (s) => crypto.createHmac("sha256", key).update(String(s)).digest("hex");
}

async function columnsOf(sql, table) {
  const rows = await sql`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = ${table}`;
  return new Set(
    rows.map((r) => r.column_name)
      .filter((c) => !["extra", "updated_at", "deleted_at", "_pk"].includes(c)),
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function loadContext(sql) {
  const [people, roster] = await Promise.all([
    sql`select pid, name, name_key, nric_hash, first_intake, last_intake, last_d4, d4_history
          from people`,
    // Only the four fields the planner needs. Deliberately NOT through
    // roster_api_row: that would decrypt eight columns of dates of birth and
    // next-of-kin details into this process for no reason. Matching is done on
    // name, and the roll supplies everything else.
    sql`select "id", "name", "role", "pid" from roster where deleted_at is null`,
  ]);

  const data = {};
  for (const [key, rule] of Object.entries(CARRY_RULES)) {
    if (rule.carry === "keep" || rule.carry === "none") continue;
    const rows = await sql`
      select api_row(to_jsonb(t)) as row from ${sql(rule.table)} t
       where t.deleted_at is null`;
    data[key] = rows.map((r) => r.row);
  }
  return { people, roster, data };
}

async function currentIntake(sql) {
  const [r] = await sql`select label, cutoff_date from intakes where is_current limit 1`;
  return r ?? null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Re-key and soft-delete everything belonging to the outgoing cohort.
 *
 * Covers rows that are ALREADY soft-deleted, which is easy to miss and would
 * break the whole changeover: a recruit who dropped out mid-intake leaves a
 * tombstoned roster row still holding 1101 as its primary key. The incoming
 * 1101 would collide with a row nobody can see.
 *
 * Commanders are excluded everywhere. They are not part of an intake — they
 * keep their seats, their leave rows and their off-in-lieu balances.
 */
async function archiveCohort(tx, prevLabel, newLabel, commanderIds) {
  const moved = {};

  // Roster: the id IS the 4D, so re-keying it is what frees the seat.
  const rosterRows = await tx`
    update roster
       set "id"        = archive_key("id", ${prevLabel}),
           "4d"        = archive_key("4d", ${prevLabel}),
           intake      = ${prevLabel},
           deleted_at  = coalesce(deleted_at, now())
     where "id" <> all (${commanderIds})
       and "id" not like '%@%'
     returning "id"`;
  moved.roster = rosterRows.length;

  for (const table of COHORT_TABLES) {
    if (table === "roster") continue;

    if (NO_D4_TABLES.has(table)) {
      // Per-conduct, not per-person: no d4 to re-key, and every row belongs to
      // the outgoing cohort's training calendar. Attendance is the log;
      // conducts is the registry of names it points at, and both are retyped by
      // the incoming cohort rather than reused.
      const rows = await tx`
        update ${tx(table)}
           set intake = ${prevLabel}, deleted_at = coalesce(deleted_at, now())
         where intake is distinct from ${prevLabel} or deleted_at is null
         returning "id"`;
      moved[table] = rows.length;
      continue;
    }

    const rows = await tx`
      update ${tx(table)}
         set "d4"       = archive_key("d4", ${prevLabel}),
             intake     = ${prevLabel},
             deleted_at = coalesce(deleted_at, now())
       where "d4" <> all (${commanderIds})
         and "d4" not like '%@%'
       returning 1 as n`;
    moved[table] = rows.length;
  }

  // Commanders were skipped by every update above, which leaves them stamped
  // with the cohort that just left. Roll them forward.
  //
  // Not cosmetic. `keep_archived_archived` refuses to revive a soft-deleted row
  // whose intake is not the current one, so a commander left on the old stamp
  // could be deleted in the app and then never re-added — the upsert would
  // succeed, the revival would be silently declined, and the commander would
  // simply not come back. They are not part of an intake, so they always belong
  // to the current one.
  await tx`
    update roster set intake = ${newLabel}
     where "id" = any (${commanderIds}) and deleted_at is null`;
  for (const table of COHORT_TABLES) {
    // NO_D4_TABLES have no "d4" column at all, so this query does not merely
    // match nothing there - it fails to parse.
    if (table === "roster" || NO_D4_TABLES.has(table)) continue;
    await tx`
      update ${tx(table)} set intake = ${newLabel}
       where "d4" = any (${commanderIds}) and deleted_at is null`;
  }
  return moved;
}

/** Insert the incoming roster. Encrypted columns go through enc_col(). */
async function insertRoster(tx, plan, cols) {
  for (const { row, pid, intake } of plan.newRoster) {
    const plain = {}, enc = {};
    for (const [k, v] of Object.entries(row)) {
      if (!cols.has(k)) continue;
      if (ENCRYPTED.has(k)) { if (String(v ?? "") !== "") enc[k] = String(v); }
      else plain[k] = String(v ?? "");
    }
    plain.pid = pid;
    plain.intake = intake;

    await tx`insert into roster ${tx(plain)}`;
    for (const [k, v] of Object.entries(enc)) {
      await tx`update roster set ${tx(k)} = enc_col(${v}, ${COUGAR_ENC_KEY}) where "id" = ${row.id}`;
    }
  }
}

/** Insert the rows carried onto new seats. None of these tables is encrypted. */
async function insertCarried(tx, plan, label, colsFor) {
  const counts = {};
  for (const [key, rule] of Object.entries(CARRY_RULES)) {
    if (rule.carry === "keep" || rule.carry === "none" || rule.carry === "commander") continue;
    const rows = plan.carried[key] ?? [];
    if (!rows.length) { counts[key] = 0; continue; }

    const cols = colsFor[rule.table];
    for (const row of rows) {
      const plain = {};
      for (const [k, v] of Object.entries(row)) {
        if (!cols.has(k)) continue;
        plain[k] = v == null ? "" : String(v);
      }
      // AFTER the copy, never before. The source row came from api_row, which
      // returns every real column — `intake` included — so setting the stamp
      // first just gets overwritten by the outgoing cohort's own label, and the
      // carried row lands in the archive it was supposed to escape.
      plain.intake = label;
      await tx`insert into ${tx(rule.table)} ${tx(plain)}`;
    }
    counts[key] = rows.length;
  }
  return counts;
}

async function upsertPeople(tx, plan) {
  for (const p of plan.people) {
    await tx`
      insert into people (pid, name, name_key, nric_hash, first_intake, last_intake, last_d4, d4_history)
      values (${p.pid}, ${p.name}, ${p.name_key}, ${p.nric_hash},
              ${p.first_intake}, ${p.last_intake}, ${p.last_d4}, ${p.d4_history})
      on conflict (pid) do update
        set name        = excluded.name,
            name_key    = excluded.name_key,
            -- never overwrite a known digest with null: a roll that omits the
            -- NRIC column must not erase an identity we already established.
            nric_hash   = coalesce(excluded.nric_hash, people.nric_hash),
            last_intake = excluded.last_intake,
            last_d4     = excluded.last_d4,
            d4_history  = excluded.d4_history`;
  }
}

// ── Driver ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.roll) {
    console.error("Usage: node scripts/intake-migrate.mjs <roll.csv> --label 26/02 --prev 25/08 --cutoff YYYY-MM-DD [--apply]");
    process.exitCode = 1;
    return;
  }
  for (const [k, v] of Object.entries({ DATABASE_URL, COUGAR_ENC_KEY })) {
    if (!v) { console.error(`Missing required environment variable ${k}.`); process.exitCode = 1; return; }
  }
  if (!args.label) { console.error("--label is required, e.g. --label 26/02"); process.exitCode = 1; return; }
  if (!args.cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(args.cutoff)) {
    console.error("--cutoff is required as YYYY-MM-DD (the new cohort's first day).");
    process.exitCode = 1;
    return;
  }

  const rollPath = path.resolve(args.roll);
  if (!fs.existsSync(rollPath)) { console.error(`No such file: ${rollPath}`); process.exitCode = 1; return; }
  const roll = parseCsv(fs.readFileSync(rollPath, "utf8"));

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false, max: 4 });
  try {
    const current = await currentIntake(sql);
    if (!current) {
      console.error("No current intake. Apply supabase/migrations/0004_intake.sql first.");
      process.exitCode = 1;
      return;
    }
    // The outgoing cohort needs a real label to archive under. 0004 stamps
    // everything "bootstrap" precisely because it does not know the name of the
    // cohort already in camp — the operator does.
    const prevLabel = args.prev || (current.label === "bootstrap" ? "" : current.label);
    if (!prevLabel) {
      console.error(
        "The current intake is still labelled 'bootstrap'. Pass --prev with the outgoing\n" +
        "cohort's real label (e.g. --prev 25/08) so its records archive under a name you\n" +
        "will recognise in a year.");
      process.exitCode = 1;
      return;
    }
    if (args.label === prevLabel) {
      console.error("--label and --prev are the same. The incoming cohort needs a new label.");
      process.exitCode = 1;
      return;
    }

    const { people, roster, data } = await loadContext(sql);
    const plan = planIntake({
      label: args.label,
      prevLabel,
      cutoff: args.cutoff,
      hash: makeHash(COUGAR_ENC_KEY),
      roll,
      people,
      roster,
      data,
      overrides: args.overrides,
      acceptFuzzy: args.acceptFuzzy,
    });

    console.log(formatReport(plan));

    if (!plan.ok) { process.exitCode = 1; return; }
    if (!args.apply) {
      console.log("\nPreview only. Nothing was written. Add --apply to perform the changeover.");
      return;
    }

    const commanderIds = roster
      .filter((r) => r.role === "Commander" || /^00\d{2}$/.test(String(r.id ?? "")))
      .map((r) => String(r.id));

    const colsFor = {};
    for (const t of ["roster", ...Object.values(CARRY_RULES).map((r) => r.table)]) {
      if (!colsFor[t]) colsFor[t] = await columnsOf(sql, t);
    }

    const result = await sql.begin(async (tx) => {
      // 1. Give the outgoing cohort its real name, if it is still 'bootstrap'.
      //    intake_log's FK cascades; the stamped columns are plain text and are
      //    rewritten explicitly.
      if (current.label === "bootstrap" && prevLabel !== "bootstrap") {
        await tx`update intakes set label = ${prevLabel} where label = 'bootstrap'`;
        for (const t of COHORT_TABLES) {
          await tx`update ${tx(t)} set intake = ${prevLabel} where intake = 'bootstrap'`;
        }
      }

      // 2. Register the incoming cohort and make it current BEFORE any insert,
      //    so the `intake` column defaults and the archive-guard triggers both
      //    see the right label.
      await tx`
        insert into intakes (label, cutoff_date, is_current, roll_rows, recruits, returnees)
        values (${args.label}, ${args.cutoff}, false,
                ${plan.stats.rollRows}, ${plan.stats.recruits}, ${plan.stats.returnees})
        on conflict (label) do update
          set cutoff_date = excluded.cutoff_date,
              roll_rows   = excluded.roll_rows,
              recruits    = excluded.recruits,
              returnees   = excluded.returnees`;

      // 3. Archive, then flip. Archiving while the OLD intake is still current
      //    keeps `keep_archived_archived` inert for these updates — they are
      //    the one legitimate way a row becomes archived.
      const movedCounts = await archiveCohort(tx, prevLabel, args.label, commanderIds);

      await tx`update intakes set is_current = false where is_current`;
      await tx`update intakes set is_current = true where label = ${args.label}`;

      // 4. The incoming cohort. People FIRST — roster.pid is a foreign key into
      //    it, so a roster insert ahead of the registry fails outright.
      await upsertPeople(tx, plan);
      await insertRoster(tx, plan, colsFor.roster);
      const carriedCounts = await insertCarried(tx, plan, args.label, colsFor);

      for (const r of plan.returnees) {
        await tx`
          insert into intake_log (intake, pid, name, old_d4, new_d4, matched_by, rows_moved)
          values (${args.label}, ${r.pid}, ${r.name}, ${r.oldD4}, ${r.newD4}, ${r.tier},
                  ${tx.json(r.rowsMoved)})`;
      }

      // 5. Every tracked tab changed. Bumping each rev is what tells the
      //    devices in the field to pull instead of pushing their stale cache
      //    over the top of this.
      for (const tab of REV_TABS) await tx`select bump_rev(${tab})`;

      return { movedCounts, carriedCounts };
    });

    console.log("\n" + "─".repeat(72));
    console.log(`APPLIED. ${plan.stats.recruits} recruits in ${args.label}; ` +
                `${plan.stats.returnees} returnee(s) kept their records.`);
    console.log(`Archived under "${prevLabel}": ` +
                Object.entries(result.movedCounts).map(([t, n]) => `${t} ${n}`).join(", "));
    console.log("");
    console.log("Still to do by hand:");
    console.log("  1. Bump STORAGE_KEY in js/state.js (cougar-data-v2 -> -v3) and the ?v= in");
    console.log("     index.html. Every phone still holds the previous cohort in localStorage;");
    console.log("     the rev bumps above stop it overwriting anything, but until the cache is");
    console.log("     dropped those phones SHOW the old company.");
    console.log("  2. Redeploy the Edge Function so it picks up the new dropped_fields rows");
    console.log("     (it caches them for the life of a warm instance).");
    console.log("  3. The Conducts registry archived with everything else, so the new intake");
    console.log("     starts with an empty conduct list and types its own names in.");
    console.log("  4. Re-issue invites, and reset Telegram registrations so recruits re-register");
    console.log("     against the new 4Ds.");
    console.log("");
    console.log(`Read the archive any time:  select * from medical where intake = '${prevLabel}';`);
  } catch (e) {
    console.error("\nChangeover failed, nothing was committed:", e.message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

// Only run the driver when invoked directly, so test/intake.test.js can import
// parseArgs without opening a database connection.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

export { archiveCohort, main };
