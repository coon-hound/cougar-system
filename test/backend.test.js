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
};
