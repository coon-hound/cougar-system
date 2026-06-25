// End-to-end concurrency scenarios: REAL frontend (state/api/sync.js) talking to
// the REAL Apps Script backend through the mock fetch. Each test spins up one or
// more "tabs" (clients) sharing a single backend — true multi-client behavior.
const { suite, test, ok, eq } = require("./_tap");
const { loadBackend, makeClient } = require("./harness");

const MED_HEADERS = ["id", "d4", "date", "reason", "location", "status", "startDate", "endDate"];
const med = (id, reason, extra) => Object.assign({ id, d4: "11" + id, date: "", reason, location: "", status: "", startDate: "", endDate: "" }, extra || {});

module.exports = async function run() {
  suite("sync: concurrency (real frontend ↔ real backend)");

  // 1) Stale edit auto-merges — the core catastrophe, now prevented.
  await test("stale edit to row A while B added row B → BOTH survive", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "old", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-new") });        // server rev → 2
    A.sb.STATE.medical[0].reason = "A-edited";                                         // A edits locally (stale)
    await A.sb.autoSync("Medical", { type: "upsert", row: med(1, "A-edited") });       // baseRev 1 → conflict → merge

    const rows = backend.db.rowsOf("Medical");
    eq(rows.map(r => String(r.id)).sort(), ["1", "2"], "both rows on the sheet");
    eq(rows.find(r => String(r.id) === "1").reason, "A-edited", "A's edit landed");
    eq(rows.find(r => String(r.id) === "2").reason, "B-new", "B's row not clobbered");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "2"), "A picked up B's row via the conflict pull");
    eq(A.sb.STATE.dirty.size, 0, "tab not left dirty");
  });

  // 2) Stale full replace is rejected — never clobbers.
  await test("stale full replace rejected; B's row survives", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "A", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-new") });          // server rev → 2
    await A.sb.autoSync("Medical", { type: "replace", data: [med(1, "A-bulk")] });     // stale replace (omits row 2)

    const rows = backend.db.rowsOf("Medical");
    ok(rows.find(r => String(r.id) === "2"), "B's row still on the sheet (replace did not wipe it)");
    eq(rows.find(r => String(r.id) === "1").reason, "A", "row 1 unchanged (stale replace rejected)");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "2"), "A refreshed and now sees B's row");
  });

  // 3) Append never conflicts.
  await test("append applies even when far behind", async () => {
    const backend = loadBackend();
    backend.db.seed("Roster", ["id", "name"], []);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();
    await B.sb.autoSync("Roster", { type: "upsert", row: { id: 1, name: "B" } });      // server rev → 2
    await A.sb.autoSync("Roster", { type: "append", row: { id: 2, name: "A" } });      // baseRev stale, but append
    eq(backend.db.rowsOf("Roster").length, 2, "append applied despite stale rev");
    eq(A.sb.STATE.dirty.size, 0, "not dirty");
  });

  // 1b) Conflict against a MOVING target (server rev keeps advancing while we
  // resolve) must still settle in-line, not bounce to the dirty "retry" list.
  await test("conflict vs a moving target resolves without going dirty", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "old", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    // Make the server move on A's first two write attempts: B writes a fresh row
    // right before A's upsert reaches the server, so A keeps seeing a newer rev.
    const realUpsert = A.sb.API.upsertRow.bind(A.sb.API);
    let moves = 0;
    A.sb.API.upsertRow = async (tab, row) => {
      if (tab === "Medical" && moves < 2) { moves++; await B.sb.autoSync("Medical", { type: "upsert", row: med(100 + moves, "B" + moves) }); }
      return realUpsert(tab, row);
    };

    A.sb.STATE.medical[0].reason = "A-edited";
    await A.sb.autoSync("Medical", { type: "upsert", row: med(1, "A-edited") });

    eq(A.sb.STATE.dirty.size, 0, "settled in-line, not left dirty");
    const rows = backend.db.rowsOf("Medical");
    eq(rows.find(r => String(r.id) === "1").reason, "A-edited", "A's edit landed");
    ok(rows.length >= 3, "B's interleaved rows also survived");
  });

  suite("sync: auto-refresh");

  // 4) Auto-refresh pulls ONLY the changed tab (not readAll).
  await test("autoRefreshTick pulls only the changed tab", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();
    await B.sb.autoSync("Medical", { type: "upsert", row: med(5, "B-fresh") });        // server Medical rev↑

    A.fetchSpy.length = 0;
    await A.sb.autoRefreshTick("interval");
    const actions = A.fetchSpy.map(r => r.action);
    ok(actions.includes("revCheck"), "polled revCheck");
    ok(A.fetchSpy.some(r => r.action === "read" && r.tab === "Medical"), "partial-pulled Medical");
    ok(!actions.includes("readAll"), "did NOT do a full readAll");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "5"), "A now has B's row");
  });

  // 5) A dirty tab is NEVER overwritten by auto-refresh.
  await test("dirty tab protected from auto-refresh overwrite", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "orig", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    // A has an unsynced local edit (simulate a prior failed push).
    A.sb.STATE.medical[0].reason = "my-unsynced-edit";
    A.sb.STATE.dirty = new Set(["Medical"]);
    const revBefore = A.sb.STATE.rev.Medical;

    await B.sb.autoSync("Medical", { type: "upsert", row: med(1, "B-changed") });       // server Medical rev↑

    A.fetchSpy.length = 0;
    await A.sb.autoRefreshTick("interval");
    eq(A.sb.STATE.medical[0].reason, "my-unsynced-edit", "local dirty edit NOT overwritten");
    eq(A.sb.STATE.rev.Medical, revBefore, "dirty tab's rev not advanced");
    ok(!A.fetchSpy.some(r => r.action === "read" && r.tab === "Medical"), "did not pull the dirty tab");
  });

  suite("sync: propagation of non-app writes");

  // 6) Manual sheet edit → onEdit trigger bumps rev → other tab auto-refreshes.
  await test("hand edit + onEditBumpRev propagates to other tabs", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "a", "", "", "", ""]]);
    const A = makeClient(backend);
    await A.sb.API.pullAll();

    // Human types a row directly into the sheet (bypassing the app)…
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "a", "", "", "", ""], ["99", "1199", "", "hand-typed", "", "", "", ""]]);
    // …and the installable trigger fires:
    backend.onEditBumpRev({ range: { getSheet: () => ({ getName: () => "Medical" }) } });

    A.fetchSpy.length = 0;
    await A.sb.autoRefreshTick("interval");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "99"), "manual sheet edit propagated to the open tab");
  });

  // 7) Bot write bumps rev (regression for the leak that shipped).
  await test("bot Medical append + bumpRev propagates", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    // Mirrors tgCompleteMC after the fix: append + bumpRev("Medical").
    backend.appendRow("Medical", { id: 77, d4: "1177", reason: "bot sick", status: "" });
    backend.bumpRev("Medical");
    A.fetchSpy.length = 0;
    await A.sb.autoRefreshTick("interval");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "77"), "bot-added row propagated");
  });

  // 7b) Documents the leak class: an append WITHOUT a bump is silently missed.
  await test("append WITHOUT bump is missed (documents why the bump is required)", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    backend.appendRow("Medical", { id: 78, reason: "unbumped" });   // NO bumpRev
    A.fetchSpy.length = 0;
    await A.sb.autoRefreshTick("interval");
    ok(!A.sb.STATE.medical.find(r => String(r.id) === "78"), "unbumped write is NOT seen by revCheck");
  });

  suite("sync: queue + launch");

  // 8) Per-tab queue serializes rapid edits.
  await test("two rapid upserts both land (queue serialization)", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    const before = A.sb.STATE.rev.Medical;
    const p1 = A.sb.autoSync("Medical", { type: "upsert", row: med(1, "first") });
    const p2 = A.sb.autoSync("Medical", { type: "upsert", row: med(2, "second") });
    await Promise.all([p1, p2]);
    eq(backend.db.rowsOf("Medical").length, 2, "both upserts landed");
    eq(A.sb.STATE.rev.Medical, before + 2, "rev bumped twice, no lost op");
  });

  // 9) Launch is incremental when a baseline exists; full pull when not.
  await test("launch does revCheck + partial pull (no readAll) when baselined", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();   // A now has a rev baseline
    await B.sb.API.pullAll();
    await B.sb.autoSync("Medical", { type: "upsert", row: med(3, "x") });
    A.fetchSpy.length = 0;
    await A.sb.autoSyncOnLaunch();
    const actions = A.fetchSpy.map(r => r.action);
    ok(actions.includes("revCheck"), "used revCheck");
    ok(!actions.includes("readAll"), "no full readAll on incremental launch");
    ok(A.fetchSpy.some(r => r.action === "read" && r.tab === "Medical"), "partial-pulled the changed tab");
  });

  await test("launch falls back to full readAll with no baseline", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const C = makeClient(backend);
    C.sb.STATE.rev = {};        // no baseline (first-ever launch / old cache)
    C.fetchSpy.length = 0;
    await C.sb.autoSyncOnLaunch();
    ok(C.fetchSpy.map(r => r.action).includes("readAll"), "full pull when no rev baseline");
  });
};
