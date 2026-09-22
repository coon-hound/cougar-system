// Static guards over 0008_token_activity.sql — the migration that measures how
// device tokens die.
//
// It is one table and one rewritten function, so there is little behaviour to
// unit-test in Node; the SQL was rehearsed against a real local Postgres and
// then driven through the real Edge Function over HTTP. What these guards hold
// are the four invariants a later edit could break SILENTLY, where "silently"
// means the table keeps filling up and the answer it gives is wrong:
//
//  (a) REFUSALS RECORD NOTHING. The table answers "which days was this token
//      alive", so a revoked or expired token must not appear. Refused attempts
//      are the audit log's job (0002). If the insert ever drifts above a
//      refusal return, that question stops being answerable and nothing fails.
//  (b) ONE WRITE PER TOKEN PER DAY. check_auth runs on EVERY request including
//      the 20-second revCheck poll. Ungated, this is a row update per device
//      per 20 seconds, which is the cost mistake 0005 was careful to avoid.
//  (c) NO CREDENTIAL IN THE READ-OUT. 0006 established that a list of access
//      must carry no token, because one screenshot would otherwise be a breach.
//      A view over auth_tokens is exactly where that gets re-broken.
//  (d) IT STAYS OUT OF THE SYNC CYCLE. An append-only table inside REV_TABS
//      would make one recorded request wake every other phone in the company
//      for a pull. This is the trap TELEMETRY-DESIGN.md calls out for `usage`,
//      and token_activity has the same shape, so it needs the same guard.
const fs = require("fs");
const path = require("path");
const { suite, test, ok } = require("./_tap");

const ROOT = path.join(__dirname, "..");
const MIG = path.join(ROOT, "supabase/migrations/0008_token_activity.sql");

module.exports = async function run() {
  suite("token_activity: measuring how device tokens die");

  const mig = fs.readFileSync(MIG, "utf8");
  // The body of check_auth as this migration leaves it.
  const fn = mig.slice(mig.indexOf("create or replace function check_auth"),
                       mig.indexOf("-- ── Retention"));
  ok(fn.length > 200, "found the check_auth body in 0008");

  await test("the activity row is written only AFTER every refusal path", () => {
    const insertAt = fn.indexOf("insert into token_activity");
    ok(insertAt > 0, "check_auth writes an activity row");
    // Each refusal returns before doing any work. All four must precede it.
    for (const reason of ["'missing'", "'unknown'", "'revoked'", "'expired'"]) {
      const at = fn.indexOf(reason);
      ok(at > 0, "check_auth still distinguishes " + reason);
      ok(at < insertAt, reason + " is refused before anything is recorded");
    }
  });

  await test("check_auth keeps its contract: same four reasons, in order", () => {
    const order = ["'missing'", "'unknown'", "'revoked'", "'expired'", "'ok'"]
      .map(r => fn.indexOf(r));
    for (let i = 1; i < order.length; i++) {
      ok(order[i] > order[i - 1], "reason " + i + " still follows the previous one");
    }
    ok(/returns table \(ok boolean, person text, reason text\)/.test(fn),
       "the signature is unchanged, so the Edge Function needs no edit");
    ok(/update auth_tokens set last_seen_at = now\(\)/.test(fn),
       "last_seen_at is still touched — the Access screen's stale signal depends on it");
  });

  await test("the write is gated to once per token per day, not once per request", () => {
    ok(/last_seen_at is null or r\.last_seen_at::date < current_date/.test(fn),
       "the day gate is on the row as it was read BEFORE this request");
    const insertAt = fn.indexOf("insert into token_activity");
    const gateAt = fn.indexOf("last_seen_at is null or");
    ok(gateAt > 0 && gateAt < insertAt, "the gate precedes the insert");
    ok(/on conflict \(token, day\) do update/.test(fn),
       "two callers racing past the gate on the same day cannot error");
  });

  await test("the first day is seeded, so it is not blind", () => {
    // Every live token has already been seen earlier on deploy day, so the gate
    // correctly declines for the rest of it. Without this seed the whole fleet
    // records nothing on the one day somebody will look.
    ok(/insert into token_activity[\s\S]{0,400}from auth_tokens[\s\S]{0,200}last_seen_at is not null/
       .test(mig), "0008 backfills one row per token from last_seen_at");
    ok(/on conflict \(token, day\) do nothing/.test(mig),
       "the backfill keeps the migration re-runnable");
  });

  await test("the read-out carries no credential", () => {
    const view = mig.slice(mig.indexOf("create or replace view token_lifecycle"));
    ok(view.length > 100, "found the view");
    // The select list must never expose the token itself. `t.token` in the join
    // and `a.token` in the GROUP BY are fine; a bare selected column is not.
    const selectList = view.slice(0, view.indexOf("from auth_tokens"));
    ok(!/\ba\.token\b/.test(selectList), "auth_tokens.token is not selected");
    ok(!/^\s*token\s*,/m.test(selectList), "no bare token column is selected");
  });

  await test("token_activity stays out of the sync cycle", () => {
    ok(!/insert into revs[\s\S]{0,200}token_activity/i.test(mig),
       "not seeded into revs, so no phone polls for it");
    const edge = fs.readFileSync(path.join(ROOT, "supabase/functions/api/index.ts"), "utf8");
    ok(!/STATE_KEY[\s\S]{0,800}token_activity/.test(edge),
       "not in STATE_KEY, so not in REV_TABS or readAll");
    ok(!/token_activity/.test(edge),
       "the Edge Function needs no change at all — check_auth already writes it");
  });

  await test("the table is bounded and locked down like every other", () => {
    ok(/alter table token_activity enable row level security/.test(mig),
       "RLS enabled, no policies — service role only, same as 0001-0007");
    ok(/create or replace function token_activity_prune/.test(mig), "retention exists");
    ok(/p_commit boolean default false/.test(mig),
       "prune is dry-run by default, like purge_retention and usage_prune");
    ok(/primary key \(token, day\)/.test(mig),
       "one row per token per day is enforced by the key, not by the caller");
  });
};
