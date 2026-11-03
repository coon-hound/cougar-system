#!/usr/bin/env node
// ============================================================================
// quals-grant.mjs - give one qualification to everyone on the roster EXCEPT
// the men on a list, or to ONLY the men on a list.
//
//   Preview (runs every write, then rolls back):
//     DATABASE_URL=... COUGAR_ENC_KEY=... node scripts/quals-grant.mjs \
//       --qual "PTCO JVLF" --except not-qualified.csv
//     DATABASE_URL=... COUGAR_ENC_KEY=... node scripts/quals-grant.mjs \
//       --qual "LMG LF" --only fired.csv
//
//   Apply (one transaction):
//     ... --apply
//
//   Settle a list line the script could not place:
//     ... --pin 12=9302      (list line 12 is the man in 9302)
//     ... --skip 12          (list line 12 is not on the roster at all)
//
// WHAT IT WRITES
// --------------
// --except: the qualification is appended to extra.quals of every live roster
// row (commanders included) that is not on the list. --only: it is appended to
// the listed men and nobody else. It only ever ADDS: a man who
// already has it is left alone, and a man on the list who already has it keeps
// it - the list is "not qualified", which is not evidence enough to strip what
// someone recorded.
//
// WHO IS EXCLUDED
// ---------------
// The list is a CSV with a name column and optionally an NRIC or a 4D column.
// Each line is placed on a seat by its 4D (read like --pin, but a name that
// does not fully match that seat is flagged), by its NRIC (keyed digest
// against the people registry, exact), or failing that by an EXACT
// order-independent name match to exactly one seat. The run REFUSES TO APPLY
// while any line is unplaced: with --except an unplaced man would be granted
// the qualification, with --only a man who earned it would be missed.
// --pin or --skip settles each such line.
//
// PRIVACY: the report prints list line numbers and 4Ds, never names or NRICs.
// The raw NRIC stops in this process; only its digest is compared. Keep the
// list outside the repo (*.csv is gitignored).
// ============================================================================

// `postgres` is imported lazily inside main(); see the note in reseat.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { nameKey, nameSimilarity, nricKey, padD4, parseCsv } from "./intake-plan.mjs";
import { addQuals } from "./quals-fill.mjs";

export function parseArgs(argv) {
  const out = { apply: false, qual: "", file: "", mode: "", pins: new Map(), skips: new Set(), errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--qual") out.qual = String(argv[++i] ?? "").trim();
    else if (a === "--except" || a === "--only") {
      if (out.mode) out.errors.push("give one of --except or --only, not both");
      out.mode = a.slice(2);
      out.file = String(argv[++i] ?? "").trim();
    }
    else if (a === "--pin") {
      const m = String(argv[++i] ?? "").match(/^(\d+)=(\d{1,4})$/);
      if (m) out.pins.set(+m[1], padD4(m[2]));
      else out.errors.push(`--pin wants LINE=4D, got "${argv[i] ?? ""}"`);
    } else if (a === "--skip") {
      const m = String(argv[++i] ?? "").match(/^(\d+)$/);
      if (m) out.skips.add(+m[1]);
      else out.errors.push(`--skip wants a list line number, got "${argv[i] ?? ""}"`);
    } else out.errors.push(`unknown argument "${a}"`);
  }
  if (!out.qual) out.errors.push("--qual is required");
  else if (/[,@]/.test(out.qual)) out.errors.push(`--qual "${out.qual}" cannot contain "," or "@" (they separate quals and expiries)`);
  if (!out.file) out.errors.push("--except LIST or --only LIST is required");
  return out;
}

const canon = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** The list: { line, nric (raw, stays here), name, d4 }. Line numbers are CSV lines. */
export function parseExceptList(text) {
  return parseCsv(text).map((raw, n) => {
    const v = {};
    for (const [h, val] of Object.entries(raw)) {
      const c = canon(h);
      if (!("d4" in v) && c === "4d") v.d4 = val;
      else if (!("nric" in v) && c.includes("nric")) v.nric = val;
      else if (!("name" in v) && (c === "name" || c === "fullname" || c.endsWith("name"))) v.name = val;
    }
    const d4 = String(v.d4 ?? "").trim();
    const row = { line: n + 2, nric: String(v.nric ?? "").trim(), name: String(v.name ?? "").trim() };
    if (d4) row.d4 = padD4(d4);
    return row;
  }).filter(r => r.nric || r.name || r.d4);
}

/**
 * Who is on the list, who gets the qual. Pure: no database.
 * mode "except" grants everyone NOT listed; "only" grants just the listed.
 * @param {string}   text     the list CSV
 * @param {object[]} roster   live rows { id, name, pid, role, quals }
 * @param {Map<string,string>} pidByNric  NRIC digest -> people.pid
 * @param {(s:string)=>string} hash       keyed digest
 */
export function planGrant(text, roster, pidByNric, hash, { qual, mode = "except", pins = new Map(), skips = new Set() }) {
  const byId = new Map(roster.map(r => [padD4(r.id), r]));
  const byPid = new Map(roster.filter(r => r.pid).map(r => [r.pid, r]));
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

  const excluded = [], unplaced = [], skipped = [];
  for (const l of parseExceptList(text)) {
    if (skips.has(l.line)) { skipped.push({ line: l.line }); continue; }
    if (pins.has(l.line)) {
      const seat = byId.get(pins.get(l.line));
      if (seat) excluded.push({ line: l.line, id: padD4(seat.id), how: "pinned" });
      else unplaced.push({ line: l.line, why: `pinned to ${pins.get(l.line)}, which is not a seat on the roster`, near: [] });
      continue;
    }
    if (l.d4) {
      const seat = byId.get(l.d4);
      if (!seat) { unplaced.push({ line: l.line, why: `4D ${l.d4} is not a seat on the roster`, near: near(l.name) }); continue; }
      const score = l.name ? nameSimilarity(l.name, seat.name) : 1;
      const warn = score < 1 ? `name only ${Math.round(score * 100)}% like the seat's - check it` : "";
      excluded.push({ line: l.line, id: padD4(seat.id), how: "4d", warn });
      continue;
    }
    const nk = nricKey(l.nric);
    if (l.nric && !nk) { unplaced.push({ line: l.line, why: "NRIC is not a full NRIC", near: [] }); continue; }
    const byNric = nk ? byPid.get(pidByNric.get(hash(`nric:${nk}`))) : null;
    const hits = byKey.get(nameKey(l.name)) || [];
    if (byNric) {
      const warn = nameKey(byNric.name) === nameKey(l.name) ? "" : "NRIC matches, name differs";
      excluded.push({ line: l.line, id: padD4(byNric.id), how: "nric", warn });
    } else if (hits.length === 1) {
      excluded.push({ line: l.line, id: padD4(hits[0].id), how: "name" });
    } else {
      unplaced.push({
        line: l.line,
        why: hits.length ? `name matches ${hits.length} seats (${hits.map(h => padD4(h.id)).join(", ")})` : "no NRIC or exact name match",
        near: hits.length ? [] : near(l.name),
      });
    }
  }

  // Two list lines on one seat means one of them is wrong.
  const count = new Map();
  excluded.forEach(e => count.set(e.id, (count.get(e.id) || 0) + 1));
  for (const e of excluded.filter(e => count.get(e.id) > 1)) {
    unplaced.push({ line: e.line, why: `${e.id} is matched by more than one list line`, near: [] });
  }

  const out = new Set(excluded.map(e => e.id));
  const has = r => addQuals(r.quals, [qual]).added.length === 0;
  const grant = [], already = [];
  for (const r of roster) {
    const id = padD4(r.id);
    if (out.has(id) !== (mode === "only")) continue;
    (has(r) ? already : grant).push({ id, role: r.role || "" });
  }
  const sortId = (a, b) => a.id.localeCompare(b.id);
  return {
    excluded: excluded.sort((a, b) => a.line - b.line),
    excludedHolding: mode === "only" ? [] : roster.filter(r => out.has(padD4(r.id)) && has(r)).map(r => padD4(r.id)).sort(),
    unplaced: unplaced.sort((a, b) => a.line - b.line),
    skipped,
    grant: grant.sort(sortId),
    already: already.sort(sortId),
  };
}

const byRole = rows => {
  const m = {};
  rows.forEach(r => { const k = r.role || "(no role)"; m[k] = (m[k] || 0) + 1; });
  return Object.entries(m).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
};

class Rollback extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL, COUGAR_ENC_KEY } = process.env;
  if (args.errors.length) {
    for (const e of args.errors) console.error(e);
    console.error('usage: DATABASE_URL=... COUGAR_ENC_KEY=... node scripts/quals-grant.mjs --qual "NAME" (--except|--only) list.csv [--pin LINE=4D]... [--skip LINE]... [--apply]');
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL || !COUGAR_ENC_KEY) { console.error("DATABASE_URL and COUGAR_ENC_KEY must both be set."); process.exitCode = 2; return; }
  const hash = (s) => crypto.createHmac("sha256", COUGAR_ENC_KEY).update(String(s)).digest("hex");

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const roster = await sql`select "id", "name", pid, "role", extra ->> 'quals' as quals
                               from roster where deleted_at is null`;
    const people = await sql`select pid, nric_hash from people where nric_hash is not null`;
    const pidByNric = new Map(people.map(p => [p.nric_hash, p.pid]));
    const plan = planGrant(fs.readFileSync(args.file, "utf8"), roster, pidByNric, hash, args);

    console.log(`Qualification: ${args.qual}`);
    console.log(`Roster: ${roster.length} live seats (${byRole(roster.map(r => ({ role: r.role })))})`);
    const only = args.mode === "only";
    console.log(`\n${only ? "On the list (only these can get it)" : "Excluded by the list"}: ${plan.excluded.length}`);
    for (const e of plan.excluded) {
      console.log(`  line ${String(e.line).padStart(3)}  ${e.id}  by ${e.how}${e.warn ? `  ! ${e.warn}` : ""}`);
    }
    if (plan.excludedHolding.length) {
      console.log(`  Already hold it (left alone - this only adds): ${plan.excludedHolding.join(", ")}`);
    }
    if (plan.skipped.length) console.log(`  Skipped by hand (--skip): line ${plan.skipped.map(s => s.line).join(", ")}`);
    if (plan.unplaced.length) {
      console.log(`\nUNPLACED ${plan.unplaced.length} list line(s):`);
      for (const u of plan.unplaced) console.log(`  line ${String(u.line).padStart(3)}  ${u.why}${u.near.length ? `  - closest: ${u.near.join(", ")}` : ""}`);
      console.log(`  Each would otherwise be ${only ? "MISSED" : "GIVEN the qualification"}. Settle with --pin LINE=4D, or --skip LINE if he is not on the roster.`);
    }
    console.log(`\nGets ${args.qual}: ${plan.grant.length} (${byRole(plan.grant)})`);
    console.log(`  ${plan.grant.map(g => g.id).join(" ") || "-"}`);
    if (plan.already.length) console.log(`Already hold it: ${plan.already.length}`);

    if (args.apply && plan.unplaced.length) {
      console.error("\nREFUSED: nothing written. Every list line must be placed or skipped before --apply.");
      process.exitCode = 1;
      return;
    }

    try {
      await sql.begin(async (tx) => {
        let n = 0;
        for (const g of plan.grant) {
          const [cur] = await tx`select extra ->> 'quals' as quals from roster
                                  where "id" = ${g.id} and deleted_at is null for update`;
          if (!cur) continue;
          const q = addQuals(cur.quals, [args.qual]);
          if (!q.added.length) continue;
          await tx`update roster set extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{quals}', to_jsonb(${q.value}::text))
                    where "id" = ${g.id} and deleted_at is null`;
          n++;
        }
        if (n !== plan.grant.length) throw new Error(`expected ${plan.grant.length} writes, made ${n}: the roster changed under the run; nothing written`);
        await tx`select bump_rev('Roster')`;
        if (!args.apply) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    console.log(args.apply
      ? `\nAPPLIED. ${plan.grant.length} seat(s) given ${args.qual}. Phones pick it up on their next sync.`
      : `\nPreview only: every write ran and was rolled back.${plan.unplaced.length ? " --apply is refused until the UNPLACED lines are settled." : " Add --apply to keep it."}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
}
