#!/usr/bin/env node
// ============================================================================
// promote.mjs - set roster.rank on every enlistee in the current intake.
//
//   Preview (reads only, writes nothing):
//     DATABASE_URL=... node scripts/promote.mjs
//
//   Apply (one transaction; all of it or none of it):
//     DATABASE_URL=... node scripts/promote.mjs --apply
//
// WHAT THIS IS FOR
// ----------------
// The whole company is posted into unit training and enlists no longer: every
// man is a PTE. `rosterRank()` in js/forms.js reads roster.rank and falls back
// to REC for a blank, so until the column is written the parade state, the
// conduct chat message, the medical status list and the fitness reports all
// still file the company as recruits - against a battalion nominal roll that
// says otherwise.
//
// WHAT IT WILL NOT DO
// -------------------
// Touch a commander. Ever. The filter is on `role`, the two-valued Commander /
// Recruit switch, never on the rank column - deciding role from rank is the
// confusion that would rewrite a 3SG to PTE. The WHERE clause repeats the
// filter server-side so a bug in the plan cannot reach a commander's row.
//
// It is idempotent: a row already at the target rank is not a write, so a
// second run reports "nothing to do" and commits nothing.
//
// PRIVACY: names are NOT printed unless --names is passed. The report is the
// thing that gets pasted into a chat or a PR, and 4Ds alone are enough to
// check it.
// ============================================================================

// `postgres` is imported lazily inside main(), NOT at the top level.
// `.github/workflows/test.yml` runs `node test/run.js` with no `npm install`,
// so anything a unit test can reach must not pull in an npm package on load -
// it passes locally, where node_modules exists, and fails only in CI with
// ERR_MODULE_NOT_FOUND. A static guard in test/static.test.js enforces it.
import { pathToFileURL } from "node:url";

import { DEFAULT_RANK, formatPromotionReport, planPromotion } from "./promote-plan.mjs";

export function parseArgs(argv) {
  const out = { apply: false, names: false, force: false, rank: DEFAULT_RANK };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--names") out.names = true;
    else if (a === "--force") out.force = true;
    else if (a === "--rank") out.rank = String(argv[++i] ?? "").trim();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DATABASE_URL } = process.env;

  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    console.error("usage: DATABASE_URL=... node scripts/promote.mjs [--rank PTE] [--apply] [--names] [--force]");
    process.exitCode = 2;
    return;
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(DATABASE_URL, { prepare: false });
  try {
    const [{ label: intake }] = await sql`select label from intakes where is_current limit 1`;
    const roster = await sql`
      select "id", "name", "role", "rank", "pid" from roster
       where deleted_at is null and intake = ${intake}`;

    const plan = planPromotion({ roster, rank: args.rank, force: args.force });
    console.log(`Intake: ${intake}`);
    console.log(formatPromotionReport(plan, { names: args.names }));

    if (!plan.ok) { process.exitCode = 1; return; }
    if (!plan.promote.length) return;
    if (!args.apply) {
      console.log("\nPreview only. Nothing was written. Add --apply to promote.");
      return;
    }

    const ids = plan.promote.map((m) => m.id);
    const written = await sql.begin(async (tx) => {
      // role <> 'Commander' is repeated here on purpose. The plan already
      // excludes them; this is the copy that a bug in the plan cannot get past.
      const res = await tx`
        update roster
           set "rank" = ${plan.rank}
         where "id" = any(${ids})
           and intake = ${intake}
           and deleted_at is null
           and coalesce(lower(btrim("role")), '') <> 'commander'`;
      // Without the bump no phone in the field ever learns the column moved,
      // and every one of them keeps filing the company as recruits.
      await tx`select bump_rev('Roster')`;
      return res.count;
    });

    console.log("\n" + "-".repeat(72));
    console.log(`APPLIED. ${written} roster row(s) now hold rank ${plan.rank}.`);
    if (written !== ids.length) {
      console.log(`NOTE: the plan expected ${ids.length}. A row changed under the run, or a`);
      console.log("      commander was filtered out server-side. Re-run the preview.");
    }
    console.log("");
    console.log("Still to do by hand:");
    console.log("  1. Bump the ?v= in index.html and deploy, so phones pick up any");
    console.log("     frontend change shipped alongside this.");
    console.log("  2. Nothing else. The 4D did not move, so invites and caches stand.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
