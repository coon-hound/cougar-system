#!/usr/bin/env node
// ============================================================================
// billet-fill.mjs — set the section role ("1 LMG", "GL", "2 MAT"…) of men
// who are already seated, from a two-column list of name and role.
//
//   Preview (runs every write, then rolls back):
//     DATABASE_URL=... node scripts/billet-fill.mjs roles.csv
//
//   Apply (one transaction):
//     ... --apply
//
// The list is keyed by NAME, not 4D, because that is how the company keeps it.
// A name lands on a seat only on an EXACT order-independent match (nameKey) to
// exactly one man in the current intake. Anything else - no match, two men with
// that name, the same man listed twice - BLOCKS the whole run, and the report
// names the closest seats so a human can fix the spelling in the list. A loose
// match is a guess about whose record this is (CLAUDE.md, "Names in this
// dataset").
//
// Headers: any header containing "name" is the name, any containing "role" or
// "billet" is the role. A blank role, or "Role Unassigned", clears it.
// Only EMPTY roles are set unless --overwrite.
//
// The role lives in roster.extra (no migration), like plt/sect. Names are not
// encrypted, so COUGAR_ENC_KEY is not needed.
// ============================================================================

// `postgres` is imported lazily inside main(); see the note in reseat.mjs.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { nameKey, nameSimilarity, padD4, parseCsv } from "./intake-plan.mjs";

export function parseArgs(argv) {
  const out = { apply: false, overwrite: false, file: "" };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a === "--overwrite") out.overwrite = true;
    else if (!a.startsWith("--") && !out.file) out.file = a;
  }
  return out;
}

export function billetValue(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return /^(role )?unassigned$/i.test(s) ? "" : s;
}

/**
 * Pair each listed name with the one seat it names. Pure: no database.
 *
 * @param {string}   text    the CSV
 * @param {object[]} roster  current-intake recruit rows { id, name }
 * @returns {{ rows: {id, line, billet}[], issues: string[] }}
 */
export function planBillets(text, roster) {
  const issues = [];
  const byKey = new Map();
  for (const r of roster) {
    const k = nameKey(r.name);
    byKey.set(k, [...(byKey.get(k) || []), r]);
  }
  const closest = (name) => roster
    .map((r) => ({ r, s: nameSimilarity(name, r.name) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => `${padD4(x.r.id)} ${x.r.name}`);

  const parsed = parseCsv(text);
  const headers = Object.keys(parsed[0] || {});
  const nameH = headers.find((h) => /name/i.test(h));
  const roleH = headers.find((h) => /role|billet/i.test(h));
  if (!nameH || !roleH) return { rows: [], issues: ["the list needs a name column and a role column"] };

  const seen = new Map();
  const rows = [];
  for (const [n, raw] of parsed.entries()) {
    const line = n + 2;
    const name = String(raw[nameH] ?? "").trim();
    if (!name) { issues.push(`line ${line}: no name`); continue; }
    const seats = byKey.get(nameKey(name)) || [];
    if (seats.length > 1) {
      issues.push(`line ${line}: "${name}" matches ${seats.length} men (${seats.map((s) => padD4(s.id)).join(", ")}). Set these in the app.`);
      continue;
    }
    if (!seats.length) {
      const near = closest(name);
      issues.push(`line ${line}: "${name}" is not on the current roster${near.length ? `. Closest: ${near.join("; ")}` : ""}`);
      continue;
    }
    const id = padD4(seats[0].id);
    if (seen.has(id)) { issues.push(`line ${line}: ${id} is already listed on line ${seen.get(id)}`); continue; }
    seen.set(id, line);
    rows.push({ id, line, billet: billetValue(raw[roleH]) });
  }
  return { rows, issues };
}

class Rollback extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL } = process.env;
  if (!args.file) {
    console.error("usage: DATABASE_URL=... node scripts/billet-fill.mjs <roles.csv> [--apply] [--overwrite]");
    process.exitCode = 2;
    return;
  }
  if (!DATABASE_URL) {
    console.error("DATABASE_URL must be set.");
    process.exitCode = 2;
    return;
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake }] = await sql`select label from intakes where is_current limit 1`;
    const roster = await sql`
      select "id", "name" from roster
       where deleted_at is null and intake = ${intake} and coalesce("role", '') <> 'Commander'`;

    const plan = planBillets(fs.readFileSync(args.file, "utf8"), roster);
    if (plan.issues.length) {
      for (const i of plan.issues) console.error(`✗ ${i}`);
      console.error("\nBLOCKED. Nothing was written. Fix the names in the list and run again.");
      process.exitCode = 1;
      return;
    }

    const report = [];
    try {
      await sql.begin(async (tx) => {
        for (const r of plan.rows) {
          const res = await tx`
            update roster set extra = jsonb_set(extra, '{billet}', to_jsonb(${r.billet}::text))
             where "id" = ${r.id} and intake = ${intake} and deleted_at is null
               and (${args.overwrite} or coalesce(extra->>'billet', '') = '')
               and coalesce(extra->>'billet', '') <> ${r.billet}`;
          report.push({ ...r, set: res.count > 0 });
        }
        await tx`select bump_rev('Roster')`;
        if (!args.apply) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    for (const r of report) console.log(`${r.id}  ${r.set ? "set " : "kept"}  ${r.billet || "(none)"}`);
    const set = report.filter((r) => r.set).length;
    console.log(`\n${set} set, ${report.length - set} kept (already set${args.overwrite ? "" : "; --overwrite replaces"}).`);
    console.log(args.apply
      ? "APPLIED. Phones pick it up on their next sync."
      : "Preview only: every write above ran and was rolled back. Add --apply to keep it.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
}
