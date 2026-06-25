// End-to-end concurrency scenarios: REAL frontend (state/api/sync.js) talking to
// the REAL Apps Script backend through the mock fetch. Each test spins up one or
// more "tabs" (clients) sharing a single backend — true multi-client behavior.
const { suite, test, ok, eq } = require("./_tap");
const { loadBackend, makeClient } = require("./harness");

const MED_HEADERS = ["id", "d4", "date", "reason", "location", "status", "startDate", "endDate"];
const med = (id, reason, extra) => Object.assign({ id, d4: "11" + id, date: "", reason, location: "", status: "", startDate: "", endDate: "" }, extra || {});

module.exports = async function run() {
  suite("sync: concurrency (real frontend ↔ real backend)");

  // 1) Two devices editing DIFFERENT recruits in the same tab → both save with
  // NO conflict (row-scoped upsert), and each converges via auto-refresh. This
  // is the exact field scenario that was wrongly conflicting before.
  await test("two devices edit different rows → both save, no conflict", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "old", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-new") });          // recruit 2 (rev↑)
    A.sb.STATE.medical[0].reason = "A-edited";
    await A.sb.autoSync("Medical", { type: "upsert", row: med(1, "A-edited") });        // recruit 1, stale rev — still fine

    const rows = backend.db.rowsOf("Medical");
    eq(rows.map(r => String(r.id)).sort(), ["1", "2"], "both rows on the sheet");
    eq(rows.find(r => String(r.id) === "1").reason, "A-edited", "A's edit landed");
    eq(rows.find(r => String(r.id) === "2").reason, "B-new", "B's edit landed");
    eq(A.sb.STATE.dirty.size, 0, "no conflict, A not dirty");
    eq(B.sb.STATE.dirty.size, 0, "no conflict, B not dirty");

    // A's own write advanced its rev to current, so it won't auto-pull until the
    // tab rev moves again. After any further change, A converges to B's row.
    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-new2") });
    await A.sb.autoRefreshTick("interval");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "2"), "A converges to B's row once the rev advances");
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

  // 1b) Many interleaved writes to DIFFERENT rows from two devices must all land
  // and leave nobody dirty — no false-conflict storm.
  await test("interleaved different-row writes from two devices never go dirty", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();

    await Promise.all([
      A.sb.autoSync("Medical", { type: "upsert", row: med(1, "a1") }),
      B.sb.autoSync("Medical", { type: "upsert", row: med(2, "b1") }),
      A.sb.autoSync("Medical", { type: "upsert", row: med(3, "a2") }),
      B.sb.autoSync("Medical", { type: "upsert", row: med(4, "b2") })
    ]);

    eq(A.sb.STATE.dirty.size, 0, "A clean (no false conflict)");
    eq(B.sb.STATE.dirty.size, 0, "B clean (no false conflict)");
    eq(backend.db.rowsOf("Medical").length, 4, "all four distinct rows saved");
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

  suite("sync: recovery from a stuck 'unsaved' state");

  // A post-reload stuck device (dirty marker, stale rev, no in-memory stashed
  // ops) must self-clear on retry — not stay permanently in the error state.
  await test("retryAllDirty self-clears a stale dirty tab", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "srv", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();
    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B") });  // server moves ahead
    A.sb.STATE.dirty = new Set(["Medical"]);   // simulate leftover dirty marker
    A.sb.STATE.medical[0].reason = "A-local";
    await A.sb.retryAllDirty();
    eq(A.sb.STATE.dirty.size, 0, "dirty cleared after retry (replace→conflict→pull→clear)");
  });

  // The escape hatch: discard local unsynced changes and reload from the sheet.
  await test("forceResync discards dirty + reloads authoritative state", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "server-row", "", "", "", ""]]);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.sb.STATE.dirty = new Set(["Medical", "Roster"]);
    A.sb.STATE.medical = [{ id: 1, reason: "local-unsynced" }];   // never reached the server
    await A.sb.forceResync();   // mock confirm() returns true
    eq(A.sb.STATE.dirty.size, 0, "dirty cleared");
    eq(A.sb.STATE.medical.find(r => String(r.id) === "1").reason, "server-row", "reloaded authoritative data");
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
