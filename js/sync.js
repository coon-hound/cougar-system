// Sync tab UI and all sheet-sync actions (pull / push / ping).
// Also owns the sidebar sync indicator and the launch-time auto-sync.

function renderSync(el) {
  const authed = !!STATE.authToken;
  const authStatusHtml = authed
    ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
         <span style="color:var(--green);font-weight:600">✓ Authenticated</span>
         <span class="mono" style="font-size:10px;color:var(--dim)">${STATE.authToken.slice(0, 8)}…</span>
         <button class="btn btn-danger" onclick="signOut()" style="margin-left:auto">Sign Out</button>
       </div>`
    : `<div style="background:#F8514922;border:1px solid #F8514944;border-radius:6px;padding:10px;margin-bottom:12px;color:var(--red);font-size:12px">
         <strong>Not authenticated.</strong> Ask your admin for an invite link, then open it on this device.
       </div>`;

  el.innerHTML = `
    <h2 style="font-size:18px;font-weight:700;margin-bottom:16px">Sync &amp; Import / Export</h2>
    <div class="sync-panel">
      <h3 style="font-size:14px;color:var(--accent);margin-bottom:12px">🔐 Access</h3>
      ${authStatusHtml}
      <h3 style="font-size:14px;color:var(--accent);margin:16px 0 12px">🔄 Sheet Sync</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-primary" onclick="doPull()" id="pull-btn" ${authed ? "" : "disabled"}>⬇ Pull from Sheet</button>
        <button class="btn btn-success" onclick="doPushAll()" id="push-btn" ${authed ? "" : "disabled"}>⬆ Push All to Sheet</button>
        <button class="btn" onclick="doPing()">🏓 Test Connection</button>
      </div>
      <div id="sync-log" class="sync-log card" style="padding:10px"></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3 style="color:var(--green)">📥 Import</h3>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label class="btn" style="cursor:pointer;text-align:center">Full Backup (JSON)<input type="file" accept=".json" onchange="importBackup(this)" style="display:none"></label>
        </div>
      </div>
      <div class="card">
        <h3 style="color:var(--accent)">📤 Export</h3>
        <button class="btn" onclick="exportJSON({roster:STATE.roster,medical:STATE.medical,attendance:STATE.attendance,ippt:STATE.ippt,rm:STATE.rm,soc:STATE.soc,polar:STATE.polar,conductDetail:STATE.conductDetail,appointments:STATE.appointments,leave:STATE.leave,msk:STATE.msk},'cougar_backup.json')" style="margin-bottom:8px;width:100%">Full Backup (JSON)</button>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn" onclick="exportCSV(STATE.roster,'roster.csv')" style="font-size:10px">Roster</button>
          <button class="btn" onclick="exportCSV(STATE.medical,'medical.csv')" style="font-size:10px">Medical</button>
          <button class="btn" onclick="exportCSV(STATE.attendance,'attendance.csv')" style="font-size:10px">Attend.</button>
          <button class="btn" onclick="exportCSV(STATE.ippt,'ippt.csv')" style="font-size:10px">IPPT</button>
          <button class="btn" onclick="exportCSV(STATE.rm,'rm.csv')" style="font-size:10px">RM</button>
          <button class="btn" onclick="exportCSV(STATE.soc,'soc.csv')" style="font-size:10px">SOC</button>
          <button class="btn" onclick="exportCSV(STATE.polar,'polar.csv')" style="font-size:10px">Polar</button>
          <button class="btn" onclick="exportCSV(STATE.conductDetail,'conduct_detail.csv')" style="font-size:10px">Detail</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="color:var(--pink)">📊 Email Fitness Reports</h3>
      <p style="font-size:12px;color:var(--muted);margin:6px 0 12px;line-height:1.55">
        Send each recruit a personalized HTML email with their Polar fitness trends, conduct attendance, and an encouragement note tailored to their data. Respects the topbar scope filter. Recruits never see anyone else's data.
      </p>
      <button class="btn btn-primary" onclick="openFitnessReportModal()" ${authed ? "" : "disabled"}>📨 Open Report Sender →</button>
    </div>`;
}

function syncLog(msg, color) {
  const el = document.getElementById("sync-log");
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.innerHTML = `<div style="color:${color || 'var(--muted)'}">${t} — ${msg}</div>` + el.innerHTML;
}

// ── Sync timing instrumentation ──────────────────────────
// Times every network round-trip and keeps the last ~30 per category so you can
// see how long syncs actually take. Each call logs "[sync] <label>: <ms>ms" to
// the console; run syncTimingSummary() in the console for min/avg/max/last per
// category. Categories: "revCheck" (the cheap poll), "pull" (full + partial
// data fetches), "write" (each upsert/append/delete/replace round-trip).
const _now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
const _syncTimings = { revCheck: [], pull: [], write: [] };
async function timed(category, label, fn, alsoSyncLog) {
  const t0 = _now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(_now() - t0);
    const buf = _syncTimings[category] || (_syncTimings[category] = []);
    buf.push(ms);
    if (buf.length > 30) buf.shift();
    console.log(`[sync] ${label}: ${ms}ms`);
    if (alsoSyncLog) syncLog(`${label}: ${ms}ms`, "var(--dim)");
  }
}
// Console helper: print a per-category summary of recent sync durations.
function syncTimingSummary() {
  const out = {};
  for (const cat in _syncTimings) {
    const a = _syncTimings[cat];
    if (!a.length) { out[cat] = "(no samples)"; continue; }
    const sum = a.reduce((s, x) => s + x, 0);
    out[cat] = { samples: a.length, last: a[a.length - 1] + "ms", avg: Math.round(sum / a.length) + "ms", min: Math.min(...a) + "ms", max: Math.max(...a) + "ms" };
  }
  console.table(out);
  return out;
}

function setSyncIndicator(text, color) {
  const el = document.getElementById("sync-indicator");
  if (!el) return;
  el.textContent = text;
  el.style.color = color || "";
  // Reset interactivity — refreshSyncIndicator re-applies these for the
  // dirty state. setSyncIndicator alone always renders a passive label.
  el.style.cursor = "";
  el.style.textDecoration = "";
  el.onclick = null;
  el.title = "";
}

// State-aware indicator refresh. Decides the displayed state based on the
// auth/sync/dirty status, and makes the indicator clickable when there are
// dirty tabs that need retrying. Called after every autoSync attempt.
let _lastSyncedAt = null;
let _lastCheckedAt = null;   // last time the lightweight revCheck poll ran
function refreshSyncIndicator() {
  const el = document.getElementById("sync-indicator");
  if (!el) return;
  if (!STATE.authToken) {
    setSyncIndicator("● Not authenticated", "var(--red)");
    return;
  }
  if (_pullInFlight || _activePushCount > 0) {
    setSyncIndicator("● Syncing…", "var(--orange)");
    return;
  }
  const dirtyCount = (STATE.dirty && STATE.dirty.size) || 0;
  if (dirtyCount > 0) {
    el.textContent = `⚠ ${dirtyCount} tab${dirtyCount === 1 ? "" : "s"} need retry · Retry now`;
    el.style.color = "var(--red)";
    el.style.cursor = "pointer";
    el.style.textDecoration = "underline";
    el.title = `Unsynced changes in: ${[...STATE.dirty].join(", ")}. Click to retry all.`;
    el.onclick = retryAllDirty;
    return;
  }
  const stamp = _lastSyncedAt ? new Date(_lastSyncedAt).toLocaleTimeString() : new Date().toLocaleTimeString();
  const checked = _lastCheckedAt ? ` · checked ${new Date(_lastCheckedAt).toLocaleTimeString()}` : "";
  setSyncIndicator(`● Synced ${stamp}${checked}`, "var(--green)");
}

// ── Dirty-tab tracking ────────────────────────────────────
// _dirtyOps stashes the exact granular ops that FAILED to push, so a later
// retry can replay them (each OCC-merges via resolveConflict) instead of a
// stale full-tab replace that would force the user to redo their edit.
const _dirtyOps = new Map();   // tabName → array of failed granular modes
function markDirty(tabName) {
  if (!tabName) return;
  STATE.dirty = STATE.dirty || new Set();
  STATE.dirty.add(tabName);
  saveDirty();
}
function clearDirty(tabName) {
  if (!STATE.dirty) return;
  STATE.dirty.delete(tabName);
  _dirtyOps.delete(tabName);
  saveDirty();
}

// ── Pull/push mutex + per-tab write queue ────────────────
// _pullInFlight blocks all writes during a launch/refresh pull so we never
// push against STATE that's about to be replaced by an arriving pull.
// Writes are queued PER TAB and dispatched one at a time as GRANULAR ops
// (upsert/append/delete) — never collapsed into a full-tab replace, so a
// burst of edits can't overwrite rows another device added meanwhile.
let _pullInFlight = false;
let _activePushCount = 0;
// Awaitable promise that resolves when the current pull finishes. The queue
// awaits this before dispatching so writes never operate on stale STATE.
let _pullPromise = Promise.resolve();
function setPullInFlight(promise) {
  _pullInFlight = true;
  _pullPromise = Promise.resolve(promise).finally(() => { _pullInFlight = false; refreshSyncIndicator(); });
}

const _writeQueue = new Map();    // tabName → array of pending modes
const _draining = new Map();      // tabName → promise of the active drain loop

// Single chokepoint for every write. Enqueues the op for its tab and starts a
// drain loop if one isn't already running. mode dispatches to the right
// primitive (see dispatchWrite). Returns the drain promise.
function autoSync(tabName, mode) {
  if (!_writeQueue.has(tabName)) _writeQueue.set(tabName, []);
  _writeQueue.get(tabName).push(mode);
  if (_draining.has(tabName)) return _draining.get(tabName);
  const p = drainTab(tabName);
  _draining.set(tabName, p);
  return p;
}

async function drainTab(tabName) {
  _activePushCount++;
  refreshSyncIndicator();
  try {
    // Never push against STATE that an in-flight pull is about to replace.
    if (_pullInFlight) { try { await _pullPromise; } catch (e) { /* handled elsewhere */ } }
    const q = _writeQueue.get(tabName);
    while (q && q.length) {
      const mode = q.shift();
      try {
        await runWrite(tabName, mode);
        clearDirty(tabName);
      } catch (e) {
        markDirty(tabName);
        // Stash the failed granular op so retryAllDirty can replay it (and
        // OCC-merge) rather than a stale full replace. Replace failures aren't
        // stashed — they re-derive from STATE on retry.
        if (mode.type !== "replace") {
          if (!_dirtyOps.has(tabName)) _dirtyOps.set(tabName, []);
          _dirtyOps.get(tabName).push(mode);
        }
        syncLog(`Auto-push ${tabName} failed: ${e.message || e}`, "var(--red)");
      }
    }
  } finally {
    _draining.delete(tabName);
    _activePushCount = Math.max(0, _activePushCount - 1);
    _lastSyncedAt = Date.now();
    refreshSyncIndicator();
  }
}

// Dispatch one write to the backend. Each carries STATE.rev[tab] as baseRev
// (added inside the API.* helpers; appendMany posts directly so it's added here).
//   { type: "append",     row  } → API.appendRow
//   { type: "appendMany", rows } → API.post appendMany
//   { type: "upsert",     row  } → API.upsertRow (id-based, cross-device safe)
//   { type: "delete",     id   } → API.deleteRowById
//   { type: "replace",    data } → API.pushTab (full overwrite, bulk only)
function dispatchWrite(tabName, mode) {
  if (!STATE.authToken) return Promise.reject(new Error("Not authenticated"));
  if (mode.type === "append")      return API.appendRow(tabName, mode.row);
  if (mode.type === "appendMany")  return API.post({ action: "appendMany", tab: tabName, rows: mode.rows, baseRev: STATE.rev[tabName] });
  if (mode.type === "upsert")      return API.upsertRow(tabName, mode.row);
  if (mode.type === "delete")      return API.deleteRowById(tabName, mode.id);
  if (mode.type === "replace")     return API.pushTab(tabName, mode.data);
  return Promise.reject(new Error(`Unknown autoSync mode: ${mode.type}`));
}

// Runs one write, handling the server's optimistic-concurrency response.
// The backend returns errors AND conflicts in the BODY (not as HTTP errors),
// so we must inspect the response here:
//   { conflict:true } → our baseRev was stale (someone else wrote) → resolve.
//   { error }         → real failure; throw so the tab is marked dirty.
//   { rev }           → success; advance our baseline for this tab.
async function runWrite(tabName, mode) {
  let res = await timed("write", `write ${tabName} (${mode.type})`, () => dispatchWrite(tabName, mode));
  if (res && res.conflict) res = await resolveConflict(tabName, mode);
  if (res && res.conflict) throw new Error("Still out of date after refresh — will retry");
  if (res && res.error) throw new Error(res.error);
  if (res && res.rev != null) { STATE.rev[tabName] = res.rev; saveLocal(); }
  return res;
}

// Recover from a stale-write rejection WITHOUT clobbering newer data.
//  • Granular (upsert/append/appendMany/delete): pull the tab fresh, re-apply
//    this edit on top of the latest rows, retry the push once (baseRev now
//    matches) → the user's change lands alongside everyone else's.
//  • replace (full re-push): never auto-clobber. Pull fresh and surface a
//    banner asking the user to redo their bulk change on the refreshed data.
async function resolveConflict(tabName, mode) {
  const arrKey = TAB_TO_STATE[tabName];
  if (mode.type === "replace") {
    try { await API.pullTabs([tabName]); } catch (e) { /* keep going */ }
    if (typeof render === "function") render();
    showSyncBanner(`"${tabName}" was changed on another device. Refreshed to the latest — please redo your bulk change, then Re-push.`);
    return { ok: true, refreshed: true };   // tab now matches server; not dirty
  }
  try { await API.pullTabs([tabName]); }
  catch (e) { return { conflict: true }; }            // couldn't refresh → bubble up
  if (arrKey && Array.isArray(STATE[arrKey])) reapplyMode(arrKey, mode);
  saveLocal();
  if (typeof render === "function") render();
  return dispatchWrite(tabName, mode);                 // retry once with fresh baseRev
}

// Re-apply a granular op to a freshly-pulled local array so the UI keeps the
// user's edit (the pull just replaced STATE[arrKey] with server rows).
function reapplyMode(arrKey, mode) {
  const arr = STATE[arrKey];
  if (!Array.isArray(arr)) return;
  if (mode.type === "upsert" && mode.row) {
    const i = arr.findIndex(r => String(r.id) === String(mode.row.id));
    if (i >= 0) arr[i] = mode.row; else arr.push(mode.row);
  } else if (mode.type === "delete") {
    const i = arr.findIndex(r => String(r.id) === String(mode.id));
    if (i >= 0) arr.splice(i, 1);
  } else if (mode.type === "append" && mode.row) {
    arr.push(mode.row);
  } else if (mode.type === "appendMany" && Array.isArray(mode.rows)) {
    arr.push(...mode.rows);
  }
}

// Retry every dirty tab via a full pushTab. Safe now: the server's OCC check
// rejects a stale replace (resolveConflict refreshes + warns) instead of
// clobbering. Used by the sidebar warning click and the launch dirty-restore.
async function retryAllDirty() {
  if (!STATE.dirty || STATE.dirty.size === 0) return;
  const tabs = [...STATE.dirty];
  for (const tab of tabs) {
    const ops = _dirtyOps.get(tab);
    if (ops && ops.length) {
      // Replay the exact failed granular ops — each OCC-merges on top of any
      // newer server rows, preserving both the user's edit and others'.
      _dirtyOps.delete(tab);
      for (const mode of ops) await autoSync(tab, mode);
    } else {
      // No stashed ops (e.g. after a reload) → full replace, OCC-guarded.
      const arrKey = TAB_TO_STATE[tab];
      if (arrKey && STATE[arrKey]) await autoSync(tab, { type: "replace", data: STATE[arrKey] });
    }
  }
}

// Pre-write heads-up for the manual "Re-push all" button. Rev-aware: compares
// our last-seen revision to the server's. Returns true to proceed, false to
// abort and pull first. (The server OCC is the real guard — even "push anyway"
// is rejected if stale — this just warns earlier.)
async function confirmStaleness(tabName) {
  try {
    const res = await API.revCheck();
    if (!res || res.error || !res.revs) return true;     // can't check → don't block
    const serverRev = res.revs[tabName];
    const localRev = STATE.rev[tabName];
    if (serverRev == null || localRev == null || Number(serverRev) === Number(localRev)) return true;
    return confirm(
      `"${tabName}" has changed on another device since you last synced.\n\n` +
      `Re-pushing now will overwrite those newer changes.\n\n` +
      `OK = push anyway.  Cancel = abort and pull first (recommended).`
    );
  } catch { return true; }
}

function signOut() {
  if (!confirm("Sign out from this device? You'll need a new invite link from your admin to access the sheet again.")) return;
  setAuthToken("");
  syncLog("Signed out — auth token cleared", "var(--orange)");
  setSyncIndicator("● Not authenticated", "var(--red)");
  render();
}

async function doPing() {
  try {
    syncLog("Pinging...");
    const res = await API.get("ping");
    if (res.ok) syncLog(`Connected! Tabs: ${res.sheets?.join(", ")}`, "var(--green)");
    else syncLog(`Error: ${res.error}`, "var(--red)");
  } catch (e) { syncLog(`Failed: ${e.message}`, "var(--red)"); }
}

async function doPull() {
  try {
    syncLog("Pulling all data...");
    document.getElementById("pull-btn").disabled = true;
    const pullPromise = timed("pull", "pull ALL (readAll)", () => API.pullAll(), true);
    setPullInFlight(pullPromise);
    const data = await pullPromise;
    syncLog(`Pull complete! Sheet: ${data.sheetName}`, "var(--green)");
    _lastSyncedAt = Date.now();
    refreshSyncIndicator();
    render();
  } catch (e) {
    syncLog(`Pull failed: ${e.message}`, "var(--red)");
    if (e.name === "AuthError") setSyncIndicator("● Not authenticated", "var(--red)");
  } finally { const b = document.getElementById("pull-btn"); if (b) b.disabled = false; }
}

async function doPushAll() {
  const tabs = [
    ["Roster", STATE.roster], ["Medical", STATE.medical], ["Attendance", STATE.attendance],
    ["IPPT", STATE.ippt], ["RouteMarch", STATE.rm], ["SOC", STATE.soc], ["PolarFlow", STATE.polar],
    ["ConductDetail", STATE.conductDetail],
    ["Appointments", STATE.appointments],
    ["Leave", STATE.leave],
    ["MSK", STATE.msk]
  ];
  document.getElementById("push-btn").disabled = true;
  for (const [name, data] of tabs) {
    if (data.length) {
      try { await pushTab(name, data); } catch (e) { syncLog(`${name} failed: ${e.message}`, "var(--red)"); }
    }
  }
  const b = document.getElementById("push-btn"); if (b) b.disabled = false;
}

async function pushTab(tabName, data) {
  // Per-tab manual "Re-push all" button. Bulk-replace operations check
  // staleness first — if another device added rows since we last pulled,
  // confirm before clobbering. Routes through autoSync so the indicator,
  // dirty-tracking, and serialization queue all stay consistent with the
  // automatic write path.
  const localCount = Array.isArray(data) ? data.length : 0;
  const proceed = await confirmStaleness(tabName);
  if (!proceed) {
    syncLog(`${tabName}: push cancelled — pull first to see latest rows`, "var(--orange)");
    return;
  }
  try {
    syncLog(`Pushing ${tabName} (${localCount} rows)...`);
    await autoSync(tabName, { type: "replace", data });
    syncLog(`${tabName}: re-push complete ✓`, "var(--green)");
  } catch (e) { syncLog(`${tabName}: ${e.message}`, "var(--red)"); }
}

// ── Auto-refresh: poll the cheap revCheck endpoint, pull only changed tabs ──
// Keeps every open tab fresh so a stale tab can't sit on hours-old data. The
// poll is a tiny payload (per-tab revisions only); we full-fetch nothing unless
// a tab's server revision is ahead of ours, then pull ONLY those tabs.
const AUTO_REFRESH_MS = 20000;        // ~20s while visible (user-chosen cadence)
const AUTO_REFRESH_MIN_GAP_MS = 8000; // debounce: ignore checks closer than this
let _autoRefreshTimer = null;
let _autoRefreshing = false;

function isModalOpen() {
  const o = document.getElementById("modal-overlay");
  return !!o && !o.classList.contains("hidden");
}

async function autoRefreshTick(reason) {
  if (!STATE.authToken) return;
  if (_autoRefreshing) return;
  // Never race a write or an in-flight pull.
  if (_pullInFlight || _activePushCount > 0) return;
  // Debounce focus+visibility+online firing together.
  if (_lastCheckedAt && (Date.now() - _lastCheckedAt) < AUTO_REFRESH_MIN_GAP_MS && reason !== "interval") return;
  _autoRefreshing = true;
  try {
    const res = await timed("revCheck", "revCheck", () => API.revCheck());
    if (!res || res.error || !res.revs) return;
    _lastCheckedAt = Date.now();
    refreshSyncIndicator();

    // Which sheet tabs have a server revision ahead of ours?
    const changed = Object.keys(res.revs).filter(sheet =>
      Number(res.revs[sheet]) > Number(STATE.rev[sheet] || 0)
    );
    if (changed.length === 0) return;

    const dirty = STATE.dirty || new Set();
    const dirtyChanged = changed.filter(t => dirty.has(t));
    const safeChanged = changed.filter(t => !dirty.has(t));

    // A tab with unsynced local edits that ALSO changed elsewhere — never pull
    // over it. Offer "Sync now" which pushes the edits; the server OCC-merges
    // them with the newer rows (no data lost on either side).
    if (dirtyChanged.length) {
      showDirtyConflictBanner(dirtyChanged);
      // Other changed tabs (no local edits) are still safe to refresh quietly,
      // as long as no form is open.
      if (safeChanged.length && !isModalOpen()) await applyAutoPull(safeChanged);
      return;
    }
    // No dirty collisions. If a form is open, don't re-render under it — banner.
    if (isModalOpen()) {
      if (safeChanged.length) showNewerDataBanner(safeChanged);
      return;
    }
    await applyAutoPull(safeChanged);
  } catch (e) {
    if (e.name === "AuthError") setSyncIndicator("● Not authenticated", "var(--red)");
  } finally {
    _autoRefreshing = false;
  }
}

// Pull the given sheet tabs, advance revs, re-render, flash a confirmation.
async function applyAutoPull(sheetNames) {
  if (!sheetNames || !sheetNames.length) return;
  const pullPromise = timed("pull", `pull ${sheetNames.join(",")}`, () => API.pullTabs(sheetNames), true);
  setPullInFlight(pullPromise);
  try { await pullPromise; } catch (e) { return; }
  _lastSyncedAt = Date.now();
  refreshSyncIndicator();
  if (typeof render === "function") render();
  flashUpdatedIndicator(sheetNames.length);
}

function flashUpdatedIndicator() {
  setSyncIndicator("● Updated just now", "var(--green)");
  setTimeout(() => refreshSyncIndicator(), 3000);
}

// ── Non-destructive "newer data available" banner ───────────
let _bannerPendingTabs = null;
function ensureBannerEl() {
  let el = document.getElementById("sync-banner");
  if (el) return el;
  el = document.createElement("div");
  el.id = "sync-banner";
  el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:9999;display:none;" +
    "align-items:center;gap:12px;background:var(--surface,#1c2128);color:var(--text,#e6edf3);" +
    "border:1px solid var(--accent,#58A6FF);border-radius:8px;padding:10px 14px;font-size:13px;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:92vw";
  document.body.appendChild(el);
  return el;
}

// Generic banner: message + optional action button + dismiss. Used for both
// "newer data — refresh" and the bulk-replace "redo your change" notice.
function showSyncBanner(message, actionLabel, onAction) {
  const el = ensureBannerEl();
  el.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent = message;
  el.appendChild(msg);
  if (actionLabel) {
    const act = document.createElement("button");
    act.className = "btn btn-primary";
    act.style.cssText = "font-size:12px;padding:4px 10px";
    act.textContent = actionLabel;
    act.onclick = () => { hideSyncBanner(); if (onAction) onAction(); };
    el.appendChild(act);
  }
  const x = document.createElement("button");
  x.className = "btn";
  x.style.cssText = "font-size:12px;padding:4px 8px";
  x.textContent = "✕";
  x.onclick = hideSyncBanner;
  el.appendChild(x);
  el.style.display = "flex";
}
function hideSyncBanner() {
  const el = document.getElementById("sync-banner");
  if (el) el.style.display = "none";
}

// "Newer data available — Refresh". Stashes the changed tabs so the manual
// Refresh click pulls exactly those (only once the modal is closed and the
// edits are no longer dirty for them).
function showNewerDataBanner(changedTabs) {
  _bannerPendingTabs = changedTabs.slice();
  showSyncBanner(`Newer data available (${changedTabs.join(", ")}).`, "Refresh", async () => {
    if (isModalOpen()) { showSyncBanner("Close the open form first, then Refresh.", "Refresh", () => showNewerDataBanner(_bannerPendingTabs || changedTabs)); return; }
    await applyAutoPull(_bannerPendingTabs || changedTabs);
    _bannerPendingTabs = null;
  });
}

// Banner for tabs with unsynced local edits that also changed elsewhere.
// "Sync now" pushes the local edits — the server OCC-merges with newer rows.
function showDirtyConflictBanner(tabs) {
  showSyncBanner(`Unsynced edits to ${tabs.join(", ")} also changed on another device.`, "Sync now", () => retryAllDirty());
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (document.visibilityState === "visible") {
    _autoRefreshTimer = setInterval(() => autoRefreshTick("interval"), AUTO_REFRESH_MS);
  }
}
function stopAutoRefresh() {
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
}

// Wire timer + events. Backgrounded tabs make ZERO calls (timer stopped on
// hide); returning to a tab fires an immediate check so a stale tab self-heals.
function initAutoRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { autoRefreshTick("visible"); startAutoRefresh(); }
    else stopAutoRefresh();
  });
  window.addEventListener("focus", () => autoRefreshTick("focus"));
  window.addEventListener("online", () => autoRefreshTick("online"));
  startAutoRefresh();
}

async function autoSyncOnLaunch() {
  if (!STATE.authToken) {
    setSyncIndicator("● Not authenticated", "var(--red)");
    return;
  }
  setSyncIndicator("● Syncing…", "var(--orange)");
  try {
    // INCREMENTAL launch sync: if we have a revision baseline from the cache,
    // do a cheap revCheck and pull ONLY changed tabs (in parallel) instead of a
    // full readAll — which was costing ~10s+. Falls back to a full pull when
    // there's no baseline (first run / old cache) or the backend lacks revCheck.
    const hasBaseline = STATE.rev && Object.keys(STATE.rev).length > 0;
    if (hasBaseline) {
      const res = await timed("revCheck", "revCheck (launch)", () => API.revCheck());
      _lastCheckedAt = Date.now();
      if (res && !res.error && res.revs) {
        const changed = Object.keys(res.revs).filter(s => Number(res.revs[s]) > Number(STATE.rev[s] || 0));
        if (changed.length) {
          await applyAutoPull(changed);   // parallel partial pulls + render + timing
          syncLog(`Launch: refreshed ${changed.length} changed tab${changed.length === 1 ? "" : "s"} (${changed.join(", ")})`, "var(--green)");
        } else {
          _lastSyncedAt = Date.now();
          refreshSyncIndicator();
          syncLog("Launch: already up to date ✓", "var(--green)");
        }
        return;
      }
      // else: revCheck unsupported/failed → fall through to a full pull.
    }
    const pullPromise = timed("pull", "pull ALL (launch)", () => API.pullAll(), true);
    setPullInFlight(pullPromise);
    const data = await pullPromise;
    _lastSyncedAt = Date.now();
    refreshSyncIndicator();
    syncLog(`Auto-sync on launch: full pull from ${data.sheetName}`, "var(--green)");
    render();
  } catch (e) {
    if (e.name === "AuthError") {
      setSyncIndicator("● Not authenticated", "var(--red)");
      syncLog(`Auth rejected — your invite may have been revoked. Ask admin for a new link.`, "var(--red)");
    } else {
      setSyncIndicator("● Sync failed", "var(--red)");
      syncLog(`Auto-sync failed: ${e.message}`, "var(--red)");
    }
  }
}
