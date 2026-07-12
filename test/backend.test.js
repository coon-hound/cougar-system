// Backend unit tests — run the REAL apps-script-Code.gs functions against the
// in-memory Sheets/Properties/Lock mocks. Also validates mock fidelity.
const { suite, test, ok, eq } = require("./_tap");
const { loadBackend, VALID_TOKEN } = require("./harness");

module.exports = async function run() {
  suite("backend: revisions + OCC");

  const post = (backend, body) => {
    const out = backend.doPost({ parameter: {}, postData: { contents: JSON.stringify(Object.assign({ auth: VALID_TOKEN }, body)) } });
    return JSON.parse(out.getContent());
  };

  await test("getRev seeds to 1, bumpRev increments", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    eq(b.getRev("Medical"), 1);
    eq(b.bumpRev("Medical"), 2);
    eq(b.getRev("Medical"), 2);
  });

  await test("upsert with matching baseRev applies + bumps", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    const r = post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "fever" }, baseRev: b.getRev("Medical") });
    ok(r.ok, "ok");
    eq(r.rev, 2, "rev bumped");
    eq(b.db.rowsOf("Medical").length, 1, "row written");
  });

  await test("upsert with stale baseRev APPLIES (row-scoped, not rejected)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: 1 }); // -> rev 2
    // A DIFFERENT row with a now-stale baseRev must still apply — upsert is
    // row-scoped, so two devices on different recruits never conflict.
    const r = post(b, { action: "upsertRow", tab: "Medical", row: { id: 2, reason: "b" }, baseRev: 1 });
    ok(r.ok && !r.conflict, "row-scoped upsert applies despite stale baseRev");
    eq(b.db.rowsOf("Medical").length, 2, "both rows present");
  });

  await test("full write (replace) with stale baseRev IS rejected (catastrophe path)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], [["1", "a"]]);
    post(b, { action: "upsertRow", tab: "Medical", row: { id: 2, reason: "b" }, baseRev: b.getRev("Medical") }); // rev↑
    const r = post(b, { action: "write", tab: "Medical", data: [{ id: 1, reason: "bulk" }], baseRev: 1 }); // stale replace
    ok(r.conflict, "stale full-tab replace is rejected");
    eq(b.db.rowsOf("Medical").length, 2, "rows NOT clobbered");
  });

  await test("missing baseRev applies (backward-compat) + still bumps", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    const before = b.getRev("Medical");
    const r = post(b, { action: "upsertRow", tab: "Medical", row: { id: 9, reason: "x" } }); // no baseRev
    ok(r.ok && !r.conflict, "applied, no conflict");
    ok(r.rev > before, "rev still bumped");
  });

  await test("append never conflicts even when far behind", () => {
    const b = loadBackend();
    b.db.seed("Roster", ["id", "name"], []);
    b.bumpRev("Roster"); b.bumpRev("Roster"); // server at rev 3-ish
    const r = post(b, { action: "append", tab: "Roster", row: { id: 1, name: "Z" }, baseRev: 1 });
    ok(r.ok && !r.conflict, "append applied despite stale baseRev");
    eq(b.db.rowsOf("Roster").length, 1, "row appended");
  });

  await test("ensureColumnsForKeys adds a missing column on upsert", () => {
    const b = loadBackend();
    b.db.seed("Roster", ["id", "name"], [["1", "Alice"]]);
    post(b, { action: "upsertRow", tab: "Roster", row: { id: "1", name: "Alice", phone: "999" }, baseRev: b.getRev("Roster") });
    eq(b.db.rowsOf("Roster")[0].phone, "999", "new field persisted in a new column");
  });

  await test("deleteRowById removes the row and bumps", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], [["1", "a"], ["2", "b"]]);
    const r = post(b, { action: "deleteRowById", tab: "Medical", id: "1", baseRev: b.getRev("Medical") });
    ok(r.ok, "ok");
    eq(b.db.rowsOf("Medical").map(x => x.id), ["2"], "row 1 deleted");
  });

  suite("backend: readTab double-read optimization");

  await test("getDisplayValues NOT called for a date-free tab", () => {
    const b = loadBackend();
    b.db.seed("Plain", ["id", "name"], [["1", "Alice"], ["2", "Bob"]]);
    b.db.spy.getDisplayValues = 0;
    const rows = b.readTab("Plain");
    eq(rows.length, 2, "rows read");
    eq(b.db.spy.getDisplayValues, 0, "no second (display) read when no time-only cells");
  });

  await test("getDisplayValues IS called when a time-only Date cell exists", () => {
    const b = loadBackend();
    const timeOnly = new Date(1899, 11, 30, 7, 30, 0); // epoch date → year < 1900
    b.db.seed("Times", ["id", "time"], [["1", timeOnly]]);
    b.db.spy.getDisplayValues = 0;
    b.readTab("Times");
    ok(b.db.spy.getDisplayValues > 0, "display read happens for time-only cells");
  });

  suite("backend: revCheck + readAll carry revisions");

  await test("revCheck returns per-tab revs; readAll includes revs", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: b.getRev("Medical") });
    const rc = JSON.parse(b.doGet({ parameter: { action: "revCheck", auth: VALID_TOKEN } }).getContent());
    ok(rc.ok && rc.revs, "revCheck shape");
    ok(rc.revs.Medical >= 2, "Medical rev reflected");
    const all = JSON.parse(b.doGet({ parameter: { action: "readAll", auth: VALID_TOKEN } }).getContent());
    ok(all.revs && typeof all.revs.Medical === "number", "readAll carries revs");
  });

  await test("unauthorized request is rejected", () => {
    const b = loadBackend();
    const out = JSON.parse(b.doGet({ parameter: { action: "readAll", auth: "bogus" } }).getContent());
    eq(out.code, 401, "401 for bad token");
  });

  suite("backend: lock isolation (tgPoll must never block data writes)");

  await test("data write SUCCEEDS while the script lock is held (tgPoll mid-poll)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    b.db.locks.hold("script");                 // simulate tgPoll long-polling
    const r = post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: 1 });
    ok(r.ok && !r.error, "write unaffected by a held script lock");
    eq(b.db.rowsOf("Medical").length, 1, "row written");
  });

  await test("data write gets 503 (not applied, no bump) while the DOCUMENT lock is held", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    const before = b.getRev("Medical");
    b.db.locks.hold("document");
    const r = post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: before });
    eq(r.code, 503, "busy response");
    eq(b.db.rowsOf("Medical").length, 0, "row NOT written");
    eq(b.getRev("Medical"), before, "rev NOT bumped");
  });

  await test("data writes acquire ONLY the document lock", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: 1 });
    ok(b.db.locks.acquired("document") >= 1, "document lock used");
    eq(b.db.locks.acquired("script"), 0, "script lock never touched by a data write");
  });

  await test("tgPoll acquires ONLY the script lock, and bails silently when it's held", () => {
    const b = loadBackend();
    b.db.setProp("TG_BOT_TOKEN", "tok");
    b.TG_POLL_BUDGET_MS = 0;                   // skip the long-poll loop body
    b.tgPoll();
    eq(b.db.locks.acquired("script"), 1, "script lock acquired");
    eq(b.db.locks.acquired("document"), 0, "document lock never touched by the poller");
    b.db.locks.hold("script");
    b.tgPoll();                                // another poller already running → bail
    eq(b.db.spy.urlFetch, 0, "no Telegram fetch when the lock is held");
  });

  await test("unbound script fails LOUD, not as a misleading 503", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    b.db.setUnbound();                         // getDocumentLock() → null
    const r = post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: 1 });
    ok(r.error && /container-bound/.test(r.error), "error names the real cause: " + r.error);
    ok(r.code !== 503, "not disguised as Server busy");
  });

  await test("bot Medical append (tgCompleteMC path) bumps the rev atomically via withRevLock", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "d4", "date", "reason", "location", "status", "startDate", "endDate"], []);
    const before = b.getRev("Medical");
    // Call the same wrapper the bot now uses, not appendRow+manual bump.
    b.withRevLock("Medical", null, false, () => b.appendRow("Medical", { id: 1, d4: "C1401", reason: "rs" }));
    eq(b.getRev("Medical"), before + 1, "exactly one bump");
    ok(b.db.locks.acquired("document") >= 1, "bot data write went through the document lock");
  });

  suite("backend: applyOps (batched granular mutations)");

  await test("mixed ops apply IN ORDER with exactly one rev bump and aligned results", () => {
    const b = loadBackend();
    b.db.seed("Roster", ["id", "name"], [["1", "Alice"]]);
    const before = b.getRev("Roster");
    const r = post(b, {
      action: "applyOps", tab: "Roster", baseRev: before, ops: [
        { op: "upsert", row: { id: "1", name: "Alice2" } },   // update in place
        { op: "delete", id: "1" },                            // then remove it
        { op: "append", row: { id: "2", name: "Bob" } }       // then add another
      ]
    });
    ok(r.ok, "batch ok");
    eq(r.applied, 3, "all applied");
    eq(r.failed, 0, "none failed");
    eq(r.results.length, 3, "results align with ops");
    eq(r.rev, before + 1, "ONE bump for the whole batch");
    // Order matters: upsert→delete→append must leave only Bob. A reordering
    // (e.g. delete last) would leave Alice2 or nothing.
    eq(b.db.rowsOf("Roster").map(x => x.name), ["Bob"], "ops applied in order");
  });

  await test("one bad op does not abort the rest (partial success still bumps once)", () => {
    const b = loadBackend();
    // Medical, not Roster: Roster appends can trigger sortRosterBy4d, which
    // does its own (pre-existing, editor-runnable) bumpRev — that would make
    // the exact-one-bump assertion measure the sort, not the batch.
    b.db.seed("Medical", ["id", "reason"], []);
    const before = b.getRev("Medical");
    const r = post(b, {
      action: "applyOps", tab: "Medical", baseRev: before, ops: [
        { op: "upsert", row: { id: "1", reason: "a" } },
        { op: "upsert", row: { reason: "no-id" } },           // upsertRow requires id → error
        { op: "upsert", row: { id: "2", reason: "b" } }
      ]
    });
    ok(r.ok, "batch still ok");
    eq(r.applied, 2, "good ops applied");
    eq(r.failed, 1, "bad op counted");
    ok(r.results[1].error, "failed slot carries the error");
    eq(r.rev, before + 1, "still exactly one bump");
    eq(b.db.rowsOf("Medical").length, 2, "good rows written");
  });

  await test("all-failed batch returns {error} and does NOT bump", () => {
    const b = loadBackend();
    b.db.seed("Roster", ["id", "name"], []);
    const before = b.getRev("Roster");
    const r = post(b, { action: "applyOps", tab: "Roster", baseRev: before, ops: [{ op: "nope" }] });
    ok(r.error, "error response");
    eq(b.getRev("Roster"), before, "rev NOT bumped when nothing changed");
  });

  await test("empty and oversized batches are rejected without a bump", () => {
    const b = loadBackend();
    b.db.seed("Roster", ["id", "name"], []);
    const before = b.getRev("Roster");
    ok(post(b, { action: "applyOps", tab: "Roster", ops: [] }).error, "empty rejected");
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ op: "upsert", row: { id: i } }));
    ok(/Too many/.test(post(b, { action: "applyOps", tab: "Roster", ops: tooMany }).error), "oversize rejected");
    eq(b.getRev("Roster"), before, "no bump from rejected batches");
  });

  suite("backend: append idempotency (retry-safe)");

  await test("appendRow with an existing id is a no-op (no duplicate row)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], [["1", "a"]]);
    const r = post(b, { action: "append", tab: "Medical", row: { id: "1", reason: "dup" }, baseRev: b.getRev("Medical") });
    ok(r.ok, "ok");
    eq(r.action, "noop", "recognized as already present");
    eq(b.db.rowsOf("Medical").length, 1, "no duplicate row");
  });

  await test("appendMany skips rows whose id already exists (retried batch)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], [["1", "a"]]);
    // Batch with one existing (1) + two new (2,3).
    const r1 = post(b, { action: "appendMany", tab: "Medical", rows: [{ id: "1", reason: "x" }, { id: "2", reason: "b" }, { id: "3", reason: "c" }], baseRev: b.getRev("Medical") });
    ok(r1.ok, "ok");
    eq(r1.rowsAppended, 2, "only the two new rows appended");
    eq(b.db.rowsOf("Medical").map(x => x.id).sort(), ["1", "2", "3"], "no duplicate of id 1");
    // Full replay of the same batch → nothing added.
    const r2 = post(b, { action: "appendMany", tab: "Medical", rows: [{ id: "1", reason: "x" }, { id: "2", reason: "b" }, { id: "3", reason: "c" }], baseRev: b.getRev("Medical") });
    eq(r2.rowsAppended, 0, "replayed appendMany adds nothing");
    eq(b.db.rowsOf("Medical").length, 3, "still three rows");
  });

  await test("applyOps append op is id-idempotent (batched replay adds nothing)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    const ops = [{ op: "append", row: { id: "7", reason: "once" } }];
    post(b, { action: "applyOps", tab: "Medical", ops, baseRev: b.getRev("Medical") });
    post(b, { action: "applyOps", tab: "Medical", ops, baseRev: b.getRev("Medical") });
    eq(b.db.rowsOf("Medical").length, 1, "append op did not duplicate on replay");
  });

  suite("backend: build stamp + non-ok logging");

  await test("every response carries the BACKEND_BUILD stamp (ping, revCheck, write, 401)", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], []);
    const ping = JSON.parse(b.doGet({ parameter: { action: "ping" } }).getContent());
    eq(ping.build, b.BACKEND_BUILD, "ping stamped");
    const rc = JSON.parse(b.doGet({ parameter: { action: "revCheck", auth: VALID_TOKEN } }).getContent());
    eq(rc.build, b.BACKEND_BUILD, "revCheck stamped");
    const wr = post(b, { action: "upsertRow", tab: "Medical", row: { id: 1, reason: "a" }, baseRev: 1 });
    eq(wr.build, b.BACKEND_BUILD, "write response stamped");
    const bad = JSON.parse(b.doGet({ parameter: { action: "readAll", auth: "bogus" } }).getContent());
    eq(bad.build, b.BACKEND_BUILD, "error body stamped");
  });

  await test("non-ok responses are warn-logged with action+tab+code, ok responses are not", () => {
    const b = loadBackend();
    b.db.seed("Medical", ["id", "reason"], [["1", "a"]]);
    const w0 = b.db.spy.warns.length;
    post(b, { action: "upsertRow", tab: "Medical", row: { id: 2, reason: "b" }, baseRev: 1 });
    eq(b.db.spy.warns.length, w0, "successful write logs nothing");
    b.doGet({ parameter: { action: "readAll", auth: "bogus" } });
    const authLine = b.db.spy.warns[b.db.spy.warns.length - 1];
    ok(/\[cougar-nonok\].*code=401/.test(authLine), "401 logged: " + authLine);
    post(b, { action: "write", tab: "Medical", data: [{ id: "1", reason: "z" }], baseRev: 1 }); // stale → conflict
    const confLine = b.db.spy.warns[b.db.spy.warns.length - 1];
    ok(/\[cougar-nonok\].*conflict serverRev=/.test(confLine), "conflict logged: " + confLine);
    ok(!b.db.spy.warns.some(l => /reason|Alice|tok/.test(l)), "no payload/PII in log lines");
  });
};
