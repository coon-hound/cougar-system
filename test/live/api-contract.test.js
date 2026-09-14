// ============================================================================
// The backend contract, asserted against the REAL Edge Function over HTTP.
//
// test/e2e/backend-contract.spec.js pins the same contract from the other side
// — what the client puts on the wire, checked against an in-memory fake. This
// file is the half that fake cannot prove: that supabase/functions/api and the
// migrations actually answer the way the fake pretends to. Together they are
// the cutover gate. Neither alone is.
//
// Every assertion is traceable to the Sheets backend it replaces, because
// "compatible" here means byte-compatible with a live client that ships
// separately from this backend and will not be redeployed in lockstep.
//
//   node test/live/api-contract.test.js
//   COUGAR_API=http://127.0.0.1:8000/ COUGAR_TOKEN=dev-token node test/live/...
//
// SKIPS (exit 0) when no backend is reachable, so it is safe to wire into
// verify.sh and CI, where there is no Postgres. Bring one up with:
//
//   ./scripts/dev-env.sh up
//
// SAFETY: run this against a SCRATCH database only, and nothing else.
//
// Most of the file is harmless: rows are prefixed T_ / keyed 99xx and removed
// at the end. Two suites are not. The full-tab-replace tests REPLACE THE WHOLE
// OF SOC AND MSK, whatever is in them — that is the operation under test, so
// there is no version of it that leaves existing rows alone. MSK has no `id`
// and therefore no tombstone, so on that tab the loss is permanent.
//
// The tabs are snapshotted and written back at the end, which covers a
// populated dev database. It does not cover a crash midway, and it cannot
// restore a tab that started empty. Hence the guard below: any target that is
// not localhost has to be named as scratch out loud.
// ============================================================================

const { suite, test, ok, eq, summary } = require("../_tap");

const API = process.env.COUGAR_API || "http://127.0.0.1:8000/";
const TOKEN = process.env.COUGAR_TOKEN || "dev-token";

// A local URL is self-evidently a dev box. Anything else — a Supabase project,
// a staging host — has to say so, because this file destroys SOC and MSK and
// the person pointing it at a URL is usually mid-cutover and in a hurry.
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(API);
if (!IS_LOCAL && process.env.COUGAR_LIVE_TEST_SCRATCH !== "1") {
  console.error(
    `\nREFUSING to run against ${API}\n\n` +
    "This test replaces the entire contents of the SOC and MSK tabs. MSK has no\n" +
    "`id` column, so its rows are hard-deleted with nothing to restore from.\n\n" +
    "If that really is a scratch database, say so:\n" +
    "  COUGAR_LIVE_TEST_SCRATCH=1 COUGAR_API=… COUGAR_TOKEN=… node test/live/api-contract.test.js\n\n" +
    "To check a PRODUCTION backend instead, use the read-only comparison:\n" +
    "  node scripts/verify-migration.mjs <backup-dir>\n"
  );
  process.exit(1);
}

// ── Wire helpers ────────────────────────────────────────────────────────────
//
// Deliberately raw: no client library, because the thing under test IS the
// wire format. Each returns {status, body} so the always-200 invariant is
// checkable rather than assumed.
async function POST(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ auth: TOKEN, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

async function GET(params) {
  const qs = new URLSearchParams({ auth: TOKEN, ...params });
  const res = await fetch(`${API}?${qs}`);
  return { status: res.status, body: await res.json() };
}

const post = async (b) => (await POST(b)).body;
const get = async (p) => (await GET(p)).body;
const revOf = async (tab) => (await get({ action: "revCheck" })).revs[tab];
const rowsOf = async (tab) => (await get({ action: "read", tab })).rows;
const rowById = async (tab, id) => (await rowsOf(tab)).find((r) => r.id === id);

// Test fixtures live in their own id space so a run can never touch real data.
const T = (n) => `T_${n}`;
const TEST_4D = "9901";

module.exports = async function run() {
  // Whatever these two tabs hold before the full-tab-replace suites run. They
  // are put back in cleanup, so a run against a populated dev database (the
  // demo, say) is not a data-loss event.
  const SNAPSHOT = { SOC: await rowsOf("SOC"), MSK: await rowsOf("MSK") };

  // ── Reads ─────────────────────────────────────────────────────────────────
  suite("live API: reads");

  await test("ping is the only public action; everything else 401s", async () => {
    const ping = await (await fetch(`${API}?action=ping`)).json();
    ok(ping.ok, "ping answers unauthenticated");
    ok(ping.build, "ping carries build");

    // The 401 is a BODY field on an HTTP 200. _fetchJson (js/api.js:32-46)
    // never inspects res.ok, so a real 401 status would be read as success
    // with an empty body — the client would silently believe it had no data.
    const denied = await (await fetch(`${API}?action=readAll&auth=not-a-token`));
    const body = await denied.json();
    eq(denied.status, 200, "auth failure is HTTP 200");
    eq(body.code, 401, "401 is carried in the body");
    ok(/Unauthorized/.test(body.error), "error text names the cause");
  });

  await test("readAll returns every tracked tab, keyed as the client expects", async () => {
    const all = await get({ action: "readAll" });
    // Exactly TAB_TO_STATE (js/state.js:32-45). rm / polar / conductDetail
    // deliberately differ from their tab names; a rename here would leave the
    // matching STATE array permanently empty.
    for (const k of ["roster", "medical", "attendance", "ippt", "rm", "soc", "polar",
      "conductDetail", "appointments", "leave", "msk", "conducts"]) {
      ok(Array.isArray(all[k]), `readAll.${k} is an array`);
    }
    ok(all.revs && typeof all.revs === "object", "readAll carries revs");
    ok(all.build, "readAll carries build");
    ok(all.timestamp, "readAll carries timestamp");
  });

  await test("read&tab returns {rows, rev}", async () => {
    const res = await get({ action: "read", tab: "Leave" });
    ok(Array.isArray(res.rows), "rows is an array");
    ok(Number.isFinite(Number(res.rev)), "rev is a number");
  });

  await test("revCheck agrees with readAll", async () => {
    const all = await get({ action: "readAll" });
    const chk = await get({ action: "revCheck" });
    eq(chk.revs, all.revs, "revCheck and readAll report the same revisions");
  });

  await test("empty cells come back as \"\", never null", async () => {
    // getValues() (apps-script-Code.gs:747) returns "" for a blank cell and
    // never null, and js/* was written against that. The difference bites at
    // js/state.js:313, where leaveQuota is guarded with `!== ""` — a null slips
    // past the guard and +null makes an empty quota read as a quota of zero.
    await post({ action: "upsertRow", tab: "Roster", row: { id: TEST_4D, name: "PARITY TEST" } });
    const row = await rowById("Roster", TEST_4D);
    const nulls = Object.entries(row).filter(([, v]) => v === null).map(([k]) => k);
    eq(nulls, [], "no null values anywhere in the row");
    eq(row.leaveQuota, "", "an unset leaveQuota is the empty string");
    ok("dob" in row && "nokPhone" in row, "encrypted columns are present too");
  });

  // ── Row-scoped writes ─────────────────────────────────────────────────────
  suite("live API: row-scoped writes");

  await test("a partial upsert does not blank the columns it omits", async () => {
    // THE flagship bug. upsertRow (apps-script-Code.gs:1105-1108) rebuilt the
    // row from every current header and wrote "" for anything the payload was
    // missing, so a device with a stale model silently erased campIn / groups
    // / location / program while saving something else entirely.
    await post({
      action: "upsertRow", tab: "Roster",
      row: { id: TEST_4D, name: "PARITY TEST", location: "Tekong", groups: "Guard", program: "PTP" },
    });
    await post({ action: "upsertRow", tab: "Roster", row: { id: TEST_4D, outOfCamp: "TRUE" } });

    const row = await rowById("Roster", TEST_4D);
    eq(row.location, "Tekong", "location survived");
    eq(row.groups, "Guard", "groups survived");
    eq(row.program, "PTP", "program survived");
    eq(row.outOfCamp, "TRUE", "and the edit itself landed");
  });

  await test("encrypted columns round-trip as plaintext", async () => {
    // 0002 converts these eight to bytea. The key lives in the function
    // environment, so a wrong key must fail loudly rather than hand back
    // blanks that the next full-tab write would persist over the real values.
    await post({
      action: "upsertRow", tab: "Roster",
      row: { id: TEST_4D, dob: "01 Jan 2005", bloodType: "O+", nokPhone: "91234567" },
    });
    const row = await rowById("Roster", TEST_4D);
    eq(row.dob, "01 Jan 2005", "dob decrypts");
    eq(row.bloodType, "O+", "bloodType decrypts");
    eq(row.nokPhone, "91234567", "nokPhone decrypts");
  });

  await test("deny-listed fields are dropped, not parked in `extra`", async () => {
    // Without the deny-list (0002) the minimised fields would reaccumulate
    // inside `extra` on the next write, defeating the minimisation itself.
    await post({
      action: "upsertRow", tab: "Roster",
      row: { id: TEST_4D, gpa: "4.0", fieldOfStudy: "EEE", smoker: "N", nokOccupation: "Teacher", notes: "kept" },
    });
    const row = await rowById("Roster", TEST_4D);
    eq(row.notes, "kept", "an ordinary field is still stored");
    for (const f of ["gpa", "fieldOfStudy", "smoker", "nokOccupation"]) {
      ok(!(f in row), `${f} is absent from the response`);
    }
  });

  await test("a roster row carrying only \"4d\" gets the canonical id derived", async () => {
    // 26 of 282 live rows (all Commanders) have an empty `id` and are keyed off
    // `4d` alone. padD4 (js/state.js:284) strips the "C" and pads to 4, so
    // commander "7" must land as "0007" or every child record misses the join.
    await post({ action: "upsertRow", tab: "Roster", row: { "4d": "C0007", name: "T_CMDR" } });
    const row = await rowById("Roster", "0007");
    ok(row, "row is keyed by the canonical 4D");
    eq(row["4d"], "C0007", "the display form is preserved verbatim");
    await post({ action: "deleteRowById", tab: "Roster", id: "0007" });
  });

  await test("row-scoped writes ignore a stale baseRev", async () => {
    // Deliberate: enforcing OCC on row-scoped ops produced false conflicts and
    // a retry storm (apps-script-Code.gs:212-216), and js/sync.js is built
    // around last-write-wins for same-row edits.
    const res = await post({
      action: "upsertRow", tab: "Roster",
      row: { id: TEST_4D, notes: "written against a stale rev" }, baseRev: 1,
    });
    ok(res.ok && !res.conflict, "applied despite a stale baseRev");
    eq((await rowById("Roster", TEST_4D)).notes, "written against a stale rev");
  });

  // ── Append semantics ──────────────────────────────────────────────────────
  suite("live API: append idempotency");

  await test("a replayed append creates no duplicate and does not bump the rev", async () => {
    // The client retries on transport failure with no idempotency key of its
    // own (js/sync.js dispatchWithNetRetry), so dedup rests entirely on the
    // server matching row.id (apps-script-Code.gs:1005-1008). The rev must not
    // move either: a bump would wake every other device for a pull that finds
    // nothing changed.
    const row = { id: T("L1"), d4: TEST_4D, type: "Annual Leave" };
    const first = await post({ action: "append", tab: "Leave", row });
    const revAfterFirst = await revOf("Leave");
    const second = await post({ action: "append", tab: "Leave", row });

    eq(first.action, "appended", "first append lands");
    eq(second.action, "noop", "replay is a noop");
    eq(await revOf("Leave"), revAfterFirst, "replay does not bump the rev");
    eq((await rowsOf("Leave")).filter((r) => r.id === T("L1")).length, 1, "exactly one copy");
  });

  await test("appendMany counts appends, not rows accepted", async () => {
    const rows = [{ id: T("L2"), d4: TEST_4D }, { id: T("L3"), d4: TEST_4D }, { id: T("L2"), d4: TEST_4D }];
    const res = await post({ action: "appendMany", tab: "Leave", rows });
    eq(res.rowsAppended, 2, "the duplicate id is not counted");
    eq((await rowsOf("Leave")).filter((r) => r.id === T("L2")).length, 1, "and is not stored twice");
  });

  await test("an all-duplicate appendMany is a noop that does not bump the rev", async () => {
    // Matches apps-script-Code.gs:1057 exactly, marker and all — withRev reads
    // `action: "noop"` to decide whether the revision moves.
    const before = await revOf("Leave");
    const res = await post({
      action: "appendMany", tab: "Leave",
      rows: [{ id: T("L2"), d4: TEST_4D }, { id: T("L3"), d4: TEST_4D }],
    });
    eq(res.rowsAppended, 0, "nothing appended");
    eq(res.action, "noop", "reported as a noop");
    eq(await revOf("Leave"), before, "rev unchanged");
  });

  await test("appendMany rejects an empty batch the way the old backend did", async () => {
    const res = await post({ action: "appendMany", tab: "Leave", rows: [] });
    eq(res.error, "Rows must be a non-empty array");
  });

  // ── applyOps ──────────────────────────────────────────────────────────────
  suite("live API: applyOps batching");

  await test("applyOps applies in order, one rev bump for the whole batch", async () => {
    // The batching path (js/sync.js:463) packs up to 50 ops. One bump per
    // request is the point: a bulk book-out of a platoon must wake other
    // devices once, not fifty times.
    const before = await revOf("Leave");
    const res = await post({
      action: "applyOps", tab: "Leave",
      ops: [
        { op: "append", row: { id: T("L4"), d4: TEST_4D, type: "Off" } },
        { op: "upsert", row: { id: T("L4"), type: "Annual Leave" } },
        { op: "delete", id: T("L3") },
      ],
    });
    eq(res.applied, 3, "all three applied");
    eq(res.failed, 0, "none failed");
    eq(await revOf("Leave"), before + 1, "exactly one rev bump");

    const rows = await rowsOf("Leave");
    eq(rows.find((r) => r.id === T("L4")).type, "Annual Leave", "ops applied in order");
    ok(!rows.some((r) => r.id === T("L3")), "the delete took effect");
  });

  await test("one bad op fails alone; the rest of the batch still lands", async () => {
    // Partial success matters: a single malformed op must not cost the user
    // the other 49 edits in the batch.
    const res = await post({
      action: "applyOps", tab: "Leave",
      ops: [
        { op: "append", row: { id: T("L5"), d4: TEST_4D } },
        { op: "sabotage" },
        { op: "append", row: { id: T("L6"), d4: TEST_4D } },
      ],
    });
    eq(res.applied, 2, "the two good ops applied");
    eq(res.failed, 1, "the bad one failed alone");
    ok(res.results[1].error, "and reports its own error");
    const ids = (await rowsOf("Leave")).map((r) => r.id);
    ok(ids.includes(T("L5")) && ids.includes(T("L6")), "both good rows are stored");
  });

  await test("a delete is soft, and a replayed delete is a noop", async () => {
    const first = await post({ action: "deleteRowById", tab: "Leave", id: T("L5") });
    const revAfter = await revOf("Leave");
    const second = await post({ action: "deleteRowById", tab: "Leave", id: T("L5") });

    eq(first.action, "deleted", "first delete lands");
    eq(second.action, "noop", "replay is a noop");
    eq(await revOf("Leave"), revAfter, "replay does not bump the rev");
    ok(!(await rowsOf("Leave")).some((r) => r.id === T("L5")), "row is gone from reads");
  });

  await test("re-appending a deleted id revives it and reports an append", async () => {
    // Deletes here are soft, so the tombstone is still on disk and an upsert
    // underneath would call this an "update". The Sheets backend really removed
    // the row, so the same sequence appended. The row must come back with the
    // NEW values, not the tombstoned ones.
    await post({ action: "append", tab: "Leave", row: { id: T("L7"), d4: TEST_4D, type: "Off" } });
    await post({ action: "deleteRowById", tab: "Leave", id: T("L7") });
    ok(!(await rowsOf("Leave")).some((r) => r.id === T("L7")), "gone after the delete");

    const res = await post({ action: "append", tab: "Leave", row: { id: T("L7"), d4: TEST_4D, type: "Annual Leave" } });
    eq(res.action, "appended", "reported as an append, not an update");
    eq((await rowById("Leave", T("L7"))).type, "Annual Leave", "and carries the new values");
    await post({ action: "deleteRowById", tab: "Leave", id: T("L7") });
  });

  // ── Full-tab replace + optimistic concurrency ─────────────────────────────
  suite("live API: full-tab write + OCC");

  await test("a stale full-tab write is rejected without mutating anything", async () => {
    // `write` is the ONLY OCC-enforced action, because it is the only one that
    // can erase a tab: an empty `data` soft-deletes everything, matching the
    // old writeTab, which cleared the sheet before rebuilding it.
    await post({ action: "write", tab: "SOC", baseRev: await revOf("SOC"),
      data: [{ id: T("S1"), d4: TEST_4D, socNum: "1" }] });

    const serverRev = await revOf("SOC");
    const res = await post({ action: "write", tab: "SOC", baseRev: serverRev - 1, data: [] });

    eq(res.conflict, true, "rejected as a conflict");
    eq(res.serverRev, serverRev, "and reports the server's revision");
    eq(res.tab, "SOC", "naming the tab, so the banner can name it too");
    eq(await revOf("SOC"), serverRev, "rev did not move");
    eq((await rowsOf("SOC")).length, 1, "and the tab was not wiped");
  });

  await test("the same write against a fresh baseRev is applied", async () => {
    // This is 'Push mine anyway': the client re-reads the rev and re-pushes.
    const res = await post({
      action: "write", tab: "SOC", baseRev: await revOf("SOC"),
      data: [{ id: T("S1"), d4: TEST_4D, socNum: "2" }, { id: T("S2"), d4: TEST_4D, socNum: "3" }],
    });
    ok(res.ok && !res.conflict, "accepted");
    eq(res.rowsWritten, 2, "both rows written");
    eq((await rowsOf("SOC")).length, 2, "and both are readable");
  });

  await test("a full-tab write soft-deletes the rows it omits", async () => {
    await post({
      action: "write", tab: "SOC", baseRev: await revOf("SOC"),
      data: [{ id: T("S1"), d4: TEST_4D, socNum: "9" }],
    });
    const rows = await rowsOf("SOC");
    eq(rows.length, 1, "the omitted row is gone");
    eq(rows[0].socNum, "9", "the surviving row took the new value");
  });

  await test("an empty full-tab write is refused, not obeyed", async () => {
    // writeTab bailed on an empty array (apps-script-Code.gs:832) and so must
    // this. It is the difference between a no-op and erasing a tab company-wide:
    // the per-tab "↻ Re-push all" button (js/render.js:1851) pushes whatever
    // STATE holds, and STATE holds [] on a device whose pull never landed.
    const before = await rowsOf("SOC");
    const res = await post({ action: "write", tab: "SOC", baseRev: await revOf("SOC"), data: [] });
    eq(res.error, "Data must be a non-empty array of objects", "the old backend's wording");
    eq((await rowsOf("SOC")).length, before.length, "and nothing was erased");
  });

  await test("a full-tab write never destroys a column the payload omits", async () => {
    // writeTab (apps-script-Code.gs:842-844) rebuilt the sheet's headers from
    // data[0] ALONE, so a key missing from the first row was dropped for the
    // WHOLE tab — which is why js/state.js carries defaulting normalizers whose
    // comments all say "writeTab derives headers from the first row's keys".
    await post({
      action: "write", tab: "SOC", baseRev: await revOf("SOC"),
      data: [
        { id: T("S1"), d4: TEST_4D },                       // no `pass` key
        { id: T("S2"), d4: TEST_4D, pass: "YES" },          // has one
      ],
    });
    const rows = await rowsOf("SOC");
    eq(rows.find((r) => r.id === T("S2")).pass, "YES", "the later row's column survived row 0 lacking it");
  });

  // ── Tabs with no row identity ─────────────────────────────────────────────
  suite("live API: tabs with no `id` column");

  await test("MSK takes a full-tab replace", async () => {
    // MSK rows only ever arrive by full-tab replace or Google Form — its live
    // headers carry no `id`, and normalizeMSK (js/state.js:397) emits none.
    const res = await post({
      action: "write", tab: "MSK", baseRev: await revOf("MSK"),
      data: [{ timestamp: "2026-08-30", d4: TEST_4D, type: "Knee", description: "T_msk" }],
    });
    ok(res.ok, "write accepted");
    const rows = await rowsOf("MSK");
    eq(rows.length, 1, "one row stored");
    eq(rows[0].d4, TEST_4D, "keyed content is intact");
    ok(!("_pk" in rows[0]), "the surrogate key never reaches the client");
  });

  await test("id-based ops on MSK give the old backend's error, not raw SQL", async () => {
    // deleteEntry("msk", …) (js/helpers.js:407) is a live UI path and the old
    // backend refused it (deleteRowById bails once indexOf("id") is -1). The
    // wording is kept so the sync banner reads the same as it always did —
    // and so a Postgres 'column "id" does not exist' never reaches a user.
    const del = await post({ action: "deleteRowById", tab: "MSK", id: "anything" });
    eq(del.error, "No 'id' column in tab MSK");
    const ups = await post({ action: "upsertRow", tab: "MSK", row: { d4: TEST_4D } });
    eq(ups.error, "No 'id' column in tab MSK");
  });

  await test("Config stays a single row however it is written", async () => {
    // The Sheets version appended a second Config row, which getConfig
    // (apps-script-Code.gs:1589) then ignored because it reads rows[0] — the
    // settings write was silently lost.
    await post({ action: "write", tab: "Config", data: [{ botGroupChatId: "-100", cutoffHours: "4" }] });
    await post({ action: "append", tab: "Config", row: { cutoffHours: "9" } });

    const rows = await rowsOf("Config");
    eq(rows.length, 1, "still exactly one Config row");
    eq(rows[0].cutoffHours, "9", "the later write won");
    eq(rows[0].botGroupChatId, "-100", "and did not blank the rest");
  });

  await test("untracked tabs carry no revision", async () => {
    // ParadeStates / TgUsers / ReportSick / Config sit outside REV_TABS, as
    // they did before. A rev here would make the client poll for tabs it does
    // not hold in STATE.
    const res = await post({
      action: "append", tab: "ParadeStates",
      row: { id: T("P1"), type: "AM", savedAt: String(Date.now()), json: "{}" },
    });
    ok(res.ok, "append accepted");
    ok(res.rev === undefined, "no rev returned");
    ok(!("ParadeStates" in (await get({ action: "revCheck" })).revs), "and none tracked");
  });

  // ── Envelope invariants ───────────────────────────────────────────────────
  suite("live API: response envelope");

  await test("every response is HTTP 200 and carries `build`", async () => {
    // _fetchJson (js/api.js:32-46) never inspects res.ok: a non-2xx carrying
    // JSON is treated as SUCCESS, and a non-JSON body becomes a NetError the
    // client retries silently. So errors MUST be 200-with-a-body.
    const cases = [
      await GET({ action: "readAll" }),
      await GET({ action: "read", tab: "NoSuchTab" }),
      await GET({ action: "bogusAction" }),
      await POST({ action: "write", tab: "NoSuchTab", data: [] }),
      await POST({ action: "upsertRow", tab: "Leave", row: {} }),
    ];
    for (const c of cases) {
      eq(c.status, 200, "HTTP 200");
      ok(c.body.build, "carries build");
    }
  });

  await test("an unsupported action answers the literal 'Invalid request'", async () => {
    // Load-bearing string, not a message: js/sync.js:571 probes for exactly
    // this to detect a backend too old to understand applyOps. Returning it
    // for anything a client might legitimately send would silently disable
    // batching for the whole session.
    const res = await post({ action: "updateRow", tab: "Leave", rowIndex: 2, row: {} });
    eq(res.error, "Invalid request");
  });

  await test("rowCount reports live rows only", async () => {
    const res = await post({ action: "rowCount", tab: "Leave" });
    ok(res.ok, "ok");
    eq(res.dataRows, (await rowsOf("Leave")).length, "matches what a read returns");
  });

  await test("a Bearer token authenticates as well as the legacy auth param", async () => {
    // The old backend put the token in GET query strings (js/api.js:70), where
    // it landed in execution logs and browser history. The header path exists
    // because this backend can answer OPTIONS, which Apps Script never could.
    const res = await (await fetch(`${API}?action=revCheck`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json();
    ok(res.ok, "bearer token accepted");

    const pre = await fetch(API, { method: "OPTIONS" });
    ok(pre.headers.get("access-control-allow-origin"), "and CORS preflight is answered");
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  suite("live API: cleanup");

  await test("test fixtures are removed", async () => {
    for (const id of [T("L1"), T("L2"), T("L4"), T("L6")]) {
      await post({ action: "deleteRowById", tab: "Leave", id });
    }
    await post({ action: "deleteRowById", tab: "Roster", id: TEST_4D });
    await post({ action: "deleteRowById", tab: "ParadeStates", id: T("P1") });

    // Put SOC and MSK back the way they were found. `write` refuses an empty
    // payload by design, so a tab that STARTED empty cannot be emptied again
    // through the API — SOC's rows carry ids and come out one by one; MSK's do
    // not, and one marker row is the honest cost of testing a no-id tab.
    for (const tab of ["SOC", "MSK"]) {
      if (SNAPSHOT[tab].length) {
        await post({ action: "write", tab, baseRev: await revOf(tab), data: SNAPSHOT[tab] });
      }
    }
    for (const r of await rowsOf("SOC")) {
      if (String(r.id).startsWith("T_")) {
        await post({ action: "deleteRowById", tab: "SOC", id: r.id });
      }
    }

    const leftovers = [
      ...(await rowsOf("Leave")), ...(await rowsOf("SOC")), ...(await rowsOf("Roster")),
    ].filter((r) => String(r.id).startsWith("T_") || r.id === TEST_4D);
    eq(leftovers, [], "no test rows left behind");

    eq((await rowsOf("SOC")).length, SNAPSHOT.SOC.length, "SOC restored to what it held");
    if (SNAPSHOT.MSK.length) {
      eq((await rowsOf("MSK")).length, SNAPSHOT.MSK.length, "MSK restored to what it held");
    }
  });
};

// Run standalone: skip cleanly when no backend is up, so verify.sh and CI can
// call this unconditionally.
if (require.main === module) {
  (async () => {
    try {
      const res = await fetch(`${API}?action=ping`, { signal: AbortSignal.timeout(3000) });
      if (!(await res.json()).ok) throw new Error("ping did not answer ok");
    } catch (e) {
      console.log(`\n# live API contract: SKIPPED — no backend at ${API}`);
      console.log(`#   (${String(e.message || e)})`);
      console.log("#   start one with: ./scripts/dev-env.sh up");
      process.exit(0);
    }
    console.log(`# live API contract against ${API}`);
    await module.exports();
    process.exit(summary());
  })().catch((e) => { console.error(e); process.exit(1); });
}
