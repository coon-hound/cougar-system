// Failure-class retry scenarios: REAL frontend (state/api/sync.js) against the
// REAL Apps Script backend, with per-client fault injection (client.intercept)
// and the browser mock's FAKE timer queue driving every backoff sleep. Covers
// 503 busy retries, offline parking, the 401 sign-in state, dirty-op
// persistence across "reloads", applyOps batching + old-backend fallback, and
// the replace-conflict banner.
const { suite, test, ok, eq } = require("./_tap");
const { loadBackend, makeClient } = require("./harness");

const MED_HEADERS = ["id", "d4", "date", "reason", "location", "status", "startDate", "endDate"];
const med = (id, reason, extra) => Object.assign({ id, d4: "11" + id, date: "", reason, location: "", status: "", startDate: "", endDate: "" }, extra || {});

const BUSY = () => ({ error: "Server busy, please retry", code: 503 });
const UNAUTH = () => ({ error: "Unauthorized — invite required", code: 401 });

// One macrotask turn: every queued microtask (whole await-chains) runs first.
const turn = () => new Promise(r => setImmediate(r));

// Drive a promise to settlement by firing fake timers ONE at a time whenever
// it stalls (the code under test sleeps between retries; nothing fires unless
// we fire it). Throws if the promise stalls with no timer left to fire.
async function drive(client, p) {
  let done = false;
  const guarded = p.then(v => { done = true; return { v }; }, e => { done = true; return { e }; });
  for (let i = 0; i < 500 && !done; i++) {
    await turn();
    if (done) break;
    const fired = await client.ctl.timers.next();
    if (!fired && !done) {
      await turn();
      if (!done) throw new Error("drive(): promise stalled with no pending timers");
    }
  }
  const res = await guarded;
  if ("e" in res) throw res.e;
  return res.v;
}

module.exports = async function run() {
  suite("sync-retry: 503 busy handling");

  // (a) Two 503s then success → the op lands in place: same op re-dispatched,
  // no pull in between, no dirty state, and the backoff delays grow.
  await test("503 twice then ok: in-place retry, no GET, growing backoff", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;
    A.ctl.timers.log.length = 0;
    let busyLeft = 2;
    A.intercept = (rec, body) => (rec.method === "POST" && body.action === "upsertRow" && busyLeft-- > 0) ? BUSY() : null;

    await drive(A, A.sb.autoSync("Medical", { type: "upsert", row: med(1, "hello") }));

    eq(A.sb.STATE.dirty.size, 0, "not dirty after in-place recovery");
    eq(backend.db.rowsOf("Medical").length, 1, "op landed");
    eq(A.fetchSpy.filter(r => r.method === "POST").length, 3, "three dispatches: 2 busy + 1 ok");
    ok(!A.fetchSpy.some(r => r.method === "GET"), "no pull between busy retries");
    // Backoff sleeps are the sub-10s timers (the per-fetch abort timers are 30s+).
    const sleeps = A.ctl.timers.log.filter(t => t.delay > 0 && t.delay < 10000).map(t => t.delay);
    eq(sleeps.length, 2, "two backoff sleeps");
    ok(sleeps[1] > sleeps[0], `delays grow (${sleeps.join(" → ")})`);
  });

  // (b) Persistent 503 → in-place retries exhaust → dirty + auto-retry armed →
  // fault lifts → the scheduled pass heals everything with no user action.
  await test("persistent 503: dirty + scheduled retry, heals when server recovers", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;
    let busy = true;
    A.intercept = (rec, body) => (busy && rec.method === "POST" && body.action === "upsertRow") ? BUSY() : null;

    await drive(A, A.sb.autoSync("Medical", { type: "upsert", row: med(1, "x") }));

    eq(A.fetchSpy.filter(r => r.method === "POST").length, 5, "initial dispatch + 4 in-place retries");
    eq(A.sb.STATE.dirty.size, 1, "dirty after exhaustion");
    eq(A.sb.__sync.dirtyOps.get("Medical").length, 1, "op stashed for replay");
    ok(A.sb.__sync.retryNextAt != null, "auto-retry pass armed");

    busy = false;
    await A.ctl.timers.flush();

    eq(A.sb.STATE.dirty.size, 0, "clean after the automatic retry pass");
    eq(backend.db.rowsOf("Medical").length, 1, "op landed");
    eq(A.sb.__sync.retryAttempt, 0, "backoff counter reset");
    eq(A.sb.__sync.retryNextAt, null, "no further retry armed");
  });

  suite("sync-retry: offline / online");

  // (c) Offline: NetError rethrows immediately (no in-place retry, no retry
  // timer - the `online` event owns recovery). Coming back online replays.
  await test("offline parks the op with no timer; online replays it", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.sb.initAutoRefresh();   // registers the online listener (main.js does this in the app)
    A.fetchSpy.length = 0;
    A.ctl.setOnline(false);
    A.intercept = rec => { if (rec.method === "POST") throw new Error("network down"); return null; };

    await A.sb.autoSync("Medical", { type: "upsert", row: med(1, "offline-edit") });

    eq(A.sb.STATE.dirty.size, 1, "dirty");
    eq(A.fetchSpy.filter(r => r.method === "POST").length, 1, "no in-place retry while offline");
    eq(A.sb.__sync.retryTimer, null, "no retry timer while offline");
    eq(A.sb.__sync.retryNextAt, null, "no countdown while offline");

    A.intercept = null;
    A.ctl.setOnline(true);            // fires the captured "online" listener
    await A.ctl.timers.advance(5000); // immediate pass is armed at ~1.5s

    eq(A.sb.STATE.dirty.size, 0, "clean after reconnect");
    eq(backend.db.rowsOf("Medical").length, 1, "op landed");
  });

  // A transient blip while ONLINE gets exactly one in-place retry.
  await test("online NetError blip: one in-place retry, then success", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;
    let failLeft = 1;
    A.intercept = rec => { if (rec.method === "POST" && failLeft-- > 0) throw new Error("blip"); return null; };

    await drive(A, A.sb.autoSync("Medical", { type: "upsert", row: med(1, "blip-edit") }));

    eq(A.sb.STATE.dirty.size, 0, "not dirty");
    eq(backend.db.rowsOf("Medical").length, 1, "op landed on the retry");
    eq(A.fetchSpy.filter(r => r.method === "POST").length, 2, "exactly one extra dispatch");
  });

  suite("sync-retry: 401 sign-in state");

  // (d) 401 stops the world: the failing op AND everything still queued are
  // stashed off ONE round trip; no retry timer; authRestored() replays all.
  await test("401: one POST total, queue stashed, authRestored replays all", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;
    let deny = true;
    A.intercept = rec => (deny && rec.method === "POST") ? UNAUTH() : null;

    // The appendMany splits the batch run, so without the stop-the-world
    // drain this would be three separate dispatches.
    await Promise.all([
      A.sb.autoSync("Medical", { type: "upsert", row: med(1, "a") }),
      A.sb.autoSync("Medical", { type: "appendMany", rows: [med(2, "b")] }),
      A.sb.autoSync("Medical", { type: "upsert", row: med(3, "c") })
    ]);

    eq(A.fetchSpy.filter(r => r.method === "POST").length, 1, "exactly ONE POST for the whole queue");
    ok(A.sb.__sync.authFailed, "sign-in state set");
    eq(A.sb.__sync.dirtyOps.get("Medical").length, 3, "all three ops stashed");
    eq(A.sb.__sync.retryTimer, null, "no auto-retry armed while signed out");
    A.sb.scheduleAutoRetry();
    eq(A.sb.__sync.retryTimer, null, "scheduler no-ops while signed out");

    deny = false;
    A.sb.authRestored();              // what main.js calls after a redeem
    await A.ctl.timers.advance(3000);

    ok(!A.sb.__sync.authFailed, "sign-in state cleared");
    eq(A.sb.STATE.dirty.size, 0, "clean after sign-in");
    eq(backend.db.rowsOf("Medical").length, 3, "all three ops landed");
  });

  suite("sync-retry: dirty-op persistence");

  // (e) Stashed ops survive a "reload" (second client over the same store) and
  // replay as GRANULAR ops - never a full-tab replace.
  await test("dirty ops persist across reload and replay granular, not replace", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.ctl.setOnline(false);
    A.intercept = rec => { if (rec.method === "POST") throw new Error("network down"); return null; };
    await Promise.all([
      A.sb.autoSync("Medical", { type: "upsert", row: med(1, "one") }),
      A.sb.autoSync("Medical", { type: "upsert", row: med(2, "two") })
    ]);
    eq(A.sb.STATE.dirty.size, 1, "dirty before reload");
    ok(A.store.get("cougar-dirty-ops-v1"), "stash persisted to localStorage");

    // "Reload": fresh client over the SAME localStorage store.
    const B = makeClient(backend, { store: A.store });
    B.sb.loadLocal();   // main.js bootstrap does this on launch
    eq((B.sb.__sync.dirtyOps.get("Medical") || []).length, 2, "stash loaded on boot");

    B.fetchSpy.length = 0;
    await B.sb.retryAllDirty();
    eq(B.sb.STATE.dirty.size, 0, "clean after replay");
    eq(backend.db.rowsOf("Medical").length, 2, "both rows landed");
    const actions = B.fetchSpy.filter(r => r.method === "POST").map(r => r.action);
    ok(actions.length > 0 && actions.every(a => a === "applyOps" || a === "upsertRow"),
      "replayed granular (" + actions.join(",") + "), never a full write");
    eq(JSON.parse(B.store.get("cougar-dirty-ops-v1")).tabs, {}, "stash cleared after replay");
  });

  await test("corrupt / newer-version dirty-ops payload is discarded cleanly", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const s1 = new Map([
      ["cougar-dirty-tabs", JSON.stringify(["Medical"])],
      ["cougar-dirty-ops-v1", "{corrupt!!"]
    ]);
    const A = makeClient(backend, { store: s1 });
    eq(A.sb.__sync.dirtyOps.size, 0, "corrupt payload discarded");
    eq(A.sb.STATE.dirty.size, 1, "dirty marker survives (replace fallback still possible)");

    const s2 = new Map([
      ["cougar-dirty-tabs", JSON.stringify(["Medical"])],
      ["cougar-dirty-ops-v1", JSON.stringify({ v: 2, tabs: { Medical: [{ type: "upsert", row: med(1, "future") }] } })]
    ]);
    const B = makeClient(backend, { store: s2 });
    eq(B.sb.__sync.dirtyOps.size, 0, "future-version payload discarded");
  });

  suite("sync-retry: applyOps batching");

  // (f) A synchronous burst leaves as ONE applyOps request: order preserved,
  // same-id upserts coalesced, one rev bump for the whole batch.
  await test("burst of upserts → ONE applyOps POST, ordered + coalesced", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;
    const revBefore = A.sb.STATE.rev.Medical;

    const ps = [];
    for (let i = 1; i <= 10; i++) ps.push(A.sb.autoSync("Medical", { type: "upsert", row: med(i, "r" + i) }));
    ps.push(A.sb.autoSync("Medical", { type: "upsert", row: med(10, "r10-final") }));   // same id → keep last
    await Promise.all(ps);

    const posts = A.fetchSpy.filter(r => r.method === "POST");
    eq(posts.length, 1, "one POST for the whole burst");
    eq(posts[0].action, "applyOps", "batched dispatch");
    eq(posts[0].body.ops.length, 10, "11 enqueues coalesced to 10 ops");
    eq(posts[0].body.ops.map(o => String(o.row.id)), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], "order preserved");
    eq(posts[0].body.ops[9].row.reason, "r10-final", "same-id coalesce kept the LAST upsert");
    eq(backend.db.rowsOf("Medical").length, 10, "all rows landed");
    eq(A.sb.STATE.rev.Medical, revBefore + 1, "ONE rev bump for the whole batch");
    eq(A.sb.STATE.dirty.size, 0, "clean");
  });

  await test("old backend ('Invalid request'): falls back to per-row, all land", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;
    A.intercept = (rec, body) => (rec.method === "POST" && body.action === "applyOps") ? { error: "Invalid request" } : null;

    const ps = [];
    for (let i = 1; i <= 5; i++) ps.push(A.sb.autoSync("Medical", { type: "upsert", row: med(i, "r" + i) }));
    await Promise.all(ps);

    ok(A.sb.__sync.batchUnsupported, "backend-too-old flag set for the session");
    eq(A.sb.STATE.dirty.size, 0, "clean");
    eq(backend.db.rowsOf("Medical").length, 5, "all rows landed per-row");
    const posts = A.fetchSpy.filter(r => r.method === "POST");
    eq(posts.filter(p => p.action === "applyOps").length, 1, "batch probed exactly once");
    eq(posts.filter(p => p.action === "upsertRow").length, 5, "then dispatched row by row");
  });

  // A data-problem op inside a batch must not poison the rest: good ops land
  // with one rev bump, the bad op gets ONE individual retry then parks dirty.
  await test("partial batch failure: good ops land, bad op stashed + parked for background retry", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();
    A.fetchSpy.length = 0;

    await Promise.all([
      A.sb.autoSync("Medical", { type: "upsert", row: med(1, "good1") }),
      A.sb.autoSync("Medical", { type: "upsert", row: null }),          // permanently broken op
      A.sb.autoSync("Medical", { type: "upsert", row: med(2, "good2") })
    ]);

    eq(backend.db.rowsOf("Medical").length, 2, "good ops landed despite the bad one");
    eq(A.sb.STATE.dirty.size, 1, "bad op parked as dirty");
    // The failed op is DURABLY stashed (not just re-queued in memory) so a
    // reload can't lose it; the background scheduler replays it later.
    eq((A.sb.__sync.dirtyOps.get("Medical") || []).length, 1, "bad op stashed for durable retry");
    const posts = A.fetchSpy.filter(r => r.method === "POST");
    eq(posts.filter(p => p.action === "applyOps").length, 1, "one batch; no inline per-row retry storm");
    eq(posts.filter(p => p.action === "upsertRow").length, 0, "no inline individual retry");
  });

  // (h) REGRESSION for the critical silent-loss bug: a success on one op must
  // NOT wipe a DIFFERENT op that failed earlier and is still waiting to retry.
  await test("a later success does not erase an earlier still-pending failed op", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();

    // Op A fails persistently (503, exhausts in-place busy retries → parked).
    let failA = true;
    A.intercept = (rec, body) =>
      (failA && rec.method === "POST" && (body.action === "upsertRow" || body.action === "applyOps")) ? BUSY() : null;
    await drive(A, A.sb.autoSync("Medical", { type: "upsert", row: med(1, "A") }));
    eq(A.sb.STATE.dirty.has("Medical"), true, "A parked dirty");
    eq((A.sb.__sync.dirtyOps.get("Medical") || []).length, 1, "A stashed");

    // Op B (a DIFFERENT row) now succeeds - without firing A's pending retry.
    failA = false;
    await A.sb.autoSync("Medical", { type: "upsert", row: med(2, "B") });

    // B landed, but A must STILL be dirty + stashed (not silently dropped).
    ok(backend.db.rowsOf("Medical").find(r => String(r.id) === "2"), "B landed");
    eq(A.sb.STATE.dirty.has("Medical"), true, "A's dirty marker survived B's success");
    eq((A.sb.__sync.dirtyOps.get("Medical") || []).length, 1, "A's stash survived B's success");
  });

  // (h2) The flip side: a NEWER successful edit to the SAME row must EVICT the
  // older failed-and-stashed edit, so a later retry can't replay the stale value
  // over the newer one (same-row silent lost-update).
  await test("a later success to the SAME row evicts the stale stashed edit", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend);
    await A.sb.API.pullAll();

    // Edit row 1 = "v1" → fails, stashed.
    let fail = true;
    A.intercept = (rec, body) =>
      (fail && rec.method === "POST" && (body.action === "upsertRow" || body.action === "applyOps")) ? BUSY() : null;
    await drive(A, A.sb.autoSync("Medical", { type: "upsert", row: med(1, "v1") }));
    eq((A.sb.__sync.dirtyOps.get("Medical") || []).length, 1, "v1 stashed");

    // Re-edit the SAME row 1 = "v2" → succeeds.
    fail = false;
    await A.sb.autoSync("Medical", { type: "upsert", row: med(1, "v2") });
    eq(backend.db.rowsOf("Medical").find(r => String(r.id) === "1").reason, "v2", "server has v2");

    // The stale v1 must be gone from the stash and the tab clean - a retry now
    // can't revert row 1 back to v1.
    eq((A.sb.__sync.dirtyOps.get("Medical") || []).length, 0, "stale v1 evicted by the newer v2");
    eq(A.sb.STATE.dirty.has("Medical"), false, "tab clean (nothing stale left to retry)");
  });

  suite("sync-retry: replace-conflict banner");

  // (g) A stale bulk replace never clobbers silently: the banner offers the
  // held snapshot back; "Push mine anyway" pushes it, dismiss keeps the server.
  await test("stale replace → banner with 'Push mine anyway' pushes the snapshot", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "orig", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();
    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-new") });        // server rev moves
    await A.sb.autoSync("Medical", { type: "replace", data: [med(1, "A-bulk")] });   // stale replace

    ok(backend.db.rowsOf("Medical").find(r => String(r.id) === "2"), "server kept B's row (no silent clobber)");
    const banner = A.ctl.getEl("sync-banner");
    eq(banner.style.display, "flex", "banner shown");
    eq(banner.children[0].textContent,
      '"Medical" changed on another device - your bulk change was NOT saved. It is held on this device.',
      "banner message");
    eq(banner.children[1].textContent, "Push mine anyway", "action button present");

    banner.children[1].onclick();   // push the held snapshot
    await turn(); await turn();

    const rows = backend.db.rowsOf("Medical");
    eq(rows.length, 1, "snapshot replaced the server rows");
    eq(rows[0].reason, "A-bulk", "the held bulk change won");
    eq(A.sb.STATE.dirty.size, 0, "clean");
  });

  await test("stale replace → dismiss keeps the server version", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, [["1", "1101", "", "orig", "", "", "", ""]]);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();
    await B.sb.API.pullAll();
    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-new") });
    await A.sb.autoSync("Medical", { type: "replace", data: [med(1, "A-bulk")] });

    const banner = A.ctl.getEl("sync-banner");
    eq(banner.style.display, "flex", "banner shown");
    banner.children[2].onclick();   // ✕ dismiss
    await turn();

    eq(banner.style.display, "none", "banner dismissed");
    const rows = backend.db.rowsOf("Medical");
    eq(rows.length, 2, "server rows kept");
    eq(rows.find(r => String(r.id) === "1").reason, "orig", "server version untouched");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "2"), "A refreshed to the server rows");
    eq(A.sb.STATE.dirty.size, 0, "not dirty (user chose the server version)");
  });

  suite("sync-retry: launch never overwrites unsynced edits");

  // (i) REGRESSION for the critical launch-overwrite bug: a relaunch whose
  // revCheck shows a dirty tab changed on the server must NOT pull over it (that
  // would drop the unsynced local edit). It refreshes only clean tabs and warns.
  await test("launch does not pull over a dirty tab; the local edit survives", async () => {
    const backend = loadBackend();
    backend.db.seed("Medical", MED_HEADERS, []);
    const A = makeClient(backend), B = makeClient(backend);
    await A.sb.API.pullAll();      // A gets a rev baseline
    await B.sb.API.pullAll();

    // A makes a local Medical edit (applied optimistically to STATE, as the real
    // form handlers do) whose push fails → Medical dirty, edit kept locally.
    A.intercept = rec => rec.method === "POST" ? { error: "permanent boom" } : null;
    A.sb.STATE.medical.push(med(1, "A-local"));
    await A.sb.autoSync("Medical", { type: "upsert", row: med(1, "A-local") });
    A.intercept = null;
    eq(A.sb.STATE.dirty.has("Medical"), true, "Medical dirty on A");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "1"), "A's local edit present");

    // B pushes a different Medical row → the server's Medical rev advances.
    await B.sb.autoSync("Medical", { type: "upsert", row: med(2, "B-remote") });

    // A relaunches. revCheck sees Medical ahead, but Medical is dirty on A.
    A.fetchSpy.length = 0;
    await A.sb.autoSyncOnLaunch();

    ok(A.fetchSpy.some(r => r.action === "revCheck"), "did revCheck");
    ok(!A.fetchSpy.some(r => r.action === "read" && r.tab === "Medical"),
      "did NOT pull over the dirty Medical tab");
    ok(A.sb.STATE.medical.find(r => String(r.id) === "1"), "A's unsynced edit survived the launch");
    eq(A.sb.STATE.dirty.has("Medical"), true, "Medical still dirty (edit still pending)");
  });
};
