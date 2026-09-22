// ============================================================================
// A protocol-faithful in-memory backend for e2e specs.
//
// The previous inline stub in sync-retry.spec.js answered every write with a
// flat `{ok:true, rev:2}`, so nothing that depends on backend SEMANTICS could
// be tested in a real browser: no revisions, no conflicts, no id-idempotent
// append, no partial-column upsert. This implements the actual contract, which
// makes it two useful things at once:
//
//   1. a realistic backend for sync specs, and
//   2. an executable statement of what the Edge Function must satisfy —
//      the same 14 actions, envelopes and revision rules.
//
// It is routed at a SENTINEL URL pinned through localStorage("cougar-api-url"),
// not at script.google.com, so the suite does not care which backend is live.
// ============================================================================

const API_URL = "https://e2e-backend.local/api";

// Tab -> readAll response key. Mirrors TAB_TO_STATE (js/state.js); note that
// rm / polar / conductDetail deliberately differ from their tab names.
const STATE_KEY = {
  Roster: "roster", Medical: "medical", Attendance: "attendance",
  IPPT: "ippt", RouteMarch: "rm", SOC: "soc", PolarFlow: "polar",
  ConductDetail: "conductDetail", Appointments: "appointments",
  Leave: "leave", MSK: "msk", Conducts: "conducts",
  Duty: "duty", Calendar: "calendar", OilRules: "oilRule",
};
const REV_TABS = Object.keys(STATE_KEY);

// Create a backend instance. `opts.seed` pre-populates tabs; `opts.onRequest`
// gets (body, callNumber) and may return a response object to override the
// default (used to inject 503 / 401 / conflict).
function makeBackend(opts = {}) {
  const tabs = {};       // tab -> array of row objects
  const revs = {};       // tab -> integer revision
  for (const t of REV_TABS) { tabs[t] = []; revs[t] = 1; }
  for (const [t, rows] of Object.entries(opts.seed || {})) tabs[t] = rows.map((r) => ({ ...r }));

  let offline = false;   // when true, every request fails at the transport layer
  const posts = [];      // every POST body, in order
  const gets = [];       // every GET {action, tab}
  const requests = [];   // every request {method, url, headers}

  const findIdx = (tab, id) => tabs[tab].findIndex((r) => String(r.id) === String(id));

  // Partial upsert: update ONLY the keys present in the payload. The Apps
  // Script version rebuilt the row from every header and blanked the rest
  // (apps-script-Code.gs:1105-1108), which is the bug this asserts is gone.
  function upsert(tab, row) {
    const i = findIdx(tab, row.id);
    if (i === -1) { tabs[tab].push({ ...row }); return { action: "appended", id: row.id }; }
    tabs[tab][i] = { ...tabs[tab][i], ...row };
    return { action: "updated", id: row.id };
  }

  // Idempotent on id — a retried append must not create a second copy.
  function append(tab, row) {
    if (row.id != null && findIdx(tab, row.id) !== -1) return { action: "noop", id: row.id };
    tabs[tab].push({ ...row });
    return { action: "appended", id: row.id };
  }

  function remove(tab, id) {
    const i = findIdx(tab, id);
    if (i === -1) return { action: "noop", id };
    tabs[tab].splice(i, 1);
    return { action: "deleted", id };
  }

  function handlePost(body) {
    const tab = body.tab;
    const bump = () => (revs[tab] = (revs[tab] || 1) + 1);

    switch (body.action) {
      case "write": {
        // The ONLY action with optimistic concurrency enforced — matching
        // withRevLock(enforce=true) for `write` alone (apps-script-Code.gs:205).
        if (body.baseRev != null && Number(body.baseRev) !== revs[tab]) {
          return { conflict: true, tab, serverRev: revs[tab] };
        }
        tabs[tab] = (body.data || []).map((r) => ({ ...r }));
        return { ok: true, tab, rowsWritten: tabs[tab].length, rev: bump() };
      }
      case "append":
        return { ok: true, tab, ...append(tab, body.row || {}), rev: bump() };
      case "appendMany": {
        let n = 0;
        for (const r of body.rows || []) if (append(tab, r).action === "appended") n++;
        return { ok: true, tab, rowsAppended: n, rev: bump() };
      }
      case "upsertRow":
        return { ok: true, tab, ...upsert(tab, body.row || {}), rev: bump() };
      case "deleteRowById":
        return { ok: true, tab, ...remove(tab, body.id), rev: bump() };
      case "applyOps": {
        // Ordered, partial success, ONE rev bump for the whole batch.
        const results = [];
        let applied = 0, failed = 0;
        for (const op of body.ops || []) {
          let r;
          if (op.op === "upsert") r = upsert(tab, op.row || {});
          else if (op.op === "append") r = append(tab, op.row || {});
          else if (op.op === "delete") r = remove(tab, op.id);
          else r = { error: `Unknown op '${op.op}'` };
          if (r.error) { failed++; } else { applied++; }
          results.push(r);
        }
        return { ok: true, tab, applied, failed, results, rev: bump() };
      }
      case "rowCount":
        return { ok: true, tab, dataRows: (tabs[tab] || []).length };
      default:
        // Also sync.js's probe for a backend without applyOps (js/sync.js:571).
        return { error: "Invalid request" };
    }
  }

  function handleGet(url) {
    const action = url.searchParams.get("action") || "readAll";
    const tab = url.searchParams.get("tab") || "";
    if (action === "ping") return { ok: true, sheets: REV_TABS, timestamp: Date.now() };
    if (action === "revCheck") return { ok: true, revs: { ...revs }, timestamp: Date.now() };
    if (action === "read") return { rows: (tabs[tab] || []).map((r) => ({ ...r })), rev: revs[tab] };
    if (action === "readAll") {
      const out = { timestamp: Date.now(), sheetName: "e2e", revs: { ...revs } };
      for (const t of REV_TABS) out[STATE_KEY[t]] = tabs[t].map((r) => ({ ...r }));
      return out;
    }
    return { error: "Unknown action. Use: readAll, revCheck, read&tab=TabName, or ping" };
  }

  // Install on a Playwright page. MUST be called before navigation.
  async function install(page) {
    // Pin the sentinel URL so the app talks to us regardless of which backend
    // js/state.js currently ships with.
    await page.addInitScript((u) => localStorage.setItem("cougar-api-url", u), API_URL);

    await page.route(`${API_URL}**`, async (route) => {
      // Transport-level failure, not an error body — this is what the client
      // sees on a dead network, and it maps to NetError in js/api.js:39-42.
      if (offline) return route.abort("internetdisconnected");

      const req = route.request();
      const url = new URL(req.url());
      requests.push({
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
      });

      const fulfill = (obj) => route.fulfill({
        status: 200,
        contentType: "application/json",
        // Every response carries `build`, as the real backends do.
        body: JSON.stringify({ build: "e2e", ...obj }),
      });

      if (req.method() === "GET") {
        gets.push({ action: url.searchParams.get("action"), tab: url.searchParams.get("tab") });
        const override = opts.onRequest && opts.onRequest({ method: "GET", action: url.searchParams.get("action") }, requests.length);
        return fulfill(override || handleGet(url));
      }

      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch { /* keep {} */ }
      posts.push(body);
      const override = opts.onRequest && opts.onRequest(body, posts.length);
      return fulfill(override || handlePost(body));
    });
  }

  return {
    install, API_URL,
    posts, gets, requests,
    tabs, revs,
    rows: (tab) => tabs[tab],
    row: (tab, id) => tabs[tab].find((r) => String(r.id) === String(id)),
    rev: (tab) => revs[tab],
    // Simulate the network dropping out from under the device.
    setOffline(v) { offline = v; },
    isOffline: () => offline,
    // Simulate another device writing, so the local client goes stale.
    bumpFromElsewhere(tab, mutate) {
      if (mutate) mutate(tabs[tab]);
      revs[tab] = (revs[tab] || 1) + 1;
    },
  };
}

// Write actions, for filtering captured posts.
const WRITE_ACTIONS = ["applyOps", "upsertRow", "append", "appendMany", "deleteRowById", "write"];
const writePosts = (posts) => posts.filter((p) => WRITE_ACTIONS.includes(p.action));

module.exports = { makeBackend, writePosts, WRITE_ACTIONS, API_URL, STATE_KEY, REV_TABS };
