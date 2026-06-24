// Global app state. Roster/medical/etc. start empty — real data comes from
// the Google Sheet via API.pullAll() on launch, or from localStorage on
// subsequent loads.

// The Apps Script web app URL. This is no longer a secret — auth is enforced
// server-side by per-device tokens issued via the invite flow (see Apps Script).
// PASTE YOUR DEPLOYMENT URL HERE after redeploying the updated Apps Script:
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzazMTu4y4XjjDXBGWN_aAE51fzP_z23zQUZnuKjWWPJ3fNNjUPbp3DbZW9T66OQysr/exec"

// Storage key is versioned so we can invalidate stale caches in users' browsers.
const STORAGE_KEY = "cougar-data-v2";
const STORAGE_KEY_LEGACY = "cougar-data"; // v1 — contained hardcoded personnel fallback
const AUTH_KEY = "cougar-auth";
const FILTER_KEY = "cougar-filter";
const IPPT_AGG_KEY = "cougar-ippt-agg";
const FITNESS_SENT_KEY = "cougar-fitness-sent";
const DIRTY_KEY = "cougar-dirty-tabs";
const CUSTOM_STATUS_KEY = "cougar-custom-statuses";

// Sheet-tab-name → STATE-array-key lookup. The autoSync coalesce path uses
// this when flushing a queued replace push: by the time the flush runs the
// caller's `data` snapshot is stale, so we re-read the latest STATE[arrayKey]
// from this map. Kept in state.js because it's tightly coupled to the STATE
// shape above.
const TAB_TO_STATE = {
  "Roster": "roster",
  "Medical": "medical",
  "Attendance": "attendance",
  "IPPT": "ippt",
  "RouteMarch": "rm",
  "SOC": "soc",
  "PolarFlow": "polar",
  "ConductDetail": "conductDetail",
  "Appointments": "appointments",
  "Leave": "leave",
  "MSK": "msk",
  "Conducts": "conducts"
};

// Persisted set of tab names with unpushed local changes. Survives reloads
// in its own localStorage key (separate from STORAGE_KEY) so a "Clear cache"
// of the data doesn't lose the dirty markers we need to know to retry.
function loadDirty() {
  try {
    const raw = localStorage.getItem(DIRTY_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveDirty() {
  localStorage.setItem(DIRTY_KEY, JSON.stringify([...(STATE.dirty || [])]));
}

// User-created medical statuses, persisted per-device. Shape:
//   [{ name: "Excuse Finger", participates: true }]
// `participates` = recruit normally still does the conduct despite this status
// (drives the wizard's "not participating" default). Custom statuses are
// always in-camp/restricted and never get +1/+2 ghost tags. Lives in its own
// localStorage key so a data-cache reset doesn't wipe the user's status list.
function loadCustomStatuses() {
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_STATUS_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter(s => s && s.name) : [];
  } catch { return []; }
}
function saveCustomStatuses() {
  localStorage.setItem(CUSTOM_STATUS_KEY, JSON.stringify(STATE.customStatuses || []));
}

// Reads the persisted "who got a fitness report and when" map.
// Shape: { "1101": "2026-05-27T14:40:25.296Z", ... }.
// Lives in localStorage so it doesn't get touched by saveLocal / pullAll,
// which means it survives `localStorage.removeItem(STORAGE_KEY)` resets.
function loadFitnessSent() {
  try {
    const raw = localStorage.getItem(FITNESS_SENT_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}
function saveFitnessSent(map) {
  localStorage.setItem(FITNESS_SENT_KEY, JSON.stringify(map || {}));
}
function markFitnessSent(d4, when) {
  if (!d4) return;
  STATE.fitnessSent[String(d4)] = when || new Date().toISOString();
  saveFitnessSent(STATE.fitnessSent);
}
function clearFitnessSent() {
  STATE.fitnessSent = {};
  saveFitnessSent(STATE.fitnessSent);
}
// Merge an external map (e.g. exported from another device) into the
// existing one. Keeps the most-recent timestamp per d4 when both sides have
// the same id, so you never accidentally "un-mark" a more-recent send by
// importing an older record.
function importFitnessSent(json) {
  let incoming;
  try { incoming = typeof json === "string" ? JSON.parse(json) : json; }
  catch (e) { return { ok: false, error: "Not valid JSON: " + e.message }; }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return { ok: false, error: "Expected an object like { \"1101\": \"2026-05-27T…\", ... }" };
  }
  let added = 0, updated = 0;
  for (const k of Object.keys(incoming)) {
    const key = padD4(k);
    const t = String(incoming[k] || "");
    if (!t) continue;
    if (!STATE.fitnessSent[key]) { STATE.fitnessSent[key] = t; added++; }
    else if (t > STATE.fitnessSent[key]) { STATE.fitnessSent[key] = t; updated++; }
  }
  saveFitnessSent(STATE.fitnessSent);
  return { ok: true, added, updated, total: Object.keys(STATE.fitnessSent).length };
}

const STATE = {
  nav: "dashboard",
  apiUrl: APPS_SCRIPT_URL,
  authToken: localStorage.getItem(AUTH_KEY) || "",
  roster: [], medical: [], attendance: [], ippt: [], rm: [], soc: [], polar: [], conductDetail: [], appointments: [], leave: [], msk: [],
  // Canonical conduct registry: [{id: "c001", name: "Orientation Run"}, ...].
  // Source of truth for the conduct dimension — records on attendance/polar/
  // conductDetail reference entries here via `conductId` instead of carrying
  // free-text conduct names. Empty array on first load triggers the migration
  // modal that promotes legacy string `conduct` fields to ids.
  conducts: [],
  // Global view scope: "" = all. Persisted across reloads so leaving the app
  // mid-task and coming back doesn't blow away the section you were focused on.
  // filterRole adds a third dimension on top of platoon/section — toggles
  // between "All", "Commander", "Recruit" (lets the user see parade-state-style
  // strength without commanders polluting recruit-only views and vice versa).
  filterRole: "",
  filterPlt: "",
  filterSect: "",
  // IPPT stats aggregation: "latest" (most recent attempt per recruit) or
  // "best" (highest-scoring attempt). Drives the IPPT tab's stats row, charts,
  // and leaderboard. Does NOT affect the underlying table — that always
  // shows every row.
  ipptAggMode: localStorage.getItem(IPPT_AGG_KEY) === "best" ? "best" : "latest",
  // Per-device record of which recruits have already had a fitness report
  // emailed to them. Drives the "skip already sent" default on bulk send so
  // a session interrupted mid-batch (or a fresh device) can resume without
  // double-sending. Map of d4 → ISO timestamp of last successful send.
  fitnessSent: loadFitnessSent(),
  // Set of sheet-tab names with unpushed local changes (push failed or
  // never attempted). Drives the sidebar "X tabs need retry" warning and
  // the on-launch dirty-restore prompt.
  dirty: loadDirty(),
  // User-created medical statuses (see loadCustomStatuses). Reusable in the
  // Report Sick form's status dropdown alongside the built-in vocabulary.
  customStatuses: loadCustomStatuses(),
  // Per-tab server revision last seen by this device, keyed by SHEET name
  // ("Roster", "Medical", …). Sent as `baseRev` on every write so the server
  // can reject a stale overwrite, and compared against the lightweight revCheck
  // poll to decide which tabs to auto-refresh. Persisted WITH the data (not a
  // separate key) so a reloaded stale tab pushes with the rev it actually last
  // saw — a desynced rev would defeat the staleness check.
  rev: {},
  charts: {}
};

function setIpptAggMode(mode) {
  STATE.ipptAggMode = mode === "best" ? "best" : "latest";
  localStorage.setItem(IPPT_AGG_KEY, STATE.ipptAggMode);
}

// Sheet column is "4d" (preserved verbatim by Apps Script readTab), but the
// rest of the codebase has always used r.id. Mirror the value into r.id at
// every entry point so callers don't have to think about it. Also strip
// legacy `conditions` field so it never round-trips back to the sheet.
// Canonicalize a 4D — strip any leading "C" (some sheets store recruit IDs
// as "C1101" rather than "1101"), then re-pad 1–3 digit numeric values to
// 4 digits so commander IDs like "0001" survive Google Sheets stripping
// the leading zeros. Output is always digit-only, never C-prefixed, so all
// layers join cleanly via `d4`.
function padD4(d4) {
  const s = String(d4 ?? "").trim().replace(/^C/i, "");
  if (/^\d{1,3}$/.test(s)) return s.padStart(4, "0");
  return s;
}

function normalizeRoster(roster) {
  return (roster || []).map(r => {
    const { conditions, ...rest } = r;
    const id = padD4(rest.id || rest["4d"] || rest["4D"] || "");
    // Auto-detect commander by id pattern (00xx) when the `role` column is
    // blank — this makes adding commanders straight from the Google Sheet
    // safe even if the user forgets to fill role="Commander". Explicit role
    // values from the sheet always win.
    const isCmdrById = /^00\d{2}$/.test(id);
    const role = rest.role || (isCmdrById ? "Commander" : "Recruit");
    return {
      ...rest,
      id,
      role,
      rank: rest.rank || "",
      leaveQuota: rest.leaveQuota !== undefined && rest.leaveQuota !== "" ? +rest.leaveQuota : ""
    };
  });
}

// Coerce every Medical record to the full current schema. Two reasons:
//   1) Drop legacy fields (type, conductMissed) so they don't round-trip.
//   2) Guarantee every row carries startDate/endDate keys — Apps Script's
//      writeTab generates sheet headers from Object.keys(data[0]) only, so
//      a stale first row missing the new keys would silently strip them
//      from the entire pushed sheet.
function normalizeMedical(records) {
  return (records || []).map(r => {
    // Auto-migrate any legacy "Excused X" entries to the canonical "Excuse X"
    // spelling so badge colors / parade-state filters match consistently.
    let status = r.status || "";
    if (/^Excused /.test(status)) status = status.replace(/^Excused /, "Excuse ");
    return {
      id: r.id,
      d4: padD4(r.d4 || ""),
      date: r.date || "",
      reason: r.reason || "",
      // Where the recruit reported sick — only meaningful for report-sick-
      // outside cases (external clinic/hospital). Blank for in-camp report sick.
      location: r.location || "",
      status,
      startDate: r.startDate || "",
      endDate: r.endDate || ""
    };
  });
}

// Leave records get d4 padding plus a one-way migration of the legacy bare
// "Leave" type to its current "Annual Leave" spelling, so old records keep
// their badge color / calendar legend mapping after the rename.
function normalizeLeave(records) {
  return (records || []).map(r => {
    if (!r) return r;
    const out = r.d4 != null ? { ...r, d4: padD4(r.d4) } : { ...r };
    if (out.type === "Leave") out.type = "Annual Leave";
    return out;
  });
}

// Generic d4-padding pass for layers that don't have their own normalizer.
// Applied at every read boundary (loadLocal, pullAll) so commander 4Ds
// stay 4 digits regardless of how Sheets mangles them on round-trip.
function padD4OnLayer(records) {
  return (records || []).map(r => r && r.d4 != null ? { ...r, d4: padD4(r.d4) } : r);
}

// MSK records arrive from a Google Form that writes verbose column headers
// ("4D (e.g. C1234)", "Injury Description", "List of Exercises Given …").
// Apps Script readTab uses those headers as object keys verbatim, so we
// translate to short, stable keys here. Also strips any leading "C" on
// the 4D (the form column prompts for "C1234"-style input) and pads to
// 4 digits in case Sheets stripped a leading zero.
function normalizeMSK(records) {
  const pick = (r, ...keys) => {
    for (const k of keys) {
      const v = r[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
  };
  return (records || []).map(r => {
    // Accepts every header variant the form may have used over time —
    // current ("4D (e.g. 1101)"), legacy ("4D (e.g. C1234)"), or just "4D".
    // The defensive `^C` strip handles any recruit who still types "C1101".
    const rawD4 = String(pick(r, "4D (e.g. 1101)", "4D (e.g. C1234)", "4D", "d4")).trim().replace(/^C/i, "");
    const clearedRaw = pick(r, "Cleared", "cleared");
    // manualRegions — comma-separated body region tags set by the dashboard
    // override UI. Overrides the auto-classifier for analytics. Persists
    // via pushTab so it round-trips to the MSK sheet on next Push All.
    const manualRegions = String(pick(r, "manualRegions", "ManualRegions", "Manual Regions") || "").trim();
    return {
      timestamp: pick(r, "Timestamp", "timestamp"),
      d4: padD4(rawD4),
      type: pick(r, "Type", "type"),
      description: pick(r, "Injury Description", "description", "Description"),
      physioDate: pick(r, "Date of Physio Visit", "physioDate", "PhysioDate"),
      exercises: pick(r, "List of Exercises Given (names of exercises)", "exercises", "Exercises"),
      cleared: clearedRaw === true || String(clearedRaw).toUpperCase() === "TRUE",
      manualRegions
    };
  });
}

function saveLocal() {
  const d = {
    roster: STATE.roster, medical: STATE.medical, attendance: STATE.attendance,
    ippt: STATE.ippt, rm: STATE.rm, soc: STATE.soc, polar: STATE.polar,
    conductDetail: STATE.conductDetail, appointments: STATE.appointments,
    leave: STATE.leave, msk: STATE.msk, conducts: STATE.conducts,
    rev: STATE.rev || {}
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
}

function loadLocal() {
  if (localStorage.getItem(STORAGE_KEY_LEGACY)) {
    localStorage.removeItem(STORAGE_KEY_LEGACY);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    STATE.roster = normalizeRoster(d.roster);
    STATE.medical = normalizeMedical(d.medical);
    STATE.attendance = d.attendance || [];
    STATE.ippt = padD4OnLayer(d.ippt);
    STATE.rm = padD4OnLayer(d.rm);
    STATE.soc = padD4OnLayer(d.soc);
    STATE.polar = padD4OnLayer(d.polar);
    STATE.conductDetail = padD4OnLayer(d.conductDetail);
    STATE.appointments = padD4OnLayer(d.appointments);
    STATE.leave = normalizeLeave(d.leave);
    STATE.msk = normalizeMSK(d.msk);
    STATE.conducts = Array.isArray(d.conducts) ? d.conducts : [];
    STATE.rev = (d.rev && typeof d.rev === "object") ? d.rev : {};
  } catch { /* fall through to empty state */ }
}

function setAuthToken(token) {
  STATE.authToken = token || "";
  if (token) localStorage.setItem(AUTH_KEY, token);
  else localStorage.removeItem(AUTH_KEY);
}

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    STATE.filterPlt = d.plt || "";
    STATE.filterSect = d.sect || "";
    STATE.filterRole = d.role || "";
  } catch { /* keep defaults */ }
}

function saveFilter() {
  localStorage.setItem(FILTER_KEY, JSON.stringify({ plt: STATE.filterPlt, sect: STATE.filterSect, role: STATE.filterRole }));
}
