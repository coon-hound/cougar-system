// Sync tab UI and all sheet-sync actions (pull / push / ping).
// Also owns the sidebar sync indicator and the launch-time auto-sync.

function renderSync(el) {
  const authed = !!STATE.authToken;
  // Three access states: revoked (server rejected our token - loudest),
  // authenticated, never authenticated.
  const authStatusHtml = (_authFailed && authed)
    ? `<div style="background:#F8514922;border:1px solid #F8514944;border-radius:6px;padding:10px;margin-bottom:12px;color:var(--red);font-size:12px;line-height:1.55">
         <strong>Access revoked or expired.</strong> The sheet rejected this device's sign-in.
         Ask your admin for a <strong>NEW invite link</strong> and open it on this phone.
         Your unsaved changes are kept on this device and will push automatically after you sign in again.
       </div>`
    : authed
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
        <button class="btn btn-danger" onclick="forceResync()" ${authed ? "" : "disabled"} title="Discard this device's unsynced changes and reload from the sheet. Use if stuck on 'unsaved'.">⟳ Force Resync</button>
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

// The always-visible topbar pill (#sync-status). kind ∈ ok | syncing | error.
// `onTap` makes it a tap-to-retry button (used for the unsaved/error state).
function updateSyncPill(kind, text, onTap) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.className = kind === "error" ? "s-error" : kind === "syncing" ? "s-syncing" : "s-ok";
  el.textContent = text;
  el.onclick = onTap || null;
  el.title = onTap ? "Tap to retry syncing" : "Sync status";
}

function setSyncIndicator(text, color) {
  // Mirror to the always-visible topbar pill so push status is obvious on mobile
  // (the sidebar indicator below is hidden behind ☰). Color encodes the state.
  const c = String(color || "");
  if (/red/.test(c)) updateSyncPill("error", /auth/i.test(text) ? "⚠ Sign in" : "⚠ Sync error", retryAllDirty);
  else if (/orange/.test(c)) updateSyncPill("syncing", "⟳ Saving…");
  else updateSyncPill("ok", "✓ Saved");

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
let _lastSyncError = null;   // last write failure message (for the pill/banner)
function refreshSyncIndicator() {
  const el = document.getElementById("sync-indicator");
  if (!el) return;
  if (_authFailed || !STATE.authToken) {
    // Sign-in state: the token was revoked/expired (or never issued). The pill
    // navigates to the Sync tab, whose red card explains how to recover.
    updateSyncPill("error", "⚠ Sign in again", goToSyncTab);
    el.textContent = "⚠ Sign in again - access revoked. Unsaved changes are kept.";
    el.style.color = "var(--red)";
    el.style.cursor = "pointer";
    el.style.textDecoration = "underline";
    el.title = "Access was revoked or expired. Ask your admin for a NEW invite link and open it on this phone. Unsaved changes stay on this device and push after you sign in.";
    el.onclick = goToSyncTab;
    return;
  }
  if (_pullInFlight || _activePushCount > 0) {
    setSyncIndicator("● Syncing…", "var(--orange)");
    return;
  }
  const dirtyCount = (STATE.dirty && STATE.dirty.size) || 0;
  if (dirtyCount > 0) {
    // Loud, tappable "not saved" state — both in the sidebar and the topbar pill.
    // With an auto-retry armed, show the countdown; tapping retries right now.
    if (_retryNextAt !== null) {
      const secs = Math.max(1, Math.ceil((_retryNextAt - Date.now()) / 1000));
      updateSyncPill("error", `⚠ ${dirtyCount} unsaved · retry in ${secs}s`, retryNow);
      el.textContent = `⚠ ${dirtyCount} tab${dirtyCount === 1 ? "" : "s"} unsaved · auto-retry in ${secs}s · Retry now`;
      el.onclick = retryNow;
    } else {
      updateSyncPill("error", `⚠ ${dirtyCount} unsaved · Retry`, retryAllDirty);
      el.textContent = `⚠ ${dirtyCount} tab${dirtyCount === 1 ? "" : "s"} need retry · Retry now`;
      el.onclick = retryAllDirty;
    }
    el.style.color = "var(--red)";
    el.style.cursor = "pointer";
    el.style.textDecoration = "underline";
    el.title = `Unsynced changes in: ${[...STATE.dirty].join(", ")}. Click to retry all.`;
    return;
  }
  const stamp = _lastSyncedAt ? new Date(_lastSyncedAt).toLocaleTimeString() : new Date().toLocaleTimeString();
  const checked = _lastCheckedAt ? ` · checked ${new Date(_lastCheckedAt).toLocaleTimeString()}` : "";
  setSyncIndicator(`● Synced ${stamp}${checked}`, "var(--green)");
}

// ── Sign-in state (auth token rejected server-side) ──────
// While set, nothing is dispatched or auto-retried: recovery is redeeming a
// NEW invite link (main.js calls authRestored() after a successful redeem).
let _authFailed = false;

function goToSyncTab() {
  STATE.nav = "sync";
  if (typeof render === "function") render();
}

// Flip into the sign-in state. Cancels the auto-retry (a retry can't outrun a
// revoked token) and repaints the pill as "Sign in again".
function noteAuthFailed() {
  _authFailed = true;
  cancelAutoRetry();
  refreshSyncIndicator();
}

// Called by main.js after a successful invite redemption: leave the sign-in
// state and immediately replay everything stashed while signed out.
function authRestored() {
  _authFailed = false;
  _lastSyncError = null;
  refreshSyncIndicator();
  if (STATE.dirty && STATE.dirty.size > 0) scheduleAutoRetry(true);
}

// ── Dirty-tab tracking ────────────────────────────────────
// _dirtyOps stashes the exact granular ops that FAILED to push, so a later
// retry can replay them (each OCC-merges via resolveConflict) instead of a
// stale full-tab replace that would force the user to redo their edit.
// Persisted to localStorage (DIRTY_OPS_KEY) so a reload keeps the granular
// replay instead of degrading to the replace fallback.
const _dirtyOps = loadDirtyOps();   // tabName → array of failed granular modes

function loadDirtyOps() {
  const map = new Map();
  try {
    const raw = localStorage.getItem(DIRTY_OPS_KEY);
    if (!raw) return map;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || !d.tabs || typeof d.tabs !== "object") return map;  // unknown version - discard
    for (const tab in d.tabs) {
      // Only restore stashes for tabs still marked dirty - a stale stash for a
      // clean tab would replay edits the server already accepted.
      if (!STATE.dirty || !STATE.dirty.has(tab)) continue;
      const modes = d.tabs[tab];
      if (Array.isArray(modes)) {
        const valid = modes.filter(m => m && typeof m.type === "string");
        if (valid.length) map.set(tab, valid);
      }
    }
  } catch { /* corrupt payload → start empty; dirty markers still drive the replace fallback */ }
  return map;
}

// Order-preserving coalesce of granular modes: a later upsert of a row id
// supersedes an earlier upsert of it, and a later delete of an id drops any
// earlier upsert of it. The net server effect is identical - the list is just
// shorter. Shared by the batch builder and the dirty-ops persistence.
function coalesceModes(modes) {
  const out = [];
  for (const m of modes) {
    if (m.type === "upsert" && m.row && m.row.id != null) {
      const i = out.findIndex(o => o.type === "upsert" && o.row && String(o.row.id) === String(m.row.id));
      if (i >= 0) out.splice(i, 1);
    } else if (m.type === "delete" && m.id != null) {
      const i = out.findIndex(o => o.type === "upsert" && o.row && String(o.row.id) === String(m.id));
      if (i >= 0) out.splice(i, 1);
    }
    out.push(m);
  }
  return out;
}

// Serialize the stash to localStorage. Degrades instead of failing: if the
// payload is huge (localStorage is ~5MB shared with the data cache) or setItem
// hits the quota, drop the largest tab's ops from the PERSISTED copy only -
// its dirty marker survives, so after a reload that tab still recovers via the
// OCC-guarded replace fallback in retryAllDirty.
const DIRTY_OPS_MAX_BYTES = 900 * 1024;
function persistDirtyOps() {
  const tabs = {};
  for (const [tab, modes] of _dirtyOps) {
    const c = coalesceModes(modes);
    _dirtyOps.set(tab, c);
    if (c.length) tabs[tab] = c;
  }
  const dropLargest = () => {
    const names = Object.keys(tabs);
    if (!names.length) return false;
    const biggest = names.sort((a, b) => JSON.stringify(tabs[b]).length - JSON.stringify(tabs[a]).length)[0];
    delete tabs[biggest];
    syncLog(`Unsaved edits to "${biggest}" are too large to keep across a reload - after one they retry as a full re-push instead.`, "var(--orange)");
    return true;
  };
  let json = JSON.stringify({ v: 1, tabs });
  while (json.length > DIRTY_OPS_MAX_BYTES && dropLargest()) json = JSON.stringify({ v: 1, tabs });
  for (;;) {
    try { localStorage.setItem(DIRTY_OPS_KEY, json); return; }
    catch (e) { if (!dropLargest()) return; json = JSON.stringify({ v: 1, tabs }); }
  }
}

// Stash a failed mode for later replay. applyOps batches split back into their
// original granular modes - the batch wrapper is a transport optimization, not
// state. "replace" modes are never stashed: they re-derive from STATE on retry.
function stashDirtyOps(tabName, mode) {
  if (!mode || mode.type === "replace") return;
  const modes = mode.type === "applyOps" ? (mode.modes || []) : [mode];
  if (!modes.length) return;
  if (!_dirtyOps.has(tabName)) _dirtyOps.set(tabName, []);
  _dirtyOps.get(tabName).push(...modes);
  persistDirtyOps();
}

function markDirty(tabName) {
  if (!tabName) return;
  STATE.dirty = STATE.dirty || new Set();
  STATE.dirty.add(tabName);
  saveDirty();
}
// The row id a granular mode targets (upsert/append row.id, delete id).
function modeRowId(m) {
  if (!m) return undefined;
  if ((m.type === "upsert" || m.type === "append") && m.row) return m.row.id;
  if (m.type === "delete") return m.id;
  return undefined;
}

// Clear the dirty state for the ops that JUST landed on the server, without
// touching ops still stashed or queued for the same tab. A success on one op
// must never erase a DIFFERENT op that is still waiting to retry — that would
// silently drop the user's edit (e.g. book out A fails + is stashed, then book
// out B succeeds; B's success must not wipe A). The tab only goes clean when it
// has nothing stashed AND nothing queued.
function clearSyncedOps(tabName, syncedModes) {
  const stash = _dirtyOps.get(tabName);
  if (stash && stash.length && syncedModes && syncedModes.length) {
    // Evict stashed ops that this dispatch supersedes: by object identity, AND
    // by row id — a landed write to row R makes a still-stashed (older, failed)
    // write to the SAME row R stale; replaying it would clobber the newer value
    // that just landed. Ops are serialized per tab (FIFO), so a stashed op for a
    // row is always older than a landing op for that same row.
    const syncedIds = new Set();
    syncedModes.forEach(m => { const id = modeRowId(m); if (id != null) syncedIds.add(String(id)); });
    const remaining = stash.filter(m => {
      if (syncedModes.includes(m)) return false;
      const id = modeRowId(m);
      return !(id != null && syncedIds.has(String(id)));
    });
    if (remaining.length !== stash.length) {
      if (remaining.length) _dirtyOps.set(tabName, remaining);
      else _dirtyOps.delete(tabName);
      persistDirtyOps();
    }
  }
  const stillStashed = (_dirtyOps.get(tabName) || []).length > 0;
  const q = _writeQueue.get(tabName);
  const stillQueued = !!(q && q.length);
  if (!stillStashed && !stillQueued && STATE.dirty && STATE.dirty.has(tabName)) {
    STATE.dirty.delete(tabName);
    saveDirty();
    if (STATE.dirty.size === 0) { _retryAttempt = 0; cancelAutoRetry(); }
  }
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
  // .catch: _pullPromise is only a gate. Callers handle their own await of the
  // original promise; a failed pull must not also surface as an unhandled
  // rejection through this gate copy.
  _pullPromise = Promise.resolve(promise).catch(() => {}).finally(() => { _pullInFlight = false; refreshSyncIndicator(); });
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
  // Yield one microtask so a synchronous fan-out (a forEach over 30 recruits
  // each calling autoSync) finishes enqueueing before the first dispatch -
  // the whole burst then leaves as ONE batched request instead of 30.
  await Promise.resolve();
  try {
    // Never push against STATE that an in-flight pull is about to replace.
    if (_pullInFlight) { try { await _pullPromise; } catch (e) { /* handled elsewhere */ } }
    const q = _writeQueue.get(tabName);
    while (q && q.length) {
      const mode = takeBatch(q);
      try {
        const res = await runWrite(tabName, mode);
        // Partial batch success: some ops in the batch failed server-side. Mark
        // dirty + stash exactly those (so a reload can't lose them and the clear
        // below won't wipe them); the background scheduler replays them. Only the
        // ops that DID land are cleared from the dirty state.
        if (mode.type === "applyOps" && res && res.ok && res.failed > 0 && Array.isArray(res.results)) {
          const failed = [], landed = [];
          mode.modes.forEach((m, i) => ((res.results[i] && res.results[i].error) ? failed : landed).push(m));
          if (failed.length) {
            markDirty(tabName);
            failed.forEach(m => stashDirtyOps(tabName, m));
            scheduleAutoRetry();
            syncLog(`${tabName}: ${failed.length} of ${mode.ops.length} batched change${failed.length === 1 ? "" : "s"} failed - will retry.`, "var(--orange)");
          }
          clearSyncedOps(tabName, landed);
        } else {
          clearSyncedOps(tabName, mode.type === "applyOps" ? (mode.modes || []) : [mode]);
        }
      } catch (e) {
        if (e && e.batchUnsupported) {
          // Deployed backend predates applyOps. Fall back to per-row dispatch
          // for the rest of the session: put the original granular modes back
          // at the queue front, in order, and re-loop.
          _batchUnsupported = true;
          q.unshift(...(mode.modes || []));
          syncLog("Backend doesn't support batched writes yet - sending row by row.", "var(--orange)");
          continue;
        }
        markDirty(tabName);
        _lastSyncError = (e && e.message) || String(e);   // surfaced in the pill/banner
        // Stash the failed granular op(s) so retryAllDirty can replay them (and
        // OCC-merge) rather than a stale full replace. Replace failures aren't
        // stashed — they re-derive from STATE on retry.
        stashDirtyOps(tabName, mode);
        if (e && e.name === "AuthError") {
          // Access revoked server-side. Stop the world: stash everything still
          // queued WITHOUT dispatching (one failed round trip total) and flip
          // the sign-in state - auto-retry no-ops until authRestored().
          while (q.length) stashDirtyOps(tabName, q.shift());
          noteAuthFailed();
          syncLog("Access revoked - sign in with a NEW invite link to resume syncing. Unsaved changes are kept on this device.", "var(--red)");
        } else {
          syncLog(`Auto-push ${tabName} failed: ${e.message || e}`, "var(--red)");
          scheduleAutoRetry();
        }
      }
    }
  } finally {
    _draining.delete(tabName);
    _activePushCount = Math.max(0, _activePushCount - 1);
    _lastSyncedAt = Date.now();
    refreshSyncIndicator();
  }
}

// How many granular ops to pack into one applyOps request. The backend caps a
// batch at 200; 50 keeps request bodies comfortably small on flaky mobile links.
const BATCH_MAX = 50;
// Set when the deployed backend answers an applyOps dispatch with its
// "Invalid request" fallback (backend too old). Session-scoped on purpose:
// a reload re-probes, so an upgraded backend is picked up automatically.
let _batchUnsupported = false;

// Pull the next dispatchable unit off the queue: either one mode verbatim
// (zero behavior change for singles) or an applyOps batch wrapping the maximal
// run of consecutive granular ops. "replace" and "appendMany" stop the run -
// they keep their own dispatch semantics. A failed op inside a batch is stashed
// and replayed by the background scheduler, so no per-op flag is needed here.
function takeBatch(q) {
  const granular = m => (m.type === "upsert" || m.type === "delete" || m.type === "append");
  if (_batchUnsupported || !granular(q[0])) return q.shift();
  const run = [];
  while (q.length && granular(q[0]) && run.length < BATCH_MAX) run.push(q.shift());
  if (run.length === 1) return run[0];
  const modes = coalesceModes(run);
  if (modes.length === 1) return modes[0];
  return {
    type: "applyOps",
    modes,
    ops: modes.map(m =>
      m.type === "upsert" ? { op: "upsert", row: m.row } :
      m.type === "delete" ? { op: "delete", id: m.id } :
                            { op: "append", row: m.row })
  };
}

// Dispatch one write to the backend. Each carries STATE.rev[tab] as baseRev
// (added inside the API.* helpers; appendMany posts directly so it's added here).
//   { type: "append",     row  } → API.appendRow
//   { type: "appendMany", rows } → API.post appendMany
//   { type: "upsert",     row  } → API.upsertRow (id-based, cross-device safe)
//   { type: "delete",     id   } → API.deleteRowById
//   { type: "applyOps",   ops  } → API.post applyOps (batched granular ops)
//   { type: "replace",    data } → API.pushTab (full overwrite, bulk only)
function dispatchWrite(tabName, mode) {
  if (!STATE.authToken) return Promise.reject(new Error("Not authenticated"));
  if (mode.type === "append")      return API.appendRow(tabName, mode.row);
  if (mode.type === "appendMany")  return API.post({ action: "appendMany", tab: tabName, rows: mode.rows, baseRev: STATE.rev[tabName] });
  if (mode.type === "upsert")      return API.upsertRow(tabName, mode.row);
  if (mode.type === "delete")      return API.deleteRowById(tabName, mode.id);
  if (mode.type === "applyOps")    return API.post({ action: "applyOps", tab: tabName, ops: mode.ops, baseRev: STATE.rev[tabName] });
  if (mode.type === "replace")     return API.pushTab(tabName, mode.data);
  return Promise.reject(new Error(`Unknown autoSync mode: ${mode.type}`));
}

// ── Backoff / retry policy helpers ───────────────────────
// Exponential backoff with +-25% jitter so a fleet of phones that all hit a
// busy server don't retry in lockstep and re-collide.
function backoffMs(attempt, base, cap) {
  return Math.min(base * Math.pow(2, attempt - 1), cap) * (0.75 + Math.random() * 0.5);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// A 503 means the server couldn't take its write lock within 15s - the write
// never happened, so retrying the SAME op in place is safe (no pull, no
// reapply). Four retries spans ~1+2+4+8s, comfortably past a lock hiccup.
const BUSY_MAX_INPLACE = 4;

// One dispatch with class-aware transport handling:
//   AuthError         → rethrow (the sign-in state owns recovery)
//   NetError, offline → rethrow (the `online` event owns recovery)
//   NetError, online  → ONE in-place retry (blip vs real outage), then rethrow
async function dispatchWithNetRetry(tabName, mode) {
  try {
    return await timed("write", `write ${tabName} (${mode.type})`, () => dispatchWrite(tabName, mode));
  } catch (e) {
    if (!e || e.name !== "NetError") throw e;
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw e;
    await sleep(backoffMs(1, 2000, 8000));
    return timed("write", `write ${tabName} (${mode.type}, net retry)`, () => dispatchWrite(tabName, mode));
  }
}

// Runs one write, handling the server's optimistic-concurrency response.
// The backend returns errors AND conflicts in the BODY (not as HTTP errors),
// so we must inspect the response here:
//   { code:503 }      → server lock busy; bounded in-place retry, then BusyError.
//   { conflict:true } → our baseRev was stale (someone else wrote) → resolve.
//   { error }         → real failure; throw so the tab is marked dirty.
//   { rev }           → success; advance our baseline for this tab.
async function runWrite(tabName, mode) {
  let res = await dispatchWithNetRetry(tabName, mode);
  let busyTries = 0;
  // The conflict loop is bounded (not a single retry) so a BUSY tab whose
  // revision keeps moving while we resolve still settles in-line instead of
  // bouncing to the dirty "needs retry" list. replace returns a non-conflict
  // result from resolveConflict, so it never loops.
  let conflictTries = 0;
  while (res) {
    if (res.code === 503) {
      if (busyTries >= BUSY_MAX_INPLACE) throw new BusyError(res.error);
      busyTries++;
      await sleep(backoffMs(busyTries, 1000, 8000));
      res = await dispatchWithNetRetry(tabName, mode);
    } else if (res.conflict) {
      if (conflictTries >= 6) throw new Error("Still out of date after refresh — will retry");
      conflictTries++;
      res = await resolveConflict(tabName, mode, res.serverRev);
    } else {
      break;
    }
  }
  // A deployed backend that predates applyOps answers it with its generic
  // dispatch fallback. Signal the drain loop to unpack the batch - never
  // retried as a batch.
  if (mode.type === "applyOps" && res && res.error === "Invalid request") {
    const e = new Error("Backend too old for batched writes");
    e.batchUnsupported = true;
    throw e;
  }
  if (res && res.error) throw new Error(res.error);
  if (res && res.rev != null) { STATE.rev[tabName] = res.rev; saveLocal(); }
  return res;
}

// Last bulk replace that lost an OCC conflict: { tab, data, at }. Kept so the
// conflict banner's "Push mine anyway" can re-push exactly what the user built.
let _lastConflictedReplace = null;

// Recover from a stale-write rejection WITHOUT clobbering newer data.
//  • Granular (upsert/append/appendMany/delete): pull the tab fresh, re-apply
//    this edit on top of the latest rows, retry the push once (baseRev now
//    matches) → the user's change lands alongside everyone else's.
//  • replace (full re-push): never auto-clobber. Pull fresh and surface a
//    banner offering to push the held bulk change over the refreshed data.
async function resolveConflict(tabName, mode, serverRev) {
  const arrKey = TAB_TO_STATE[tabName];
  if (mode.type === "replace") {
    // Hold on to what the user tried to push - the banner below offers to
    // re-push it over the refreshed server rows as an explicit choice.
    _lastConflictedReplace = { tab: tabName, data: mode.data, at: Date.now() };
    const pull = API.pullTabs([tabName]);
    setPullInFlight(pull);   // the 20s poll and the write queue must see this pull
    try { await pull; } catch (e) { /* keep going */ }
    if (serverRev != null) STATE.rev[tabName] = serverRev;
    if (typeof render === "function") render();
    const snap = _lastConflictedReplace;
    showSyncBanner(
      `"${tabName}" changed on another device - your bulk change was NOT saved. It is held on this device.`,
      "Push mine anyway",
      () => autoSync(snap.tab, { type: "replace", data: snap.data })
    );
    return { ok: true, refreshed: true };   // tab now matches server; not dirty
  }
  const pull = API.pullTabs([tabName]);
  setPullInFlight(pull);
  try { await pull; }
  catch (e) { return { conflict: true, serverRev }; }   // couldn't refresh → bubble up
  // Belt-and-suspenders: make baseRev reflect the server even if the partial
  // read didn't carry a rev, so the retry isn't guaranteed to re-conflict.
  if (serverRev != null && (STATE.rev[tabName] == null || Number(STATE.rev[tabName]) < Number(serverRev))) {
    STATE.rev[tabName] = serverRev;
  }
  if (arrKey && Array.isArray(STATE[arrKey])) reapplyMode(arrKey, mode);
  saveLocal();
  if (typeof render === "function") render();
  return dispatchWrite(tabName, mode);                 // retry with fresh baseRev
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
  } else if (mode.type === "applyOps" && Array.isArray(mode.modes)) {
    // Completeness only - applyOps is enforce=false server-side, so it can't
    // conflict. Each op re-applies as its granular equivalent.
    for (const m of mode.modes) reapplyMode(arrKey, m);
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
      // Enqueue the whole stash before the drain dispatches (autoSync returns
      // one shared drain promise) so the replay batches into applyOps too.
      _dirtyOps.delete(tab);
      persistDirtyOps();
      await Promise.all(ops.map(mode => autoSync(tab, mode)));
    } else {
      // No stashed ops (e.g. after a reload) → full replace, OCC-guarded.
      const arrKey = TAB_TO_STATE[tab];
      if (arrKey && STATE[arrKey]) await autoSync(tab, { type: "replace", data: STATE[arrKey] });
    }
  }
  // If a tab is STILL dirty after a full retry pass, the push is genuinely
  // failing (auth expired, offline, a row the server keeps rejecting). Don't pop
  // anything up — the topbar pill already shows the red "unsaved" state, and the
  // Sync tab has a "Force Resync" button. The last error is logged for diagnosis.
  if (STATE.dirty && STATE.dirty.size > 0 && _lastSyncError) {
    syncLog(`Still unsaved (${[...STATE.dirty].join(", ")}): ${_lastSyncError}`, "var(--red)");
  }
}

// ── Global background auto-retry ─────────────────────────
// Failed writes park in the dirty set; this scheduler replays them with
// jittered exponential backoff (5s → 5min cap) so a device that hit a
// transient failure heals itself without the user hunting for a retry button.
// Replays go through the same OCC-guarded paths as a manual retry - it NEVER
// force-resyncs. Dormant while signed out (_authFailed) or offline: those
// states are recovered by authRestored() and the `online` event respectively.
const RETRY_BASE_MS = 5000;
const RETRY_CAP_MS = 300000;
let _retryTimer = null;
let _retryAttempt = 0;
let _retryNextAt = null;        // epoch ms of the armed pass (drives the pill countdown)
let _retryCountdownTimer = null;

function scheduleAutoRetry(immediate) {
  if (_authFailed) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (_retryTimer !== null) {
    if (!immediate) return;                 // already armed - keep the earlier pass
    clearTimeout(_retryTimer);              // immediate: pull the pass forward
    _retryTimer = null;
  }
  const delay = immediate ? 1500 : backoffMs(++_retryAttempt, RETRY_BASE_MS, RETRY_CAP_MS);
  _retryNextAt = Date.now() + delay;
  _retryTimer = setTimeout(runAutoRetryPass, delay);
  startRetryCountdown();
  refreshSyncIndicator();
}

function cancelAutoRetry() {
  if (_retryTimer !== null) { clearTimeout(_retryTimer); _retryTimer = null; }
  _retryNextAt = null;
  stopRetryCountdown();
}

async function runAutoRetryPass() {
  cancelAutoRetry();   // this pass owns the retry now; failures re-arm below
  if (!STATE.dirty || STATE.dirty.size === 0) { _retryAttempt = 0; refreshSyncIndicator(); return; }
  if (_authFailed) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  // Never overlap a pull or an active push - step the backoff and try later.
  if (_pullInFlight || _activePushCount > 0) { scheduleAutoRetry(); return; }
  await retryAllDirty();
  if (STATE.dirty && STATE.dirty.size > 0) scheduleAutoRetry();
  else _retryAttempt = 0;
  refreshSyncIndicator();
}

// Pill tap while a retry is armed: don't wait out the countdown.
function retryNow() {
  cancelAutoRetry();
  runAutoRetryPass();
}

// 1s repaint of the "retry in Xs" countdown. Runs ONLY while a retry is
// armed, so an idle app burns zero timers.
function startRetryCountdown() {
  if (_retryCountdownTimer !== null) return;
  _retryCountdownTimer = setInterval(() => {
    if (_retryNextAt === null) { stopRetryCountdown(); return; }
    refreshSyncIndicator();
  }, 1000);
}
function stopRetryCountdown() {
  if (_retryCountdownTimer !== null) { clearInterval(_retryCountdownTimer); _retryCountdownTimer = null; }
}

// Escape hatch for a device stuck showing "unsaved" that a normal retry can't
// clear (expired invite, a poison local row, or stale cached code). Discards
// this device's unsynced local changes and reloads the authoritative sheet
// state, returning the device to a clean, synced baseline.
async function forceResync() {
  if (!confirm(
    "Discard any unsynced changes on THIS device and reload everything from the sheet?\n\n" +
    "Use this if the device is stuck on \"unsaved\". Local edits that never reached the sheet will be lost."
  )) return;
  STATE.dirty = new Set();
  _dirtyOps.clear();
  persistDirtyOps();
  cancelAutoRetry();
  _retryAttempt = 0;
  saveDirty();
  STATE.rev = {};                 // drop a possibly-stale baseline → full authoritative pull
  _lastSyncError = null;
  setSyncIndicator("● Syncing…", "var(--orange)");
  try {
    const p = timed("pull", "pull ALL (force resync)", () => API.pullAll(), true);
    setPullInFlight(p);
    await p;
    _lastSyncedAt = Date.now();
    refreshSyncIndicator();
    if (typeof render === "function") render();
    syncLog("Force resync complete — device is back in sync.", "var(--green)");
  } catch (e) {
    if (e.name === "AuthError") {
      noteAuthFailed();
      syncLog("Force resync failed: not authorized — this device needs a new invite link.", "var(--red)");
    } else {
      setSyncIndicator("● Sync failed", "var(--red)");
      syncLog("Force resync failed: " + (e.message || e), "var(--red)");
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
    if (e.name === "AuthError") noteAuthFailed();
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
    if (e.name === "AuthError") noteAuthFailed();
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
  window.addEventListener("online", () => {
    autoRefreshTick("online");
    // Back online is the recovery signal for writes parked by an offline
    // NetError - replay them right away instead of waiting out a backoff.
    if (STATE.dirty && STATE.dirty.size > 0) scheduleAutoRetry(true);
  });
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
        // NEVER pull over a tab that has unsynced local edits (dirty) - that
        // would drop the edit. Mirror autoRefreshTick: pull only the safely
        // changed tabs; surface dirty-and-changed tabs to the conflict banner and
        // let the OCC-guarded retry push+merge them (armed by maybeRestoreDirty).
        const dirty = STATE.dirty || new Set();
        const safeChanged = changed.filter(t => !dirty.has(t));
        const dirtyChanged = changed.filter(t => dirty.has(t));
        if (safeChanged.length) {
          await applyAutoPull(safeChanged);   // parallel partial pulls + render + timing
          syncLog(`Launch: refreshed ${safeChanged.length} changed tab${safeChanged.length === 1 ? "" : "s"} (${safeChanged.join(", ")})`, "var(--green)");
        }
        if (dirtyChanged.length) {
          showDirtyConflictBanner(dirtyChanged);
        } else if (!safeChanged.length) {
          _lastSyncedAt = Date.now();
          syncLog("Launch: already up to date ✓", "var(--green)");
        }
        refreshSyncIndicator();
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
      noteAuthFailed();
      syncLog(`Auth rejected — your invite may have been revoked. Ask admin for a new link.`, "var(--red)");
    } else {
      setSyncIndicator("● Sync failed", "var(--red)");
      syncLog(`Auto-sync failed: ${e.message}`, "var(--red)");
    }
  }
}
