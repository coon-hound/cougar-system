#!/usr/bin/env node
// ============================================================================
// depart.mjs - post one man out of the company: archive him, free his seat.
//
//   Preview (reads only, writes nothing):
//     DATABASE_URL=... node scripts/depart.mjs 9404
//     DATABASE_URL=... node scripts/depart.mjs "ALPHA TAN" --plt 5
//
//   Apply (one transaction; all of it or none of it):
//     ... --apply --reason "posted out to 46 SAR"
//
// WHY THIS IS NOT "DELETE HIM IN THE APP"
// ---------------------------------------
// Deleting a recruit in the app sets `deleted_at`, and purge_retention()
// (0002) then hard-deletes that row AND every child row keyed on his 4D once
// the retention window passes. For a man who left, that is not an archive - it
// is a 90-day fuse on his medical history.
//
// An archive is the 0004 pattern: his rows are RE-KEYED out of the live 4D
// namespace (`9404` -> `9404@16-out-20260921`) and soft-deleted. They stay in
// Postgres, stay indexed, stay joined to each other, and stay findable by pid
// if he ever comes back. 0007 is what teaches the purge and the two archive
// triggers to recognise that key, so the archive is durable rather than merely
// hidden.
//
// Re-keying him is also what frees the seat, and freeing a seat mid-section
// leaves a hole. Closing it re-keys a primary key across a set that overlaps
// itself - the same hazard reseat.mjs exists for - so it goes through the same
// two-phase rename through a temporary key, in the same transaction, over the
// same child tables DISCOVERED from the catalogue rather than listed here.
//
// PRIVACY: names are NOT printed unless --names is passed.
// ============================================================================

// `postgres` is imported lazily inside main(), NOT at the top level: CI runs
// `node test/run.js` with no `npm install`. See the same note in reseat.mjs.
import { pathToFileURL } from "node:url";

import { formatDepartReport, planDeparture } from "./depart-plan.mjs";
import { REV_TABS, TEMP, d4Tables } from "./reseat.mjs";

export function parseArgs(argv) {
  const out = { apply: false, names: false, keepSeat: false, plt: "", who: "", reason: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--names") out.names = true;
    // Leave his seat vacant instead of closing the hole. For the case where an
    // incoming man is already earmarked for it and renumbering the section
    // twice in a fortnight is the worse outcome.
    else if (a === "--keep-seat") out.keepSeat = true;
    else if (a === "--plt") out.plt = String(argv[++i] ?? "").trim();
    else if (a === "--reason") out.reason = String(argv[++i] ?? "").trim();
    else if (!a.startsWith("--") && !out.who) out.who = a;
  }
  return out;
}

/** Local calendar day, not UTC: the day boundary that matters is SGT. */
export function todayIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** What he carries, per table - for the report and for the intake_log. */
async function countRows(sql, tables, d4) {
  const counts = {};
  for (const t of tables) {
    const [{ n }] = await sql`select count(*)::int as n from ${sql(t.table)} where d4 = ${d4}`;
    if (n) counts[t.table] = n;
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL } = process.env;

  if (!args.who) {
    console.error('usage: DATABASE_URL=... node scripts/depart.mjs <4D|name> [--plt <n>] [--reason "..."] [--keep-seat] [--apply] [--names]');
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exitCode = 2;
    return;
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake }] = await sql`select label from intakes where is_current limit 1`;
    const roster = await sql`
      select "id", "name", "role", "pid" from roster
       where deleted_at is null and intake = ${intake}`;

    // Archive keys already spoken for. Only this seat's can collide, but the
    // whole set is one cheap query and the planner stays a pure function.
    const taken = await sql`select "id" from roster where "id" like '%@%'`;

    const plan = planDeparture({
      roster,
      who: args.who,
      plt: args.plt,
      intake,
      today: todayIso(),
      takenKeys: taken.map((r) => r.id),
      renumber: !args.keepSeat,
    });

    const tables = plan.man ? await d4Tables(sql) : [];
    const carried = plan.man ? await countRows(sql, tables, plan.man.id) : null;

    console.log(formatDepartReport(plan, { names: args.names, carries: carried, reason: args.reason }));

    if (!plan.ok) { process.exitCode = 1; return; }
    if (!args.apply) {
      console.log("\nPreview only. Nothing was written. Add --apply to post him out.");
      return;
    }

    // old -> temp, then temp -> new, for the men closing the hole. Two phases
    // because roster's primary key is not deferrable: a single UPDATE moving
    // 9405 into 9404 while 9404 still exists trips the unique index on the
    // first row, even though the set as a whole is a clean permutation. His own
    // row is re-keyed out of the way FIRST, which is what makes 9404 free at
    // all - so the archive and the renumber cannot be separated.
    const toTemp = Object.fromEntries(plan.moves.map((m) => [m.oldId, TEMP + m.oldId]));
    const toNew = Object.fromEntries(plan.moves.map((m) => [TEMP + m.oldId, m.newId]));
    const pidMap = Object.fromEntries(plan.moves.filter((m) => m.pid).map((m) => [m.pid, m.newId]));

    const touched = await sql.begin(async (tx) => {
      const n = { archived: {}, renumbered: {} };
      const oldId = plan.man.id;
      const key = plan.archiveKey;

      // ── 1. Archive him ────────────────────────────────────────────────────
      const r = await tx`
        update roster
           set "id" = ${key}, "4d" = 'C' || ${key}, deleted_at = coalesce(deleted_at, now())
         where "id" = ${oldId}`;
      n.archived.roster = r.count;

      for (const t of tables) {
        // The SET list is built from the columns the table actually has.
        // auth_tokens and invites carry no deleted_at - they are revoked
        // instead, and revoking them is not optional: a token left pointing at
        // a bare 4D would, the moment somebody moves up into that seat, be a
        // departed man's phone reading and writing as the man who replaced him.
        const sets = [`"d4" = $1`];
        if (t.has_deleted) sets.push("deleted_at = coalesce(deleted_at, now())");
        if (t.has_revoked) sets.push("revoked_at = coalesce(revoked_at, now())");
        const res = await tx.unsafe(
          `update "${t.table}" set ${sets.join(", ")} where "d4" = $2`, [key, oldId]);
        if (res.count) n.archived[t.table] = res.count;
      }

      // ── 2. Close the hole ─────────────────────────────────────────────────
      for (const map of [toTemp, toNew]) {
        if (!Object.keys(map).length) break;
        const j = tx.json(map);

        // roster."4d" is the display form of the same value, kept in step here
        // rather than by a trigger so the two can never disagree.
        const rr = await tx`
          update roster t
             set "id" = x.value, "4d" = 'C' || x.value
            from jsonb_each_text(${j}::jsonb) x
           where t."id" = x.key and t.intake = ${intake} and t.deleted_at is null`;
        n.renumbered.roster = (n.renumbered.roster ?? 0) + rr.count;

        for (const t of tables) {
          // Scoped to the current intake where the table carries one, so a
          // renumber can never reach into an archived cohort's rows. The
          // archived man is already out of reach either way: his d4 now holds
          // an "@" and matches nothing in this map.
          const res = t.has_intake
            ? await tx`update ${tx(t.table)} u set d4 = x.value
                         from jsonb_each_text(${j}::jsonb) x
                        where u.d4 = x.key and u.intake = ${intake}`
            : await tx`update ${tx(t.table)} u set d4 = x.value
                         from jsonb_each_text(${j}::jsonb) x
                        where u.d4 = x.key`;
          if (res.count) n.renumbered[t.table] = (n.renumbered[t.table] ?? 0) + res.count;
        }
      }

      // ── 3. The person registry ────────────────────────────────────────────
      //
      // His last_d4 becomes the ARCHIVE key, not the 4D he used to hold. That
      // matters: person_history joins people.last_d4 to the live roster, so
      // leaving him on "9404" would file him under whichever man moves up into
      // that seat an hour later - a departed man showing the rank and seat of
      // somebody else entirely.
      if (plan.man.pid) {
        await tx`
          update people
             set last_d4    = ${key},
                 d4_history = case when d4_history @> array[${key}::text]
                                   then d4_history else d4_history || ${key}::text end
           where pid = ${plan.man.pid}`;
      }
      if (Object.keys(pidMap).length) {
        await tx`
          update people p
             set last_d4    = x.value,
                 d4_history = case when p.d4_history @> array[x.value]
                                   then p.d4_history else p.d4_history || x.value end
            from jsonb_each_text(${tx.json(pidMap)}::jsonb) x
           where p.pid = x.key`;
      }

      // ── 4. The log ────────────────────────────────────────────────────────
      await tx`
        insert into intake_log (intake, pid, name, old_d4, new_d4, matched_by, rows_moved, note)
        values (${intake}, ${plan.man.pid ?? null}, ${plan.man.name}, ${oldId}, ${key}, 'depart',
                ${tx.json(carried ?? {})}, ${args.reason || null})`;
      for (const m of plan.moves) {
        await tx`
          insert into intake_log (intake, pid, name, old_d4, new_d4, matched_by, rows_moved, note)
          values (${intake}, ${m.pid}, ${m.name}, ${m.oldId}, ${m.newId}, 'depart-renumber',
                  '{}'::jsonb, ${`section closed up after ${oldId} left`})`;
      }

      for (const tab of REV_TABS) await tx`select bump_rev(${tab})`;
      return n;
    });

    console.log("\n" + "─".repeat(72));
    console.log(`APPLIED. ${plan.man.id} is archived as ${plan.archiveKey}.`);
    console.log("Rows archived:");
    for (const [t, c] of Object.entries(touched.archived)) if (c) console.log(`  ${t}  ${c}`);
    if (plan.moves.length) {
      console.log(`Rows re-keyed closing section ${plan.sect} (both phases, so twice the row count):`);
      for (const [t, c] of Object.entries(touched.renumbered)) if (c) console.log(`  ${t}  ${c}`);
    }
    console.log("");
    console.log("Still to do by hand:");
    console.log("  1. Bump STORAGE_KEY in js/state.js and the ?v= in index.html, then deploy.");
    console.log("     Every phone still holds the old seating; until the cache is dropped a");
    console.log("     commander can write a row against a 4D that now belongs to someone else.");
    console.log("  2. Re-issue invites for anyone whose 4D moved.");
    console.log("  3. His device access is already revoked - he keeps nothing.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
