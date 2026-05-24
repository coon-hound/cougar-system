// Global app state. Roster/medical/etc. start empty — real data comes from
// the Google Sheet via API.pullAll() on launch, or from localStorage on
// subsequent loads.

// The Apps Script web app URL. This is no longer a secret — auth is enforced
// server-side by per-device tokens issued via the invite flow (see Apps Script).
// PASTE YOUR DEPLOYMENT URL HERE after redeploying the updated Apps Script:
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyYcF-QXZrkGmiJ1SYgdxYAhDiYJsFUHQ5Sb1Bbm_8hwvxdn3nVlymOWd5Y13LEIhCx/exec"

// Storage key is versioned so we can invalidate stale caches in users' browsers.
const STORAGE_KEY = "cougar-data-v2";
const STORAGE_KEY_LEGACY = "cougar-data"; // v1 — contained hardcoded personnel fallback
const AUTH_KEY = "cougar-auth";
const FILTER_KEY = "cougar-filter";

const STATE = {
  nav: "dashboard",
  apiUrl: APPS_SCRIPT_URL,
  authToken: localStorage.getItem(AUTH_KEY) || "",
  roster: [], medical: [], attendance: [], ippt: [], rm: [], soc: [], polar: [], conductDetail: [], appointments: [], leave: [], msk: [],
  // Global view scope: "" = all. Persisted across reloads so leaving the app
  // mid-task and coming back doesn't blow away the section you were focused on.
  // filterRole adds a third dimension on top of platoon/section — toggles
  // between "All", "Commander", "Recruit" (lets the user see parade-state-style
  // strength without commanders polluting recruit-only views and vice versa).
  filterRole: "",
  filterPlt: "",
  filterSect: "",
  charts: {}
};

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
      status,
      startDate: r.startDate || "",
      endDate: r.endDate || ""
    };
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
    leave: STATE.leave, msk: STATE.msk
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
    STATE.leave = padD4OnLayer(d.leave);
    STATE.msk = normalizeMSK(d.msk);
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
