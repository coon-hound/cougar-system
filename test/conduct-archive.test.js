// Tests for 0010_conduct_archive.sql - folding the conduct registry into the
// intake archive.
//
// This migration is one UPDATE over 107 named rows, and both ways of getting it
// wrong are silent:
//
//   * archive one row too many and a live conduct disappears from every picker,
//     turning its attendance and detail records into `[c016?]` placeholders
//     that no test and no constraint will ever flag (conductId is a soft
//     reference - there is no foreign key from attendance, conductdetail or
//     polarflow into conducts);
//   * archive one row too few and the clutter this exists to remove stays, or
//     worse, a keeper is left stamped with the dead cohort and is then
//     un-revivable from the app, because `keep_archived_archived` declines the
//     revival silently.
//
// The database cannot be reached from `node test/run.js` (it is deliberately
// zero-install), so these are assertions about the migration TEXT. They pin the
// decisions that a later edit could plausibly undo. The behavioural proof - that
// the picker really drops to five entries and that a stale phone's rename really
// fails to revive - is done against the local Postgres in DEV-ENV.md.
const fs = require("fs");
const path = require("path");
const { suite, test, ok, eq } = require("./_tap");

const ROOT = path.resolve(__dirname, "..");
const MIGDIR = path.join(ROOT, "supabase/migrations");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SQL = read("supabase/migrations/0010_conduct_archive.sql");

// The five conducts that belong to intake 16 and must survive: the four it has
// logged against since the 14 Sep cutoff, and "12km RM", created 15 Sep and not
// yet logged.
const KEEPERS = ["cmu3bdoe7-re7lub-1", "cmuaff9rl-0dowj3-1", "c6117", "c016", "c9020"];

/** Pull a `name text[] := array[ ... ]` literal out of the migration. */
function arrayLiteral(name) {
  const m = SQL.match(new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*array\\[([\\s\\S]*?)\\]`));
  ok(m, `${name} is declared as a text[] array literal`);
  return (m[1].match(/'[^']*'/g) || []).map((s) => s.slice(1, -1));
}

module.exports = async function () {
  // ── Numbering ───────────────────────────────────────────────────────────
  suite("conduct archive - the migration slots in cleanly");

  await test("no migration number is claimed twice", () => {
    // A past incident shipped two migrations both calling themselves 0005. The
    // files apply in lexical order, so a collision means one of them is skipped
    // or applied in an order nobody chose. THAT is the durable invariant and it
    // is what this asserts.
    //
    // It used to also assert that 0010 was the highest number, with 0008 left
    // free for an unmerged branch. Both halves of that were wrong: an upper
    // bound fails on the next migration anybody writes, so it is a tripwire
    // against ordinary work rather than against the defect it names - it fired
    // the moment token_activity landed. And reserving a LOWER number for a
    // branch that has not shipped inverts the ordering, because whichever
    // migration reaches production first is applied first: 0009 and 0010 merged
    // while 0008 was still unmerged, so an 0008 applied afterwards would be an
    // out-of-order migration the CLI refuses by default. A later branch takes
    // the next FREE number at merge time, never a reserved earlier one.
    //
    // Not gapless, and that is fine: 0008 is a permanent gap.
    const files = fs.readdirSync(MIGDIR).filter((f) => f.endsWith(".sql")).sort();
    const nums = files.map((f) => f.slice(0, 4));
    eq(nums.length, new Set(nums).size, `one migration per number: ${files.join(", ")}`);
    ok(nums.includes("0010"), "0010_conduct_archive.sql is present");
    ok(nums.every((n) => /^\d{4}$/.test(n)), "every migration is numbered NNNN");
  });

  // ── The keeper list ─────────────────────────────────────────────────────
  suite("conduct archive - the list is explicit, and the keepers are out of it");

  await test("exactly 107 conducts are named for archiving, with no duplicates", () => {
    const ids = arrayLiteral("archive_ids");
    eq(ids.length, 107, "107 old conducts, as counted on production 23 Sep 2026");
    eq(ids.length, new Set(ids).size, "no id listed twice");
    ok(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id)), "every id is a bare token");
  });

  await test("the five keepers are named, and are not on the archive list", () => {
    const keepers = arrayLiteral("keeper_ids");
    eq(keepers.slice().sort(), KEEPERS.slice().sort());
    const archive = new Set(arrayLiteral("archive_ids"));
    for (const k of KEEPERS) ok(!archive.has(k), `${k} is not archived`);
  });

  await test("the migration refuses to run if a keeper ever lands on both lists", () => {
    // Belt and braces for the assertion above: the check is in the SQL too, so
    // it holds against the database and not only against this test file.
    ok(/unnest\(keeper_ids\)[\s\S]{0,120}any\s*\(archive_ids\)/.test(SQL),
      "the overlap is computed");
    ok(/raise exception '0010: keeper\(s\)/.test(SQL), "and it aborts");
  });

  await test("nothing is selected by date - only by id", () => {
    // updated_at is NOT creation time (conducts_touch rewrites it on every
    // UPDATE), and the Sheets import stamped all 109 imported rows with a single
    // updated_at of 2026-09-14 00:35:44+00 - AFTER the intake 16 cutoff of
    // 2026-09-14. So any "keep what looks recent" predicate keeps all of them
    // or none. The ONLY thing that may select rows to archive is the id list.
    const block = SQL.slice(SQL.indexOf("do $$"));
    ok(!/updated_at/.test(block), "no updated_at predicate in the backfill");
    const updates = block.match(/update conducts[\s\S]*?;/g) || [];
    ok(updates.length >= 2, "the keeper restamp and the archive are both present");
    for (const u of updates) {
      ok(/any \((?:archive_ids|keeper_ids)\)/.test(u),
        `every UPDATE on conducts is scoped to a named id list:\n${u}`);
    }
  });

  await test("the archive cannot orphan a live record - checked at apply time", () => {
    // conductId has no foreign key, so the database will not catch this. The
    // migration counts live referrers itself and aborts rather than leaving
    // records pointing at a conduct no picker can show.
    for (const t of ["attendance", "conductdetail", "polarflow"]) {
      ok(new RegExp(`from ${t}[\\s\\S]{0,160}"conductId" = any \\(archive_ids\\)`).test(SQL),
        `${t} referrers are counted`);
    }
    ok(/if still_used > 0 then[\s\S]{0,400}raise exception/.test(SQL),
      "a non-zero count aborts the migration");
  });

  await test("the keepers are restamped to the CURRENT intake, not left behind", () => {
    // Archiving is sticky: once a row is soft-deleted AND stamped with a
    // non-current intake, keep_archived_archived silently declines every
    // revival the app can send. A keeper left on the old stamp is a conduct
    // that can never be deleted-and-re-added from a phone.
    ok(/update conducts set intake = current_intake\(\)\s*\n\s*where "id" = any \(keeper_ids\)/.test(SQL),
      "keepers take current_intake()");
  });

  // ── Reuse, not reinvention ──────────────────────────────────────────────
  suite("conduct archive - it reuses 0004's machinery verbatim");

  await test("no new trigger logic is invented", () => {
    ok(!/create (or replace )?function/i.test(SQL),
      "0010 defines no functions of its own");
    const guards = read("supabase/migrations/0004_intake.sql");
    for (const fn of ["keep_archived_archived", "block_archived_delete"]) {
      ok(new RegExp(`create or replace function ${fn}`).test(guards),
        `${fn} is still defined in 0004`);
      ok(new RegExp(`execute function ${fn}\\(\\)`).test(SQL),
        `0010 installs the existing ${fn}`);
    }
  });

  await test("both guards are installed on conducts", () => {
    ok(/create trigger conducts_keep_archived before update on conducts/.test(SQL),
      "the revive guard - upsertOne ends every write deleted_at = null");
    ok(/create trigger conducts_block_arch_del before delete on conducts/.test(SQL),
      "the delete guard - purge_retention hard-deletes soft-deleted conducts");
    // Naming matters: the trigger names match 0004's `<table>_keep_archived` /
    // `<table>_block_arch_del` convention, so a future loop over both lists
    // re-creates rather than duplicates them.
    const loop = read("supabase/migrations/0004_intake.sql");
    ok(/_keep_archived/.test(loop) && /_block_arch_del/.test(loop),
      "the convention is 0004's");
  });

  await test("the stamp and its partial index match the other eleven tables", () => {
    ok(/alter table conducts add column if not exists intake text default current_intake\(\)/.test(SQL),
      "same column, same default");
    ok(/create index if not exists conducts_intake_idx\s+on conducts \(intake\) where deleted_at is null/.test(SQL),
      "same partial index, same name shape");
  });

  await test("intake is server-owned on Conducts, as it is on Roster", () => {
    // api_row returns every real column, so `intake` now rides back out to the
    // client in every readAll, and js/forms.js renameConduct upserts the whole
    // row back. Without this, a phone writes its own cohort stamp.
    ok(/insert into dropped_fields[\s\S]{0,200}\('Conducts', 'intake'/.test(SQL),
      "('Conducts','intake') is deny-listed");
    ok(/on conflict \(tab, field\) do nothing/.test(SQL), "and the insert is rerunnable");
    // The Edge Function caches this list for the life of a warm instance, so
    // the migration alone is not enough. Say so where an operator will see it.
    ok(/REDEPLOY/i.test(SQL), "the redeploy requirement is called out in the file");
  });

  await test("the Conducts revision is bumped so devices actually pull", () => {
    ok(/select bump_rev\('Conducts'\)/.test(SQL),
      "without this no phone learns the tab changed");
  });

  // ── The next changeover does it automatically ───────────────────────────
  suite("conduct archive - the next changeover no longer needs a human");

  await test("conducts is archived wholesale by the planner", async () => {
    const { pathToFileURL } = require("url");
    const P = await import(pathToFileURL(path.join(ROOT, "scripts/intake-plan.mjs")).href);
    eq(P.CARRY_RULES.conducts.carry, "none",
      "'keep' was 0004's premise that conduct names recur; they do not");
    eq(P.CARRY_RULES.conducts.tab, "Conducts");
    eq(P.CARRY_RULES.conducts.table, "conducts");
  });

  await test("intake-migrate archives conducts, and not through a d4 it lacks", () => {
    const mig = read("scripts/intake-migrate.mjs");
    const cohort = mig.match(/const COHORT_TABLES = \[([\s\S]*?)\];/)[1];
    ok(/"conducts"/.test(cohort), "conducts is a cohort table");
    // conducts has no "d4" column at all, so the generic per-person archive
    // query does not merely match nothing there - it fails to parse.
    const noD4 = mig.match(/const NO_D4_TABLES = new Set\(\[([\s\S]*?)\]\)/)[1];
    ok(/"conducts"/.test(noD4) && /"attendance"/.test(noD4),
      "conducts joins attendance as a table with no d4 to re-key");
    ok(/if \(table === "roster" \|\| NO_D4_TABLES\.has\(table\)\) continue;/.test(mig),
      "the commander roll-forward skips them too");
    ok(/"Conducts"/.test(mig.match(/const REV_TABS = \[([\s\S]*?)\];/)[1]),
      "Conducts is still bumped at a changeover");
  });
};
