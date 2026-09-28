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
// MOVES AND LATE ENLISTEES (--move, --enlist): one man posted to another
// section, or a new man seated in one. Only the sections whose membership
// changes are re-dealt, alphabetically, all in one pass - see planTransfer.
//
//   node scripts/reseat.mjs --move "ALPHA TAN" 94 --move 7103 72
//   COUGAR_ENC_KEY=... node scripts/reseat.mjs --enlist late.csv
//
// PRIVACY: names are NOT printed unless --names is passed. The report is the
// thing that gets pasted into a chat or a PR, and 4Ds alone are enough to
// check it.
// ============================================================================

// `postgres` is imported lazily inside main(), NOT at the top level.
// `.github/workflows/test.yml` runs `node test/run.js` with no `npm install`,
// so anything a unit test can reach must not pull in an npm package on load -
// it passes locally, where node_modules exists, and fails only in CI with
// ERR_MODULE_NOT_FOUND. scripts/issue-invites.mjs broke the job exactly that
// way. A static guard in test/static.test.js enforces it.
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  CARRY_RULES, ENCRYPTED, carryRecord, mintPid, nameKey, nameSimilarity, normaliseRollRow,
  nricKey, parseCsv, rosterRowFromRoll, sharedTokens,
} from "./intake-plan.mjs";
import {
  formatReseatReport, formatSwapReport, formatTransferReport, parseSect,
  parseSections, planReseat, planSwap, planTransfer,
} from "./reseat-plan.mjs";

// Exactly REV_TABS (Edge Function). A re-section can touch any of them, and a
// tab whose rev did not move is a tab every phone in the field still believes
// its stale cache of — which it will then push back over the top of this.
export const REV_TABS = [
  "Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC",
  "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts",
  "Duty", "Calendar", "OilRules",
];

// The temporary key the rename passes through. "~" sorts above every digit and
// letter and is not legal in any 4D, so a half-finished run is obvious rather
// than plausible.
export const TEMP = "~";

export function parseArgs(argv) {
  const out = { apply: false, names: false, plt: "", file: "", swap: null, moves: [], enlist: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--names") out.names = true;
    else if (a === "--plt") out.plt = String(argv[++i] ?? "").trim();
    // Two men exchange their existing 4Ds and nothing else moves. Each side is
    // a 4D or an exact name; quote a name so the shell keeps it in one word.
    else if (a === "--swap") out.swap = [String(argv[++i] ?? "").trim(), String(argv[++i] ?? "").trim()];
    // One man to another section: a 4D or exact name, then the section ("94").
    // Repeatable; every --move and --enlist in one run is planned together.
    else if (a === "--move") out.moves.push({ who: String(argv[++i] ?? "").trim(), to: String(argv[++i] ?? "").trim() });
    // A roll-format CSV of late enlistees, one per row, each with a Section.
    else if (a === "--enlist") out.enlist = String(argv[++i] ?? "").trim();
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
export async function d4Tables(sql) {
  const rows = await sql`
    select c.relname                                         as table,
           a.attname                                         as col,
           bool_or(a2.attname = 'intake')                    as has_intake,
           -- depart.mjs builds its archive UPDATE from these two: not every
           -- d4-keyed table carries a deleted_at (auth_tokens and invites are
           -- revoked instead), and a SET list naming a column that is not
           -- there fails the whole transaction.
           bool_or(a2.attname = 'deleted_at')                as has_deleted,
           bool_or(a2.attname = 'revoked_at')                as has_revoked
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
      join pg_attribute a2 on a2.attrelid = c.oid and a2.attnum > 0 and not a2.attisdropped
     where n.nspname = 'public'
       and c.relkind = 'r'
       and a.attnum > 0 and not a.attisdropped
       and lower(a.attname) = 'd4'
       and c.relname <> 'audit'
     group by c.relname, a.attname
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

/**
 * Read a roll-format CSV of late enlistees. Same header aliases as a nominal
 * roll (intake-plan.mjs), plus a target section: `Section` as "72", or
 * `Platoon` 7 + `Section` 2. The raw NRIC stops here - only its keyed digest
 * leaves this function, exactly as in the changeover.
 */
export function readEnlistees(text, { hash }) {
  const issues = [];
  const unknown = new Set();
  const enlistees = parseCsv(text).map((raw, n) => {
    const { row, unknown: u } = normaliseRollRow(raw);
    for (const h of u) unknown.add(h);
    const to = parseSect(row.sect) || parseSect(`${row.plt ?? ""}${row.sect ?? ""}`);
    const nk = nricKey(row.nric);
    if (row.nric && !nk) issues.push({ level: "error", message: `enlistee ${n + 1}: NRIC is not a full NRIC (letter, 7 digits, letter)` });
    const src = { ...row, nric: undefined, name: String(row.name ?? "").trim().toUpperCase() };
    return {
      name: src.name,
      to: to || String(row.sect ?? ""),
      src,
      nricHash: nk ? hash(`nric:${nk}`) : "",
      pidOverride: String(row.pid ?? "").trim(),
    };
  });
  return { enlistees, issues, unknown: [...unknown] };
}

/**
 * Settle who each enlistee IS before he is seated.
 *
 * A late enlistee is often NOT new: a man who was in an earlier intake (BMT,
 * a re-course) and is only now being posted in. His records sit in the archive
 * under a key like `1113@bmt`, and seating him as a stranger would strand that
 * history - his injuries and IPPT - exactly where nobody looks.
 *
 * So, in order:
 *   1. `PID` in his row settles it outright: a registry pid, an archive key
 *      (`1113@bmt`) naming his archived seat, or NEW for a genuinely new man.
 *   2. The registry (`people`): same NRIC digest, or same name key.
 *   3. The archived roster: same name key, exactly one row -> a returnee, the
 *      same NAME tier the changeover accepts automatically.
 *   4. A near miss in either (the changeover's fuzzy rule) BLOCKS, because a
 *      mistyped name would otherwise quietly enlist a returnee as a stranger.
 *
 * Mutates each enlistee with { pid, tier, returnee?: { archiveD4, oldD4 } }.
 */
export function resolveEnlistees(enlistees, { people, archived, seatedPids, intake, hash }) {
  const issues = [];
  const byPid = new Map(people.map((p) => [p.pid, p]));
  const byArchive = new Map(archived.map((a) => [a.id, a]));
  const taken = new Set(people.map((p) => p.pid));
  const bare = (id) => String(id).split("@")[0];
  const near = (a, b) => nameSimilarity(a, b) >= 0.8 && sharedTokens(a, b) >= 2;

  for (const [n, e] of enlistees.entries()) {
    const side = `enlistee ${n + 1}`;
    const ov = e.pidOverride;
    const key = nameKey(e.name);

    if (ov.toUpperCase() === "NEW") {
      e.tier = "new";
    } else if (ov && ov.includes("@")) {
      const a = byArchive.get(ov);
      if (!a) { issues.push({ level: "error", message: `${side}: ${ov} is not an archived seat` }); continue; }
      e.tier = "override";
      e.returnee = { archiveD4: a.id, oldD4: bare(a.id) };
    } else if (ov) {
      const p = byPid.get(ov);
      if (!p) { issues.push({ level: "error", message: `${side}: PID ${ov} does not exist` }); continue; }
      if (seatedPids.has(ov)) { issues.push({ level: "error", message: `${side}: PID ${ov} already holds a seat in this intake` }); continue; }
      e.pid = ov; e.tier = "pid"; continue;
    } else {
      const reg = people.find((p) => e.nricHash && p.nric_hash === e.nricHash)
               ?? people.find((p) => p.name_key === key);
      if (reg) {
        issues.push({
          level: "error",
          message: `${side}: the registry already knows this man as ${reg.pid} ` +
                   `(last intake ${reg.last_intake ?? "?"}, last 4D ${reg.last_d4 ?? "?"}). ` +
                   `Put PID ${reg.pid} in his row if it is him, or NEW if it is not.`,
        });
        continue;
      }
      const exact = archived.filter((a) => nameKey(a.name) === key);
      if (exact.length > 1) {
        issues.push({
          level: "error",
          message: `${side}: matches ${exact.length} archived seats (${exact.map((a) => a.id).join(", ")}). ` +
                   `Put the right one in his PID column, or NEW.`,
        });
        continue;
      }
      if (exact.length === 1) {
        e.tier = "name";
        e.returnee = { archiveD4: exact[0].id, oldD4: bare(exact[0].id) };
      } else {
        const close = [...people.map((p) => ({ id: p.pid, name: p.name })), ...archived]
          .filter((c) => near(e.name, c.name));
        if (close.length) {
          issues.push({
            level: "error",
            message: `${side}: no exact match, but close to ${close.map((c) => c.id).join(", ")}. ` +
                     `Put that id in his PID column if it is him, or NEW if it is not.`,
          });
          continue;
        }
        e.tier = "new";
      }
    }
    e.pid = mintPid(hash, e.nricHash ? `nric:${e.nricHash}` : `name:${key}|intake:${intake}`, taken);
  }
  return issues;
}

/**
 * The writes, shared by every mode so they cannot drift apart: the two-phase
 * rename of existing men, then any enlistees inserted into the seats the plan
 * dealt them (with a returnee's archived history carried onto the new seat),
 * the people registry, the intake_log and the rev bump - one transaction.
 */
async function applyPlan(sql, { intake, cutoff, moves, inserts = [], matchedBy, encKey, hash }) {
  const tables = await d4Tables(sql);
  const oldIds = moves.map((m) => m.oldId);
  const carried = await countRows(sql, tables, oldIds, intake);

  // old -> temp, then temp -> new. Two phases because roster's primary key is
  // not deferrable: a single UPDATE re-keying 9301 to 9102 while 9102 still
  // exists trips the unique index the moment it reaches the first row, even
  // though the set as a whole is a clean permutation.
  const toTemp = Object.fromEntries(moves.map((m) => [m.oldId, TEMP + m.oldId]));
  const toNew = Object.fromEntries(moves.map((m) => [TEMP + m.oldId, m.newId]));
  const pidMap = Object.fromEntries(moves.filter((m) => m.pid).map((m) => [m.pid, m.newId]));

  return sql.begin(async (tx) => {
    const n = {};

    for (const map of moves.length ? [toTemp, toNew] : []) {
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

    for (const m of moves) {
      await tx`
        insert into intake_log (intake, pid, name, old_d4, new_d4, matched_by, rows_moved)
        values (${intake}, ${m.pid}, ${m.name}, ${m.oldId}, ${m.newId}, ${matchedBy},
                ${tx.json(carried.get(m.oldId) ?? {})})`;
    }

    // Enlistees, AFTER the rename: the seat he is dealt may be one a moving
    // man only just vacated. People first - roster.pid is a foreign key into it.
    const colsOf = async (table) => new Set((await tx`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = ${table}`).map((r) => r.column_name));
    const rosterCols = inserts.length ? await colsOf("roster") : null;

    for (const { newId, ref } of inserts) {
      // A returnee's history reads [old seat, new seat], exactly as the
      // changeover wrote it for the men who came through with the cohort.
      const history = ref.returnee ? [ref.returnee.oldD4, newId] : [newId];
      await tx`
        insert into people (pid, name, name_key, nric_hash, first_intake, last_intake, last_d4, d4_history)
        values (${ref.pid}, ${ref.name}, ${nameKey(ref.name)}, ${ref.nricHash || null},
                ${intake}, ${intake}, ${newId}, ${history})
        on conflict (pid) do update
          set last_intake = excluded.last_intake,
              last_d4     = excluded.last_d4,
              nric_hash   = coalesce(people.nric_hash, excluded.nric_hash),
              d4_history  = case when people.d4_history @> array[excluded.last_d4]
                                 then people.d4_history else people.d4_history || excluded.last_d4 end`;

      const plain = {}, enc = {};
      for (const [k, v] of Object.entries(rosterRowFromRoll(ref.src, newId))) {
        if (!rosterCols.has(k)) continue;
        if (ENCRYPTED.has(k)) { if (String(v ?? "") !== "") enc[k] = String(v); }
        else plain[k] = String(v ?? "");
      }
      plain.pid = ref.pid;
      plain.intake = intake;
      await tx`insert into roster ${tx(plain)}`;
      for (const [k, v] of Object.entries(enc)) {
        await tx`update roster set ${tx(k)} = enc_col(${v}, ${encKey})
                  where "id" = ${newId} and intake = ${intake}`;
      }
      n.roster = (n.roster ?? 0) + 1;

      // His archived history, copied onto the new seat by the same rules the
      // changeover used. The archived originals stay where they are.
      const moved = {};
      if (ref.returnee) {
        for (const [key, rule] of Object.entries(CARRY_RULES)) {
          if (rule.carry !== "person" && rule.carry !== "future") continue;
          const cols = await colsOf(rule.table);
          const rows = await tx`
            select api_row(to_jsonb(t)) as row from ${tx(rule.table)} t
             where t.d4 = ${ref.returnee.archiveD4}`;
          for (const { row } of rows) {
            const c = carryRecord(key, row, newId, { cutoff, label: intake, hash });
            if (!c) continue;
            const out = {};
            for (const [k, v] of Object.entries(c.copy)) if (cols.has(k)) out[k] = v == null ? "" : String(v);
            out.intake = intake;
            await tx`insert into ${tx(rule.table)} ${tx(out)}`;
            moved[key] = (moved[key] ?? 0) + 1;
            n[rule.table] = (n[rule.table] ?? 0) + 1;
            if (c.clamped) console.log(`  medical status closed on carry: ${c.clamped.status} (was ${c.clamped.was})`);
          }
        }
      }

      await tx`
        insert into intake_log (intake, pid, name, old_d4, new_d4, matched_by, rows_moved)
        values (${intake}, ${ref.pid}, ${ref.name}, ${ref.returnee?.oldD4 ?? null}, ${newId},
                ${ref.tier ?? "new"}, ${tx.json(moved)})`;
    }

    for (const tab of REV_TABS) await tx`select bump_rev(${tab})`;
    return n;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL, COUGAR_ENC_KEY } = process.env;
  const transfer = args.moves.length > 0 || !!args.enlist;

  if (!args.swap && !transfer && (!args.file || !args.plt)) {
    console.error("usage: DATABASE_URL=... node scripts/reseat.mjs <sections.txt> --plt <n> [--apply] [--names]");
    console.error("       DATABASE_URL=... node scripts/reseat.mjs --swap <4D|name> <4D|name> [--plt <n>] [--apply] [--names]");
    console.error("       DATABASE_URL=... node scripts/reseat.mjs [--move <4D|name> <sect>]... [--enlist <roll.csv>] [--apply] [--names]");
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exitCode = 2;
    return;
  }
  // The NRIC digest, the carried-row ids and the encrypted columns all need
  // the key; an enlistee seated without it would carry no DOB, NOK or address.
  if (args.enlist && !COUGAR_ENC_KEY) {
    console.error("COUGAR_ENC_KEY is not set (needed to seat an enlistee).");
    process.exitCode = 2;
    return;
  }

  let sections = [];
  if (!args.swap && !transfer) {
    const parsed = parseSections(fs.readFileSync(args.file, "utf8"));
    if (parsed.issues.length) {
      for (const i of parsed.issues) console.error(`✗ ${i.message}`);
      process.exitCode = 1;
      return;
    }
    sections = parsed.sections;
  }

  const hash = (s) => crypto.createHmac("sha256", COUGAR_ENC_KEY ?? "").update(String(s)).digest("hex");
  let enlistees = [];
  if (args.enlist) {
    const read = readEnlistees(fs.readFileSync(args.enlist, "utf8"), { hash });
    if (read.unknown.length) console.log(`Columns skipped (not stored): ${read.unknown.join(", ")}`);
    if (read.issues.length) {
      for (const i of read.issues) console.error(`✗ ${i.message}`);
      process.exitCode = 1;
      return;
    }
    enlistees = read.enlistees;
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake, cutoff_date: cutoffDate }] =
      await sql`select label, cutoff_date from intakes where is_current limit 1`;
    const cutoff = cutoffDate instanceof Date ? cutoffDate.toISOString().slice(0, 10) : String(cutoffDate ?? "");
    const roster = await sql`
      select "id", "name", "role", "pid" from roster
       where deleted_at is null and intake = ${intake}`;

    if (enlistees.length) {
      const people = await sql`select pid, name, name_key, nric_hash, last_intake, last_d4 from people`;
      // Archived enlistees of earlier intakes: where a returnee's history is.
      const archived = await sql`
        select "id", "name", intake from roster
         where intake <> ${intake} and position('@' in "id") > 0
           and coalesce("role", '') <> 'Commander'`;
      const seatedPids = new Set(roster.map((r) => r.pid).filter(Boolean));
      const who = resolveEnlistees(enlistees, { people, archived, seatedPids, intake, hash });
      if (who.length) {
        for (const i of who) console.error(`✗ ${i.message}`);
        console.error("\nBLOCKED. Nothing was written.");
        process.exitCode = 1;
        return;
      }
      for (const [n, e] of enlistees.entries()) {
        console.log(`enlistee ${n + 1}: ${e.returnee
          ? `RETURNEE from ${e.returnee.archiveD4} (matched by ${e.tier}); person-scoped history carries`
          : "new to the company"}${args.names ? `  ${e.name}` : ""}`);
      }
    }

    // Every path produces the same { ok, moves: [{oldId,newId,name,pid}] }
    // shape, so the apply below is shared and cannot drift between modes.
    const plan = args.swap
      ? planSwap({ plt: args.plt, roster, a: args.swap[0], b: args.swap[1] })
      : transfer
        ? planTransfer({ roster, moves: args.moves, enlistees })
        : planReseat({ plt: args.plt, roster, sections });
    console.log(args.swap
      ? formatSwapReport(plan, { names: args.names })
      : transfer
        ? formatTransferReport(plan, { names: args.names })
        : formatReseatReport(plan, { names: args.names }));

    if (!plan.ok) { process.exitCode = 1; return; }
    const inserts = plan.inserts ?? [];
    if (!plan.moves.length && !inserts.length) {
      console.log("\nNothing to do — every man already holds the right 4D.");
      return;
    }
    const verb = args.swap ? "swap" : transfer ? "transfer" : "re-seat";
    if (!args.apply) {
      console.log(`\nPreview only. Nothing was written. Add --apply to ${verb}.`);
      return;
    }

    const touched = await applyPlan(sql, {
      intake, cutoff, moves: plan.moves, inserts, encKey: COUGAR_ENC_KEY, hash,
      matchedBy: args.swap ? "swap" : transfer ? "move" : "reseat",
    });

    console.log("\n" + "─".repeat(72));
    console.log(args.swap
      ? `APPLIED. ${plan.moves[0].oldId} and ${plan.moves[1].oldId} have exchanged seats.`
      : transfer
        ? `APPLIED. ${plan.moves.length} man/men re-seated, ${inserts.length} enlistee(s) seated.`
        : `APPLIED. ${plan.moves.length} men re-seated in platoon ${plan.plt}.`);
    console.log("Rows written (a rename touches each row twice):");
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
