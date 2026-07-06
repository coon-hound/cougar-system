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
const PROGRAMS_KEY = "cougar-programs";
const LOCATIONS_KEY = "cougar-locations";
const COMBINED_KEY = "cougar-combined-groups";

// The implicit bucket for any in-camp recruit who hasn't been moved elsewhere
// today. Movement is day-scoped (locationSince === todayISO()); a recruit with
// no fresh location falls back to here, so everyone collapses to Main Body at
// the start of each day with no cron or midnight write.
const DEFAULT_LOCATION = "Main Body";

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

// Training-program config, persisted per-device. Shape:
//   [{ key: "PTP", name: "PTP", platoons: ["1","4"] }, ...]
// Maps platoons → parallel training programs (see helpers.js). Defaults reflect
// the current intake (PTP = Plt 1+4, BMT = Plt 2+3). Editable in the Conducts
// tab. Lives in its own localStorage key so a data-cache reset doesn't wipe it;
// the resolved program label is also stored on each conduct record, so the
// mapping only needs to be consistent at log time (defaults ensure that).
const DEFAULT_PROGRAMS = [
  { key: "PTP", name: "PTP", platoons: ["1", "4"] },
  { key: "BMT", name: "BMT", platoons: ["2", "3"] }
];
function loadPrograms() {
  try {
    const arr = JSON.parse(localStorage.getItem(PROGRAMS_KEY) || "null");
    if (!Array.isArray(arr)) return DEFAULT_PROGRAMS.map(p => ({ ...p, platoons: [...p.platoons] }));
    return arr
      .filter(p => p && p.key)
      .map(p => ({ key: String(p.key), name: String(p.name || p.key), platoons: (Array.isArray(p.platoons) ? p.platoons : []).map(String) }));
  } catch { return DEFAULT_PROGRAMS.map(p => ({ ...p, platoons: [...p.platoons] })); }
}
function savePrograms() {
  localStorage.setItem(PROGRAMS_KEY, JSON.stringify(STATE.programs || []));
}

// Combined groups: saved set-formulas over platoons / programs / groups / the
// whole company, e.g. "P4 − Guard Duty" = include {plt:4} minus exclude
// {grp:Guard Duty}. Membership is resolved LIVE from the current roster (see
// helpers.js combinedMemberSet), so they track group/platoon changes with no
// stored member list. Shape: [{ name, include:[token], exclude:[token] }] where
// a token is "company" | "plt:N" | "prog:KEY" | "grp:NAME". Per-device config
// like programs/locations (own localStorage key); the underlying groups it
// references are the shared, synced part.
function loadCombinedGroups() {
  try {
    const arr = JSON.parse(localStorage.getItem(COMBINED_KEY) || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(c => c && c.name)
      .map(c => ({
        name: String(c.name),
        include: (Array.isArray(c.include) ? c.include : []).map(String),
        exclude: (Array.isArray(c.exclude) ? c.exclude : []).map(String)
      }));
  } catch { return []; }
}
function saveCombinedGroups() {
  localStorage.setItem(COMBINED_KEY, JSON.stringify(STATE.combinedGroups || []));
}

// Managed list of in-camp location names for the Movement board, persisted
// per-device. A named managed list (rather than free text per move) stops a
// typo — "Cookhse" vs "Cookhouse" — from silently splitting one place into two
// buckets. DEFAULT_LOCATION is always present and first. Lives in its own
// localStorage key so a data-cache reset doesn't wipe it (same pattern as
// programs / custom statuses).
const DEFAULT_LOCATIONS = [DEFAULT_LOCATION, "Range", "Cookhouse", "Lecture Hall", "Bunk", "MO Office", "Guardroom"];
function loadLocations() {
  try {
    const arr = JSON.parse(localStorage.getItem(LOCATIONS_KEY) || "null");
    if (!Array.isArray(arr)) return [...DEFAULT_LOCATIONS];
    // Sanitize: strings only, trimmed, de-duped, DEFAULT_LOCATION pinned first.
    const clean = [];
    arr.map(l => String(l || "").trim()).forEach(l => {
      if (l && l !== DEFAULT_LOCATION && !clean.includes(l)) clean.push(l);
    });
    return [DEFAULT_LOCATION, ...clean];
  } catch { return [...DEFAULT_LOCATIONS]; }
}
function saveLocations() {
  localStorage.setItem(LOCATIONS_KEY, JSON.stringify(STATE.locations || []));
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
  // Training-program scope: "" = all programs. Filters conduct views by the
  // program stored on each record, and per-recruit views by the recruit's
  // platoon→program mapping. See helpers.js (programOf, recruitsInProgram).
  filterProgram: "",
  // Ad-hoc recruit-group scope: "" = all. Filters every per-recruit view to one
  // named group (e.g. "Guard Duty"). Membership lives on the Roster row (`groups`
  // column); the name list is derived from the roster. See helpers.js.
  filterGroup: "",
  // Editable platoon→program map (see loadPrograms). Drives the conduct
  // wizard's program scoping and the program badges/filters.
  programs: loadPrograms(),
  // Saved combined-group formulas (see loadCombinedGroups). Surfaced in the
  // group filter dropdown and the book-out picker alongside plain groups.
  combinedGroups: loadCombinedGroups(),
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
  // Managed in-camp location names for the Movement board (see loadLocations).
  // The destinations a recruit can be moved to; DEFAULT_LOCATION is always [0].
  locations: loadLocations(),
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
      leaveQuota: rest.leaveQuota !== undefined && rest.leaveQuota !== "" ? +rest.leaveQuota : "",
      // Out-of-camp ("booked out") persists per recruit. Sheets may return the
      // boolean as a real boolean or the text "TRUE"; coerce to a real boolean.
      // outReason / outSince (the local YYYY-MM-DD it was set) pass through ...rest.
      outOfCamp: rest.outOfCamp === true || String(rest.outOfCamp).toUpperCase() === "TRUE",
      // Manual "present" override (Book In on an otherwise-out recruit). Same
      // TRUE-text coercion; campInSince (the local YYYY-MM-DD) passes through ...rest.
      campIn: rest.campIn === true || String(rest.campIn).toUpperCase() === "TRUE",
      // Movement board: current in-camp location + the local YYYY-MM-DD it was
      // set. Day-scoped (only honored when locationSince === today). Defaulted
      // here so every row carries the keys — a full writeTab re-push derives
      // headers from Object.keys(data[0]) and would otherwise strip a column
      // absent from the first row.
      location: rest.location || "",
      locationSince: rest.locationSince || "",
      // Ad-hoc group membership: comma-delimited group names (e.g. "Guard,Range
      // Party"). Persistent (not day-scoped). Defaulted so the column survives a
      // full re-push, same reason as location above.
      groups: rest.groups != null ? String(rest.groups) : ""
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
      endDate: r.endDate || "",
      // COS-set flag: an MC/Warded the recruit consumes IN camp. Keeps them
      // counted in strength (excluded from outOfCampMap) and out of ATTC, while
      // still showing under MEDICAL STATUS as "<N>D MC (consume in camp)".
      // Sheets round-trips booleans as the text "TRUE"/"FALSE", so coerce here.
      inCamp: r.inCamp === true || r.inCamp === "TRUE" || r.inCamp === "true"
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

// Conduct records (Attendance, ConductDetail) gained a `program` field (PTP /
// BMT / Combined). Guarantee every row carries it — defaulting legacy/missing
// values to "Combined" — so writeTab (which derives headers from the first
// row's keys) never strips the column on a full "Re-push all".
function normalizeAttendance(records) {
  return (records || []).map(r => r ? { ...r, program: r.program || "Combined" } : r);
}
function normalizeConductDetail(records) {
  return padD4OnLayer(records).map(r => r ? { ...r, program: r.program || "Combined" } : r);
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
    STATE.attendance = normalizeAttendance(d.attendance);
    STATE.ippt = padD4OnLayer(d.ippt);
    STATE.rm = padD4OnLayer(d.rm);
    STATE.soc = padD4OnLayer(d.soc);
    STATE.polar = padD4OnLayer(d.polar);
    STATE.conductDetail = normalizeConductDetail(d.conductDetail);
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
    STATE.filterProgram = d.program || "";
    STATE.filterGroup = d.group || "";
  } catch { /* keep defaults */ }
}

function saveFilter() {
  localStorage.setItem(FILTER_KEY, JSON.stringify({ plt: STATE.filterPlt, sect: STATE.filterSect, role: STATE.filterRole, program: STATE.filterProgram, group: STATE.filterGroup }));
}
