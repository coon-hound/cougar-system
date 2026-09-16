// Pure utility functions — name lookups, ID generation, CSV column resolving,
// badge HTML, file exporters, form-field builders.

const getName = d4 => STATE.roster.find(r => r.id === d4)?.name || d4;

// ── Design tokens on canvas ──────────────────────────────
// Chart.js paints into a <canvas>, which only understands real colour strings —
// `var(--accent)` resolves to nothing there. cssColor() reads a custom property
// off :root so styles.css stays the single source of truth for the palette even
// for charts. Resolve once per chart build, never per data point: each lookup is
// a getComputedStyle call. Values are cached because the palette is static for
// the life of the page.
const _cssColorCache = new Map();
function cssColor(name, fallback) {
  if (_cssColorCache.has(name)) return _cssColorCache.get(name);
  let v = "";
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (e) { v = ""; }
  // Fall back to a visible colour, never to "" — an empty string reads as
  // transparent on canvas and the chart silently loses a series. An explicit
  // "" fallback is the one exception: it is how cssColorA asks "does this
  // token exist?" without being handed a stand-in.
  const out = v || (fallback === "" ? "" : (fallback || "#A69E98"));
  _cssColorCache.set(name, out);
  return out;
}

// The alpha washes charts use (fills under a line, soft grid, faint bar tints).
// styles.css publishes rgb triplets (--accentRGB etc.) exactly so these can be
// derived. Tokens without a triplet (--border, --muted) are decomposed here
// instead, because canvas cannot parse color-mix() and dropping the alpha would
// turn a faint gridline into a solid one.
function cssColorA(name, alpha, fallback) {
  const rgb = cssColor(name + "RGB", "");
  if (rgb) return `rgba(${rgb},${alpha})`;
  const solid = cssColor(name, fallback);
  const hex = /^#([0-9a-f]{6})$/i.exec(solid.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(solid.trim());
  if (m) return `rgba(${m[1].split(/[,\s\/]+/).slice(0, 3).join(",")},${alpha})`;
  return solid;
}

// ── Global platoon/section scope ─────────────────────────
// Filter applies to every per-recruit view (Roster, Medical, IPPT, RM, SOC,
// Polar, Dashboard counts). Attendance is per-conduct (no recruit linkage in
// the entry shape), so it stays company-wide.

// Plt/sect can come either as explicit roster fields OR be derived from the
// 4D code (e.g. "C1114" → plt=1, sect=1, bed=14). The sheet column may not
// always exist, so we fall back to parsing the 4D so the scope filter works
// regardless of sheet schema.
function getPlt(r) {
  // Commanders are coy-level — they have no platoon by default. Forcing
  // empty here ensures the 4D parser doesn't extract "0" from a 00xx id.
  if (r.role === "Commander") return r.plt != null && r.plt !== "" ? String(r.plt) : "";
  if (r.plt !== "" && r.plt != null) return String(r.plt);
  const m = String(r.id || "").match(/(\d)/);
  return m ? m[1] : "";
}
function getSect(r) {
  if (r.role === "Commander") return r.sect != null && r.sect !== "" ? String(r.sect) : "";
  if (r.sect !== "" && r.sect != null) return String(r.sect);
  const m = String(r.id || "").match(/\d(\d)/);
  return m ? m[1] : "";
}

// ── Conduct scope ────────────────────────────────────────────────
// A conduct is logged against a SCOPE: the whole company, one platoon, a named
// group, or a saved combined group. The resolved value is STORED on each
// conduct record (the `program` field, kept under that name so the sheet
// column, the dedup tuple and every archived row stay byte-identical).
//
// This replaced a PTP / BMT / Combined program dimension, which split the
// company into parallel training programs owning fixed platoons. Intake 16
// does not split that way, and the platoon map it depended on (1+4 / 2+3) died
// with the platoons themselves. Archived records still carry their old bare
// program key; those read as company-wide and keep their original label.
const SCOPE_COMPANY = "company";

// Single choke point for legacy rows: a conduct record written before scopes
// existed (no `program` field) reads as the whole company, as does one written
// against a program that no longer exists.
const scopeKey = x => (x && x.program) ? String(x.program) : SCOPE_COMPANY;

// ── Recruit groups (ad-hoc named subsets, e.g. "Guard Duty") ─────
// A group cuts ACROSS platoons and behaves like the platoon filter/scope.
// Membership is stored on the Roster row as a comma-delimited `groups` string
// (synced like `location`), so the whole company shares it; the set of group
// NAMES is DERIVED from the roster - a group exists exactly while it has ≥1
// member - so there's one source of truth, same as platoons. Commas
// are the delimiter, so group names must not contain commas (enforced on input).
function getGroups(r) {
  return String((r && r.groups) || "").split(",").map(s => s.trim()).filter(Boolean);
}
const recruitInGroup = (r, name) => getGroups(r).includes(name);
function allGroupNames() {
  const set = new Set();
  (STATE.roster || []).forEach(r => getGroups(r).forEach(g => set.add(g)));
  return [...set].sort((a, b) => a.localeCompare(b));
}
// Recruit members of a group (commanders excluded, matching strength/conduct/
// book-out convention).
function groupMembers(name) {
  return (STATE.roster || []).filter(r => r.role !== "Commander" && recruitInGroup(r, name));
}

// ── Combined groups (saved set-formulas) ─────────────────────────
// A scope token → the recruit d4s it selects (commanders always excluded).
// Tokens: "company" | "plt:N" | "grp:NAME". THE resolver shared by
// combined-group membership, the filter and the book-out scope, so a combined
// group means the same everywhere.
function scopeTokenMembers(token) {
  const recruits = (STATE.roster || []).filter(r => r.role !== "Commander");
  if (token === "company") return recruits.map(r => r.id);
  if (token.indexOf("plt:") === 0) { const p = token.slice(4); return recruits.filter(r => getPlt(r) === p).map(r => r.id); }
  if (token.indexOf("grp:") === 0) { const g = token.slice(4); return recruits.filter(r => recruitInGroup(r, g)).map(r => r.id); }
  return [];
}
// Human label for a token, e.g. "P4", "⦿ Guard Duty", "▣ Night Ex".
function scopeTokenLabel(token) {
  if (token === "company") return "Company";
  if (token.indexOf("plt:") === 0) return "P" + token.slice(4);
  if (token.indexOf("grp:") === 0) return "⦿ " + token.slice(4);
  if (token.indexOf("comb:") === 0) return "▣ " + token.slice(5);
  return token;
}
const combinedByName = name => (STATE.combinedGroups || []).find(c => c.name === name) || null;
const allCombinedNames = () => (STATE.combinedGroups || []).map(c => c.name).sort((a, b) => a.localeCompare(b));
// Resolve a def {include,exclude} to a Set of recruit d4s: union of includes,
// minus union of excludes. Used live for the builder preview and saved lookups.
function combinedMemberSetFromDef(def) {
  const set = new Set();
  if (!def) return set;
  (def.include || []).forEach(tok => scopeTokenMembers(tok).forEach(d4 => set.add(d4)));
  (def.exclude || []).forEach(tok => scopeTokenMembers(tok).forEach(d4 => set.delete(d4)));
  return set;
}
const combinedMemberSet = name => combinedMemberSetFromDef(combinedByName(name));
// A readable formula for a combined def, e.g. "P4 + P1 − ⦿ Guard Duty".
function combinedFormula(def) {
  const inc = (def.include || []).map(scopeTokenLabel).join(" + ");
  const exc = (def.exclude || []).map(scopeTokenLabel).join(" − ");
  return exc ? `${inc || "∅"} − ${exc}` : (inc || "∅");
}

// Resolve a scope value to the recruit d4s it selects (commanders excluded).
// Accepts the same values the book-out picker uses: "company" | "plt:N" |
// "grp:NAME" | "comb:NAME". Unlike bookOutTargets this is NOT
// camp-filtered — callers like bulk leave/out want everyone in the scope
// regardless of their current in/out-of-camp state. "person"/"" → [].
function scopeRecruits(scope) {
  const recruits = (STATE.roster || []).filter(r => r.role !== "Commander");
  if (!scope || scope === "person") return [];
  if (scope === "company") return recruits.map(r => r.id);
  if (scope.indexOf("plt:") === 0) { const p = scope.slice(4); return recruits.filter(r => getPlt(r) === p).map(r => r.id); }
  if (scope.indexOf("grp:") === 0) { const g = scope.slice(4); return recruits.filter(r => recruitInGroup(r, g)).map(r => r.id); }
  if (scope.indexOf("comb:") === 0) { const set = combinedMemberSet(scope.slice(5)); return recruits.filter(r => set.has(r.id)).map(r => r.id); }
  return [];
}

// ── Resolving a stored conduct scope ─────────────────────────────
// A conduct's stored scope is either a token ("plt:N"/"grp:NAME"/"comb:NAME")
// or the bare company scope. "prog:KEY" is never written here: the field also
// holds bare values, so a prefixed program key would alias one and split the
// dedup tuple against existing rows.
const isConductScopeToken = v => typeof v === "string" && /^(plt|grp|comb):/.test(v);
// Roster objects (commanders excluded) in a conduct's scope value. Anything
// that is not a token - the company scope, a blank, or an archived program key
// like "PTP" - resolves to every recruit.
function conductScopeRoster(v) {
  if (!isConductScopeToken(v)) return (STATE.roster || []).filter(r => r.role !== "Commander");
  const ids = new Set(scopeRecruits(v));
  return STATE.roster.filter(r => ids.has(r.id));
}
// Legacy program keys are shown verbatim rather than rewritten to "Company":
// the record really was logged against PTP or BMT, and an archive that relabels
// itself is worse than one that names something no longer in use.
const conductScopeLabel = v =>
  isConductScopeToken(v) ? scopeTokenLabel(v)
    : (!v || v === SCOPE_COMPANY) ? "Company"
    : String(v);
const conductScopeColor = v =>
  isConductScopeToken(v) ? "var(--purple)"
    : (!v || v === SCOPE_COMPANY) ? "var(--muted)"
    : "var(--dim)";

const isFilterActive = () => !!(STATE.filterPlt || STATE.filterSect || STATE.filterRole || STATE.filterGroup);

function filteredRoster() {
  if (!isFilterActive()) return STATE.roster;
  return STATE.roster.filter(r => {
    if (STATE.filterRole && r.role !== STATE.filterRole) return false;
    if (STATE.filterPlt && getPlt(r) !== String(STATE.filterPlt)) return false;
    if (STATE.filterSect && getSect(r) !== String(STATE.filterSect)) return false;
    if (STATE.filterGroup && !filterGroupHas(STATE.filterGroup, r)) return false;
    return true;
  });
}

// The group filter value is either a plain group name or "c:<combined name>".
// Resolves both to a membership test for one recruit.
function filterGroupHas(val, r) {
  if (val.indexOf("c:") === 0) return combinedMemberSet(val.slice(2)).has(r.id);
  return recruitInGroup(r, val);
}
// Display label for whichever group-scope value is active.
function filterGroupLabel(val) {
  return val.indexOf("c:") === 0 ? "▣ " + val.slice(2) : "⦿ " + val;
}

// Returns null when no filter is active so callers can skip the Set lookup
// on the hot render path entirely. Use with passesFilter(d4, visible).
function visibleD4Set() {
  if (!isFilterActive()) return null;
  return new Set(filteredRoster().map(r => r.id));
}

const passesFilter = (d4, visible) => !visible || visible.has(d4);

function filterLabel() {
  if (!isFilterActive()) return "";
  const parts = [];
  if (STATE.filterRole === "Commander") parts.push("Cmdrs");
  else if (STATE.filterRole === "Recruit") parts.push("Recs");
  if (STATE.filterPlt) parts.push("P" + STATE.filterPlt);
  if (STATE.filterSect) parts.push("S" + STATE.filterSect);
  if (STATE.filterGroup) parts.push(filterGroupLabel(STATE.filterGroup));
  return parts.join(" ");
}

// ── Commander-aware display helpers ───────────────────────
// 00xx IDs are administrative only — the user never wants to see them in
// the UI. These wrappers centralize the rule so tables can keep their
// existing structure while transparently swapping to name-based display
// for commander rows.
const isCommander = d4 => STATE.roster.find(r => r.id === d4)?.role === "Commander";

function displayId(d4) {
  const r = STATE.roster.find(x => x.id === d4);
  if (!r) return d4;
  return r.role === "Commander" ? "" : d4;
}

// getRank(d4) used to live here: it returned the raw column with no fallback,
// had zero call sites, and was a trap - the next person to want a rank would
// have found it by name and bypassed rosterRank(), whose REC fallback is the
// only thing that keeps a never-filled row from rendering blank. Rank is read
// through rosterRank() in js/forms.js, or off r.rank directly on a branch that
// has already established the person is a Commander.

// "3SG NICHOLAS ENG" for commanders, plain name for recruits.
function displayPersonLabel(d4) {
  const r = STATE.roster.find(x => x.id === d4);
  if (!r) return d4;
  if (r.role === "Commander") return [r.rank, r.name].filter(Boolean).join(" ");
  return r.name || d4;
}

// Off-in-lieu days used + quota + remaining for a commander. Returns null
// for recruits and unknown ids so callers can decide whether to render a
// balance card.
function commanderLeaveBalance(d4) {
  const r = STATE.roster.find(x => x.id === d4);
  if (!r || r.role !== "Commander") return null;
  const quota = +r.leaveQuota || 0;
  const used = STATE.leave
    .filter(l => l.d4 === d4 && l.type === "Off-in-Lieu")
    .reduce((s, l) => s + (+l.days || 0), 0);
  return { used, quota, remaining: quota - used };
}

// Row ids, unique across devices.
//
// The previous generator seeded a counter with Math.random()*9000+1000 once per
// SESSION and incremented it. Two phones opening the app the same morning had a
// 1-in-9000 chance of picking the same base — and then minted the same ids in
// lockstep from there. That is not theoretical: the live Sheet has 11 Medical
// and 5 Leave rows whose id belongs to a DIFFERENT person's record (id 1404 is
// both 4214's back pain and 1311's fever). Because the backend resolves an id
// to the FIRST matching row (findRowByIdIndex_), editing one of those records
// silently overwrites the other person's.
//
// Time prefix + per-session salt + monotonic counter, all base36:
//
//   WITHIN a session ids cannot collide at all — the counter is strictly
//   increasing, so it does not matter how many rows a bulk action mints inside
//   the same millisecond (leaveMany over a platoon, the conduct wizard writing
//   a detail row per recruit). A purely random suffix made that only PROBABLY
//   unique: 36^6 values per millisecond sounds like plenty, but 50,000 ids
//   collide roughly one run in thirty (test/helpers.test.js pins this), and the
//   failure mode is the catastrophic one above — one row silently overwriting
//   another person's.
//
//   ACROSS sessions the salt is what separates two devices, and unlike the old
//   4-digit seed it is ~2.2 billion wide, drawn once, and would additionally
//   have to coincide with the same millisecond and the same counter value.
//
// Returns a STRING because ids are text everywhere now (see normId,
// js/state.js) — and because a string cannot be silently coerced into a
// different row's id. The "-" also guarantees the id is never all-digits, so
// `+id` is NaN rather than a truthy number that fails === against the row.
const _idSalt = Math.random().toString(36).slice(2, 8);
let _idSeq = 0;
const nextId = () =>
  Date.now().toString(36) + "-" + _idSalt + "-" + (++_idSeq).toString(36);

// Smart CSV column resolver — case-insensitive, handles aliases
function col(row, ...names) {
  for (const n of names) {
    for (const key of Object.keys(row)) {
      if (key.trim().toLowerCase() === n.toLowerCase()) return row[key];
    }
  }
  return "";
}
function colNum(row, ...names) { return +(col(row, ...names)) || 0; }

// Validate CSV has required columns, return missing ones
function checkCols(headers, required) {
  const lower = headers.map(h => h.trim().toLowerCase());
  return required.filter(r => !lower.some(h => h === r.toLowerCase()));
}

// Award tiers: ≥90 Gold★ (NDU/Commando/Guards), ≥85 Gold, ≥75 Silver,
// ≥61 Pass, <61 Fail. The "Gold★" tier is the elite-units threshold.
// Delegates to ipptAward() in ippt-scoring.js so the tier list stays in
// one place.
const getAward = s => (typeof ipptAward === "function" ? ipptAward(s) : ((!s || s === 0) ? "N/A" : s >= 85 ? "Gold" : s >= 75 ? "Silver" : s >= 61 ? "Pass" : "Fail"));

// Canonical conducts registry, sorted by name. Source of truth for the
// conduct picker dropdowns across attendance / conductDetail / polar forms.
// Returns objects {id, name} — callers render the name but persist the id
// onto records, so a later rename in the Conducts admin tab updates every
// display site without rewriting any records.
function getAllConducts() {
  return [...(STATE.conducts || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// Normalized comparison key for conduct names. Collapses everything that
// makes two visually-identical strings compare unequal in vanilla JS:
//   - Unicode NFKC (so "ﬁ" and "fi" match)
//   - trim outer whitespace
//   - lowercase
//   - replace all whitespace runs (incl. NBSP  ) with one space
//   - normalize smart quotes / typographic apostrophes to ASCII
//   - strip zero-width chars (ZWSP / ZWNJ / ZWJ / BOM)
// Used both at lookup (conductIdByName) and at migration (variant grouping).
function normalizeConductKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[​‌‍﻿]/g, "");
}

// Resolve a conductId → display name. Returns the name when found. For
// missing ids — usually a stale frontend cache or an Apps Script that
// wasn't redeployed with the new Conducts tab — falls back to the raw id
// in brackets (e.g. "[c003?]") so the user can see SOMETHING is wrong
// without the UI silently going blank everywhere.
function conductName(id) {
  if (!id) return "";
  const hit = STATE.conducts.find(c => c.id === id);
  if (hit && hit.name) return hit.name;
  return `[${id}?]`;
}

// Resolve a free-text conduct name → conductId via normalized lookup.
// Returns "" if no entry matches. Used by CSV import, the photo-extract
// flow, and the legacy-data migration to convert names → ids.
function conductIdByName(name) {
  const key = normalizeConductKey(name);
  if (!key) return "";
  const hit = STATE.conducts.find(c => normalizeConductKey(c.name) === key);
  return hit ? hit.id : "";
}

// Next conduct id — "c" + the shared random-seeded counter (nextId). The old
// scheme was max-of-existing + 1, which COLLIDES across devices: two commanders
// each adding a conduct before syncing both compute the same max+1 and produce
// duplicate ids (e.g. three conducts all "c048"), which then mislabels every
// record keyed to that id. nextId() is seeded from a per-session random base, so
// concurrent creators land on different ids. New ids (c1000+) never clash with
// the legacy c001–c050 range. Guarded against any local collision just in case.
function nextConductId() {
  const taken = new Set((STATE.conducts || []).map(c => c.id));
  let id;
  do { id = "c" + nextId(); } while (taken.has(id));
  return id;
}

// Best-guess time for a conduct based on existing data. Returns the most
// frequently-logged time in conductDetail for matches of the given conductId.
// Empty string if no match — caller can fall back to a default like "0730".
function inferTimeForConduct(conductId) {
  if (!conductId) return "";
  const counts = {};
  const tally = (t) => { const k = pad4Time(t); if (k) counts[k] = (counts[k] || 0) + 1; };
  STATE.conductDetail.forEach(c => { if (c.conductId === conductId && c.time) tally(c.time); });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : "";
}

// Best-guess ISO date for a conduct. Looks at attendance first (the canonical
// "when did this conduct happen" log), falling back to conductDetail, and
// returns the most recent. Empty string when nothing's known (caller can fall
// back to today).
//
// This used to prefer the most recent date with NO polar coverage, on the
// assumption the user was about to import photos for the session that did not
// have any yet. With Polar gone there is nothing to prefer, so it is simply the
// latest known date.
function inferDateForConduct(conductId) {
  if (!conductId) return "";
  const candidateDates = [];
  STATE.attendance.forEach(a => {
    if (a.conductId !== conductId) return;
    const iso = displayDateToISO(a.date) || a.date;
    if (iso) candidateDates.push(iso);
  });
  STATE.conductDetail.forEach(c => {
    if (c.conductId !== conductId) return;
    const iso = displayDateToISO(c.date) || c.date;
    if (iso && !candidateDates.includes(iso)) candidateDates.push(iso);
  });
  if (!candidateDates.length) return "";
  candidateDates.sort();  // ascending ISO sort
  return candidateDates[candidateDates.length - 1];
}

// Generic delete: removes a row from STATE[arrayName] by id with a confirm
// prompt. Auto-syncs a surgical row delete to the Google Sheet via autoSync —
// no need for the user to navigate to the tab and click Re-push all.
const STATE_TO_TAB = {
  roster: "Roster", medical: "Medical", attendance: "Attendance",
  ippt: "IPPT",
  conductDetail: "ConductDetail", appointments: "Appointments",
  leave: "Leave", msk: "MSK", conducts: "Conducts"
};
function deleteEntry(arrayName, id, label) {
  if (!confirm(`Delete this ${label || "entry"}?`)) return;
  STATE[arrayName] = STATE[arrayName].filter(x => x.id !== id);
  saveLocal();
  render();
  const tabName = STATE_TO_TAB[arrayName];
  if (tabName && STATE.apiUrl && typeof autoSync === "function") {
    autoSync(tabName, { type: "delete", id });
  }
}

// ── Rank order + rank categories + parade blocks ─────────
// ONE ordered source of truth for rank, for the whole app. Two things read it:
// the parade state's OFFICER / WOSPEC / ENLISTEE strength split, and every
// list of people that should read senior-first (the Roster table and the
// person-picking dropdowns). Do NOT write a second rank list anywhere - the
// category arrays below are derived from this one so the vocabulary cannot
// drift. The one other rank list in the codebase is `PC_RANKS` in
// parade-compare.js, which is a loose regex for STRIPPING a rank prefix off a
// parsed name (it also carries CDT and matches case-insensitively), not an
// ordering; keep the two in step by hand when a rank is added here.
//
// Ordered highest to lowest, Singapore Army. Within the officer and the
// WOSPEC tiers the Military Expert (ME) ranks sit as one contiguous band
// rather than interleaved with the line ranks: an ME maps to a RANGE of line
// ranks, not to one, so interleaving would bake a guess into the order.
// Cougar is a BMT company and has never had an ME on strength, so the band
// keeps them sensibly ordered among themselves without inventing an
// equivalence we would have to defend.
const RANK_TIERS = [
  // OFFICER: general, field, then junior officers; ME4-ME8 as the ME band.
  ["OFFICER", ["BG", "COL", "SLTC", "LTC", "MAJ", "CPT", "LTA", "LTE", "2LT",
               "ME8", "ME7", "ME6", "ME5", "ME4"]],
  // WOSPEC: warrant officers, then the ME1-ME3 band, then the specialists.
  // SGT is a legacy token that predates the 3SG/2SG/1SG scheme; it sits with
  // the senior specialists.
  ["WOSPEC", ["CWO", "SWO", "MWO", "1WO", "2WO", "3WO",
              "ME3", "ME2", "ME1",
              "MSG", "SSG", "SGT", "1SG", "2SG", "3SG"]],
  // ENLISTEE: cadets first - OCT is a trainee, not yet commissioned, and is
  // counted with the enlistees on the parade state - then the men.
  ["ENLISTEE", ["OCT", "SCT", "CFC", "CPL", "LCP", "PFC", "PTE", "REC"]],
];

// Flat order (index 0 is the most senior) plus the two lookups built off it.
const RANK_ORDER = [];
const RANK_SENIORITY = new Map();      // token -> index, 0 = highest
const RANK_TIER_OF = new Map();        // token -> OFFICER / WOSPEC / ENLISTEE
for (const [tier, ranks] of RANK_TIERS) {
  for (const token of ranks) {
    RANK_SENIORITY.set(token, RANK_ORDER.length);
    RANK_TIER_OF.set(token, tier);
    RANK_ORDER.push(token);
  }
}
const RANK_OFFICER = RANK_ORDER.filter(t => RANK_TIER_OF.get(t) === "OFFICER");
const RANK_WOSPEC = RANK_ORDER.filter(t => RANK_TIER_OF.get(t) === "WOSPEC");
const RANK_ENLISTEE = RANK_ORDER.filter(t => RANK_TIER_OF.get(t) === "ENLISTEE");

// An unrecognised or blank rank is NOT an error: the roster column is free
// text and a row can arrive without one. It sorts one past the bottom of the
// list, i.e. below REC, which is where an unidentified body belongs on a
// senior-first list.
const RANK_UNKNOWN = RANK_ORDER.length;

// Accepts a roster record or a bare rank string. Never throws.
function rankToken(r) {
  const raw = typeof r === "string" ? r : (r && r.rank) || "";
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Seniority index: 0 is the highest rank, larger is more junior.
function rankIndex(r) {
  const i = RANK_SENIORITY.get(rankToken(r));
  return i === undefined ? RANK_UNKNOWN : i;
}

// The comparator every senior-first list uses.
//
// Rank orders the COMMAND BODY only. Enlistees are deliberately left in 4D
// order: the whole company holds one rank, so sorting them by it does nothing
// but destroy the ordering people actually navigate by - the 4D is a seat, and
// digit 1 is the platoon, digit 2 the section. A list that reads 7101, 7102,
// 7103 is a nominal roll; the same list "sorted by rank" is the same men in an
// order nobody can scan.
//
// Commanders always lead, whatever their rank string says, so a commander whose
// rank column is blank still sits above the men rather than falling past them
// to the bottom of the unknown bucket.
function byRank(tie) {
  const fallback = typeof tie === "function" ? tie : byD4ThenName;
  const isCmd = r => !!r && r.role === "Commander";
  return (a, b) => {
    const ca = isCmd(a), cb = isCmd(b);
    if (ca !== cb) return ca ? -1 : 1;
    // Enlistees: 4D order, never rank. The caller's tie-break is not consulted
    // either - it exists to break ties WITHIN a rank, and there is no rank
    // dimension here to tie on.
    if (!ca) return byD4ThenName(a, b);
    return (rankIndex(a) - rankIndex(b)) || fallback(a, b);
  };
}

// The default tie-break: 4D order, falling back to name for the roster rows
// that have no 4D.
function byD4ThenName(a, b) {
  const ida = String((a && a.id) || ""), idb = String((b && b.id) || "");
  if (ida !== idb) return ida < idb ? -1 : 1;
  return String((a && a.name) || "").localeCompare(String((b && b.name) || ""));
}

// Sort a list of roster records senior-first. Returns a NEW array - callers
// hand us STATE.roster itself and must never reorder it in place.
function sortByRank(list, tie) {
  return (Array.isArray(list) ? list.slice() : []).sort(byRank(tie));
}

// The battalion parade state splits every strength line into OFFICER /
// WOSPEC / ENLISTEE, and the three must add up to the block total (battalion
// rule 10), so every person has to land in exactly one bucket. Recruits are
// always enlistees. A commander whose rank string we don't recognise falls
// back to WOSPEC - a BMT company's command body is overwhelmingly
// specialists, and guessing ENLISTEE would quietly inflate the recruit line.
function rankCategory(r) {
  if (!r || r.role !== "Commander") return "ENLISTEE";
  return RANK_TIER_OF.get(rankToken(r)) || "WOSPEC";
}

// The parade-state block a person is filed under. Cougar files COY HQ first
// (the whole command body — our commanders hold no platoon 4D) then one block
// per platoon, labelled "PL 7" … "PL 9". A recruit with no resolvable platoon
// also lands in COY HQ rather than a phantom block, so the blocks always sum
// to the company strength.
const PARADE_COY_HQ = "COY HQ";
const paradePltLabel = plt => "PL " + plt;
function paradeBlockOf(r) {
  if (!r || r.role === "Commander") return PARADE_COY_HQ;
  const plt = getPlt(r);
  return plt ? paradePltLabel(plt) : PARADE_COY_HQ;
}

// Every block in filing order: COY HQ, then the platoons present in the
// roster, numerically ascending.
function paradeBlocks() {
  const plts = new Set();
  (STATE.roster || []).forEach(r => {
    if (r.role === "Commander") return;
    const p = getPlt(r);
    if (p) plts.add(p);
  });
  const sorted = [...plts].sort((a, b) => (+a || 0) - (+b || 0) || String(a).localeCompare(String(b)));
  return [PARADE_COY_HQ].concat(sorted.map(paradePltLabel));
}

// ── Medical status enum ──────────────────────────────────
// Every medical record represents a "report sick" event. `date` captures
// when the recruit reported sick. `status` is the outcome from the MO.
// Only these statuses are official:
//   • MC / Hospitalisation Leave / Warded — away from camp
//   • LD / Excuse X (incl. Excuse RMJ) — in camp, restricted
//   • Pending — reported sick, MO outcome not yet known
//   • NIL — MO seen, no status issued (recruit back to active)
//
// Hospitalisation Leave is an MO-issued leave following treatment. It behaves
// exactly like an MC for in/out of camp, strength and participation, but it is
// NOT an MC: the man cannot come into camp to endorse it, so it is kept as its
// own classification everywhere it is printed.
//
// SPELLING: the repo and the battalion template are British throughout, so
// "Hospitalisation" (s) is the one stored value. canonMedStatus() folds the
// American "Hospitalization" spelling onto it at every read boundary, so a row
// typed or imported the other way can never fall through the cracks.
const MED_HOSP_LEAVE = "Hospitalisation Leave";
function canonMedStatus(status) {
  const s = String(status == null ? "" : status).trim();
  return /^hospitali[sz]ation\s+leave$/i.test(s) ? MED_HOSP_LEAVE : s;
}

const MED_STATUS_GROUPS = [
  { label: "Severe (away from camp)", options: ["MC", MED_HOSP_LEAVE, "Warded"] },
  { label: "In camp, restricted",     options: ["LD"] },
  { label: "Excuses",                 options: ["Excuse Heavy Load", "Excuse Kneeling", "Excuse Squatting", "Excuse Uniform", "Excuse RMJ", "Excuse Swimming", "Excuse Prolonged Standing", "Excuse Upper Limb", "Excuse Lower Limb"] },
  { label: "Awaiting MO",             options: ["Pending"] },
  { label: "Cleared by MO",           options: ["NIL"] }
];
const MED_STATUSES = MED_STATUS_GROUPS.flatMap(g => g.options);

// The statuses that put the man PHYSICALLY away from camp. The single list the
// out-of-camp map, the parade strength, the borderline-returnee checklist and
// the MC-days counters all read, so adding an away status here can never leave
// one of them behind. Spelling-tolerant via canonMedStatus.
const MED_AWAY_STATUSES = ["MC", "Warded", MED_HOSP_LEAVE];
const isAwayMedStatus = s => MED_AWAY_STATUSES.indexOf(canonMedStatus(s)) >= 0;

// Display shorthand for statuses whose full name will not sit in a phone-width
// badge or a parade line. "HOSP LEAVE" is what the battalion writes, so the
// badge, the roster cell and the parade line all read off this one map.
// Away statuses a commander may legitimately have the man CONSUME IN CAMP (the
// "Consume in camp" / force-in flag). Hospitalisation Leave is deliberately NOT
// one of them: the man is on MO-ordered leave and cannot come in to endorse it,
// which is the whole distinction from an ordinary MC.
const MED_IN_CAMP_STATUSES = ["MC", "Warded"];

const MED_SHORT_LABELS = { [MED_HOSP_LEAVE]: "Hosp Leave" };
function medStatusShortLabel(tag) {
  const raw = String(tag == null ? "" : tag);
  const short = MED_SHORT_LABELS[medStatusBaseFamily(raw)];
  if (!short) return raw;
  // Keep any "+N" ghost suffix the caller passed in.
  const ghost = /\+\d+$/.exec(raw);
  return short + (ghost ? ghost[0] : "");
}

// ── Custom statuses ──────────────────────────────────────
// User-defined statuses live in STATE.customStatuses (persisted via state.js).
// They behave like an in-camp restricted status (e.g. an Excuse), never get
// +1/+2 ghost tags, and carry a `participates` flag.
function customStatusByName(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return (STATE.customStatuses || []).find(s => String(s.name).toLowerCase() === key) || null;
}
// Create or update a saved custom status. Idempotent on name (case-insensitive).
function addCustomStatus(name, participates) {
  name = String(name || "").trim();
  if (!name) return;
  const existing = customStatusByName(name);
  if (existing) { existing.participates = !!participates; }
  else { (STATE.customStatuses = STATE.customStatuses || []).push({ name, participates: !!participates }); }
  saveCustomStatuses();
}
// Does this status mean the recruit normally still participates in conducts?
// Built-in: only NIL (MO cleared, back to active). Custom: per its saved flag.
// Strips any +N ghost suffix first so "MC+1" resolves to "MC".
function statusParticipates(status) {
  const base = medStatusBaseFamily(status);
  if (base === "NIL") return true;
  const c = customStatusByName(base);
  return c ? !!c.participates : false;
}

// ── Same-status-family collapsing ────────────────────────
// A tag's base family ignores the ghost suffix: MC+1 → MC, LD+2 → LD. Used to
// collapse duplicate statuses of the same kind (a re-issued MC) down to one.
const medStatusBaseFamily = tag => canonMedStatus(String(tag).replace(/\+\d+$/, ""));

// Within one status family, is record-tag pair `a` more significant than `b`?
// More severe wins; ties broken by recency (later start date), so a newly
// issued MC supersedes an older overlapping one.
function medStatusMoreSignificant(a, b) {
  const ra = medSeverityRank(a.tag), rb = medSeverityRank(b.tag);
  if (ra !== rb) return ra > rb;
  const sa = displayDateToISO(a.record.startDate || a.record.date || "") || "";
  const sb = displayDateToISO(b.record.startDate || b.record.date || "") || "";
  return sa > sb;
}

// Collapse a recruit's active medical *records* to one per status family,
// keeping the most recent (latest start date). Shared by the parade-state and
// conduct-chat builders so a re-issued MC/LD prints only once (newest dates).
// The record picked here is only the HANDLE on the family — for dates, ask
// statusRun() for the merged span, never the record's own endDate.
function dedupeActiveRecordsByFamily(records) {
  const best = {};
  (records || []).forEach(m => {
    const k = medStatusBaseFamily(m.status);
    const rec = displayDateToISO(m.startDate || m.date || "") || "";
    const cur = best[k];
    const curRec = cur ? (displayDateToISO(cur.startDate || cur.date || "") || "") : "";
    if (!cur || rec > curRec) best[k] = m;
  });
  return Object.values(best);
}

// Days between two ISO date strings (both inclusive of the date — date math
// only, no time of day). Returns isoB − isoA in whole days.
function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  const a = new Date(isoA + "T00:00:00");
  const b = new Date(isoB + "T00:00:00");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// The day after an ISO date — "when are they back", given an inclusive end.
function nextDayISO(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return "";
  d.setDate(d.getDate() + 1);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Chained (back-to-back) status runs ───────────────────
// A status is RE-ISSUED, not edited, when it gets extended: an MC for 02–03 Jul
// that runs on is logged as a SECOND MC for 04–05 Jul (the two-record
// convention keeps the report-sick count honest — see findBorderlineReturnees).
// Read one record at a time, the recruit looks due back on the 4th when they
// are really out until the 6th, which is exactly how a parade state gets
// misread. A RUN is the maximal set of same-kind records for one person whose
// date ranges touch or overlap; merged, it is the true span to display.
//
// Nothing may render "how long is this person out" from a single record's
// endDate — go through statusRun (or medStatusRun / leaveRun) instead.

// Do two inclusive ISO ranges belong to one unbroken run? True when they
// overlap, or when the later one starts the very next day (a gapless re-issue).
// A genuine gap — back in camp in between — keeps them separate.
function rangesChain(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  const first = aStart <= bStart ? { e: aEnd } : { e: bEnd };
  const second = aStart <= bStart ? { s: bStart } : { s: aStart };
  const gap = daysBetween(first.e, second.s);
  return gap !== null && gap <= 1;
}

// The unbroken run that `record` belongs to within `pool` (already narrowed to
// one person + one kind of status). Grows outwards until nothing else touches
// it, so three back-to-back MCs merge into a single span.
// Returns { records (chronological), startIso, endIso, days, chained }.
function statusRun(record, pool) {
  const spanOf = r => ({
    r,
    s: displayDateToISO(r.startDate || r.date || "") || "",
    e: displayDateToISO(r.endDate || "") || ""
  });
  const self = spanOf(record);
  const single = { records: [record], startIso: self.s, endIso: self.e, days: null, chained: false };
  if (!self.s || !self.e) return single;

  // Exclude the record itself by id as well as identity: renderers pass spread
  // COPIES of a row, and a copy would otherwise "chain" with its own original
  // and mark every single-record absence as extended.
  const isSelf = r => r === record || (record.id != null && r.id === record.id);
  const rest = (pool || []).filter(r => !isSelf(r)).map(spanOf).filter(x => x.s && x.e);
  const run = [self];
  // Repeat until stable: a record that only touches a record we just absorbed
  // still belongs to the run (02–03, 04–05, 06–07 chain in any pool order).
  for (let grew = true; grew;) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (run.some(x => rangesChain(x.s, x.e, rest[i].s, rest[i].e))) {
        run.push(rest.splice(i, 1)[0]);
        grew = true;
      }
    }
  }
  run.sort((a, b) => a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
  const startIso = run[0].s;
  const endIso = run.reduce((max, x) => x.e > max ? x.e : max, run[0].e);
  return {
    records: run.map(x => x.r),
    startIso,
    endIso,
    days: daysBetween(startIso, endIso) + 1,
    chained: run.length > 1
  };
}

// The run a medical record belongs to. Pooled by person + status family +
// whether it is consumed in camp, so an away MC and an in-camp MC never merge
// into one "out of camp" span — they mean opposite things for strength.
function medStatusRun(record) {
  if (!record) return null;
  const fam = medStatusBaseFamily(record.status);
  return statusRun(record, (STATE.medical || []).filter(m =>
    m.d4 === record.d4 &&
    medStatusBaseFamily(m.status) === fam &&
    !!m.inCamp === !!record.inCamp
  ));
}

// The run a leave record belongs to — same person, same leave type, so
// back-to-back Off-in-Lieu blocks read as one absence.
function leaveRun(record) {
  if (!record) return null;
  return statusRun(record, (STATE.leave || []).filter(l =>
    l.d4 === record.d4 && (l.type || "") === (record.type || "")
  ));
}

// Is this medical record's status active on the given ISO date?
// Active = today ∈ [startDate, endDate] inclusive on both ends. Pending is
// treated as active only on its startDate (one-day visibility). NIL is
// never active — MO cleared the recruit, they're back to normal.
function medStatusActive(record, todayIso) {
  todayIso = todayIso || todayISO();
  if (record.status === "NIL") return false;
  const start = displayDateToISO(record.startDate || record.date || "");
  if (!start) return false;
  if (record.status === "Pending") return todayIso === start;
  const end = displayDateToISO(record.endDate || "");
  if (!end) return false;
  return todayIso >= start && todayIso <= end;
}

// ── In / out of camp (single source of truth) ────────────
// A recruit is OUT OF CAMP on a date if ANY of: an active MC/Warded medical
// record (physically away), an active leave covering the date, or a manual
// Book-Out set for that day. BOTH the dashboard strength board and the parade
// state read outOfCampMap() so their "in camp" numbers can never diverge.
//
// Manual book-outs AUTO-CLEAR daily by construction — they only count on the day
// they were set (outSince === dateIso). A book-out from a previous day is simply
// ignored (recruit counted in camp again); genuine multi-day absences are Leave.
function isBookedOut(r, dateIso) {
  if (!r) return false;
  const out = r.outOfCamp === true || String(r.outOfCamp).toUpperCase() === "TRUE";
  return out && r.outSince === (dateIso || todayISO());
}

// Manual "present" override: a commander tapped Book In on someone who is
// otherwise out (on MC/leave) to count them toward in-camp strength for the day.
// Day-scoped like book-out (campInSince === today) so it auto-clears tomorrow.
function isForcedIn(r, dateIso) {
  if (!r) return false;
  const on = r.campIn === true || String(r.campIn).toUpperCase() === "TRUE";
  return on && r.campInSince === (dateIso || todayISO());
}

// The last date a recruit stays out for the given reason, as ISO — the end of
// the merged run, so a re-issued MC or a second block of leave extends it. Used
// for the "out until / back on" that stops a parade state being misread.
function outUntilISO(records, runOf) {
  return (records || []).reduce((max, r) => {
    const run = runOf(r);
    const end = run ? run.endIso : "";
    return end > max ? end : max;
  }, "");
}

// Why a recruit is out of camp IGNORING any manual override — i.e. their
// recorded medical (away MC/Warded, not consumed in camp) or active leave.
// Returns { kind: "medical" | "leave", reason, until, back } or null (`until` is
// the last day out, `back` the day they return — both ISO, both spanning
// back-to-back re-issues). Shared by outOfCampMap, the roster badge and
// bookOutToggle so the three never drift on what "out" means.
function derivedCampOut(d4, dateIso) {
  dateIso = dateIso || todayISO();
  const awayMed = STATE.medical.filter(m => m.d4 === d4 && medStatusActive(m, dateIso) && isAwayMedStatus(m.status) && !m.inCamp);
  if (awayMed.length) {
    const mc = awayMed[0];
    return withReturn({ kind: "medical", reason: mc.status + (mc.reason ? " — " + mc.reason : "") }, outUntilISO(awayMed, medStatusRun));
  }
  const onLeave = STATE.leave.filter(l => {
    const s = displayDateToISO(l.startDate), e = displayDateToISO(l.endDate);
    return l.d4 === d4 && s && e && s <= dateIso && dateIso <= e;
  });
  if (onLeave.length) {
    const lv = onLeave[0];
    return withReturn({ kind: "leave", reason: [lv.type, lv.reason].filter(Boolean).join(" — ") || "Leave" }, outUntilISO(onLeave, leaveRun));
  }
  return null;
}

// Stamp the merged last-day-out + return date onto an out-of-camp entry.
function withReturn(info, untilIso) {
  info.until = untilIso || "";
  info.back = untilIso ? nextDayISO(untilIso) : "";
  return info;
}

// d4 → { kind: "medical" | "leave" | "bookedout", reason, until, back } for
// everyone out of camp on `dateIso`. Precedence: medical > leave > manual
// book-out. `until` / `back` span chained re-issues (see statusRun); a manual
// book-out is same-day only, so it has neither.
function outOfCampMap(dateIso) {
  dateIso = dateIso || todayISO();
  const map = new Map();
  // A manual "present" override wins over every out-reason for the day, so a
  // commander can count e.g. an in-camp-consuming MC recruit toward strength.
  const forcedIn = new Set((STATE.roster || []).filter(r => isForcedIn(r, dateIso)).map(r => r.id));
  // Group per recruit before setting the entry: a recruit can hold more than one
  // active away record (an MC plus a Warded), and the one they're out until is
  // the LATEST run end across all of them, not whichever comes first in the tab.
  const awayMed = {};
  STATE.medical.forEach(m => {
    // inCamp MC/Warded is consumed IN camp — counted present, so it never joins
    // the out-of-camp set (nor the dashboard "Out of Camp" tile / parade CURRENT).
    if (medStatusActive(m, dateIso) && isAwayMedStatus(m.status) && !m.inCamp && !forcedIn.has(m.d4)) {
      (awayMed[m.d4] = awayMed[m.d4] || []).push(m);
    }
  });
  Object.keys(awayMed).forEach(d4 => {
    const m = awayMed[d4][0];
    map.set(d4, withReturn({ kind: "medical", reason: m.status + (m.reason ? " — " + m.reason : "") }, outUntilISO(awayMed[d4], medStatusRun)));
  });
  const onLeave = {};
  STATE.leave.forEach(l => {
    const s = displayDateToISO(l.startDate), e = displayDateToISO(l.endDate);
    if (s && e && s <= dateIso && dateIso <= e && !forcedIn.has(l.d4) && !map.has(l.d4)) {
      (onLeave[l.d4] = onLeave[l.d4] || []).push(l);
    }
  });
  Object.keys(onLeave).forEach(d4 => {
    const l = onLeave[d4][0];
    map.set(d4, withReturn({ kind: "leave", reason: [l.type, l.reason].filter(Boolean).join(" — ") || "Leave" }, outUntilISO(onLeave[d4], leaveRun)));
  });
  (STATE.roster || []).forEach(r => {
    if (isBookedOut(r, dateIso) && !forcedIn.has(r.id) && !map.has(r.id)) {
      map.set(r.id, { kind: "bookedout", reason: r.outReason || "Out of camp" });
    }
  });
  return map;
}

// Returns { tag, ghostDay } for the record on the given date, or null if the
// record doesn't apply at all. ghostDay is 0 for active, 1 or 2 for the post-
// expiry tag period. Only MC and LD get ghost-tagged; everything else just
// expires cleanly.
function medStatusTag(record, todayIso) {
  todayIso = todayIso || todayISO();
  if (medStatusActive(record, todayIso)) {
    return { tag: record.status, ghostDay: 0 };
  }
  if (record.status !== "MC" && record.status !== "LD") return null;
  const end = displayDateToISO(record.endDate || "");
  if (!end) return null;
  const offset = daysBetween(end, todayIso);
  if (offset !== 1 && offset !== 2) return null;
  // Recovery only starts once the WHOLE run ends: a record that a re-issue
  // carries on from is neither active nor recovering, and letting every record
  // in a chain ghost-tag would print MC+1 once per record. Only the record
  // that closes the run carries the tag. Checked last — this walks the medical
  // layer, and it must not run for every record on every render.
  const run = medStatusRun(record);
  if (run && run.endIso > end) return null;
  return { tag: `${record.status}+${offset}`, ghostDay: offset };
}

// Severity rank used to pick the most-restrictive tag when a recruit has
// multiple records hitting the same day. Higher = more severe.
function medSeverityRank(tag) {
  // Hospitalisation Leave is as severe as an MC: same rank, so it sorts and
  // collapses alongside one rather than below every excuse.
  if (tag === "MC" || tag === "Warded" || tag === MED_HOSP_LEAVE) return 100;
  if (tag === "LD") return 80;
  if (tag === "RMJ") return 70;
  if (typeof tag === "string" && tag.startsWith("Excuse")) return 60;
  if (tag === "MC+1") return 50;
  if (tag === "MC+2") return 40;
  if (tag === "LD+1") return 30;
  if (tag === "LD+2") return 20;
  if (tag === "Pending") return 10;
  // Custom statuses rank just below the built-in excuses (in-camp/restricted).
  if (customStatusByName(medStatusBaseFamily(tag))) return 55;
  return 0;
}

// Walk the medical layer and return the most-severe effective tag per recruit
// for the given date. Output: array of { d4, record, tag, ghostDay }.
function currentMedicalEffective(todayIso) {
  todayIso = todayIso || todayISO();
  const byD4 = {};
  STATE.medical.forEach(m => {
    const t = medStatusTag(m, todayIso);
    if (!t) return;
    const cand = { d4: m.d4, record: m, tag: t.tag, ghostDay: t.ghostDay };
    const existing = byD4[m.d4];
    // Most severe wins; ties broken by recency so a re-issued MC supersedes
    // the older one.
    if (!existing || medStatusMoreSignificant(cand, existing)) byD4[m.d4] = cand;
  });
  return Object.values(byD4);
}

// Like currentMedicalEffective but keeps every DISTINCT active status per
// recruit (sorted severity-desc) so the UI can show stacked tags. A recruit on
// MC + Excuse Heavy Load shows up here with both. Duplicates of the SAME family
// (e.g. two overlapping MCs, or MC + MC+1) collapse to the most severe + most
// recent; the collapsed-out records move to `hidden` (still viewable in the
// person's Medical History). This is what stops the dashboard table and pie
// chart from double-counting a re-issued status.
// Output: array of { d4, statuses: [{record, tag, ghostDay}, ...], hidden: [...] }.
function currentMedicalEffectiveAll(todayIso) {
  todayIso = todayIso || todayISO();
  const byD4 = {};
  STATE.medical.forEach(m => {
    const t = medStatusTag(m, todayIso);
    if (!t) return;
    (byD4[m.d4] = byD4[m.d4] || { d4: m.d4, statuses: [], hidden: [] }).statuses.push({ record: m, tag: t.tag, ghostDay: t.ghostDay });
  });
  Object.values(byD4).forEach(b => {
    const best = {};
    const hidden = [];
    b.statuses.forEach(s => {
      const fam = medStatusBaseFamily(s.tag);
      const cur = best[fam];
      if (!cur) { best[fam] = s; }
      else if (medStatusMoreSignificant(s, cur)) { hidden.push(cur); best[fam] = s; }
      else { hidden.push(s); }
    });
    b.statuses = Object.values(best).sort((x, y) => medSeverityRank(y.tag) - medSeverityRank(x.tag));
    b.hidden = hidden;
  });
  return Object.values(byD4);
}

// Inline-styled badge HTML for a medical tag. Uses theme tokens but adds
// custom shades for MC+2 / LD+2 since the existing badge classes don't cover
// the gradient between severity tiers.
function medTagBadge(tag) {
  const palettes = {
    "MC":               { bg: "rgba(var(--redRGB),.13)",    bd: "rgba(var(--redRGB),.27)",    fg: "var(--red)" },
    "Warded":           { bg: "rgba(var(--redRGB),.13)",    bd: "rgba(var(--redRGB),.27)",    fg: "var(--red)" },
    [MED_HOSP_LEAVE]:   { bg: "rgba(var(--redRGB),.13)",    bd: "rgba(var(--redRGB),.27)",    fg: "var(--red)" },
    "MC+1":             { bg: "rgba(var(--orangeRGB),.2)",  bd: "rgba(var(--orangeRGB),.4)",  fg: "var(--orange)" },
    "MC+2":             { bg: "rgba(var(--yellowRGB),.13)", bd: "rgba(var(--yellowRGB),.27)", fg: "var(--yellow)" },
    "LD":               { bg: "rgba(var(--orangeRGB),.13)", bd: "rgba(var(--orangeRGB),.27)", fg: "var(--orange)" },
    "LD+1":             { bg: "rgba(var(--yellowRGB),.13)", bd: "rgba(var(--yellowRGB),.27)", fg: "var(--yellow)" },
    "LD+2":             { bg: "rgba(var(--yellowRGB),.07)", bd: "rgba(var(--yellowRGB),.2)",  fg: "color-mix(in srgb, var(--yellow) 55%, var(--dim))" },
    "RMJ":              { bg: "rgba(var(--accentRGB),.13)", bd: "rgba(var(--accentRGB),.27)", fg: "var(--accent)" },
    "Pending":          { bg: "color-mix(in srgb, var(--muted) 13%, transparent)", bd: "color-mix(in srgb, var(--muted) 27%, transparent)", fg: "var(--muted)" },
    "NIL":              { bg: "rgba(var(--greenRGB),.13)",  bd: "rgba(var(--greenRGB),.27)",  fg: "var(--green)" }
  };
  const p = palettes[tag] || (typeof tag === "string" && tag.startsWith("Excuse")
    ? { bg: "rgba(var(--purpleRGB),.13)", bd: "rgba(var(--purpleRGB),.27)", fg: "var(--purple)" }
    : customStatusByName(medStatusBaseFamily(tag))
    ? { bg: "rgba(var(--tealRGB),.13)", bd: "rgba(var(--tealRGB),.27)", fg: "var(--teal)" }
    : palettes.Pending);
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;background:${p.bg};color:${p.fg};border:1px solid ${p.bd}">${medStatusShortLabel(tag)}</span>`;
}

// Format a record's date range as "16 May – 20 May (5D)" for display.
// Pass `run` (from medStatusRun) wherever the label answers "how long is this
// person out" — it merges back-to-back re-issues, so an extended MC reads
// "16 May – 24 May (9D, extended)" instead of stopping at the first record's
// end. Omit it for a history list, where each record shows its own dates.
function medDurationLabel(record, run) {
  if (record.status === "Pending") return `${record.startDate || record.date || ""} · awaiting MO`;
  if (record.status === "NIL") return `${record.date || record.startDate || ""} · MO cleared, no status`;
  if (!record.startDate || !record.endDate) return record.startDate || "";
  const chained = !!(run && run.chained);
  const start = chained ? run.startIso : displayDateToISO(record.startDate);
  const end = chained ? run.endIso : displayDateToISO(record.endDate);
  const days = start && end ? daysBetween(start, end) + 1 : null;
  const startLabel = chained ? isoToDisplayDate(start) : record.startDate;
  const endLabel = chained ? isoToDisplayDate(end) : record.endDate;
  const note = [days ? `${days}D` : "", chained ? "extended" : ""].filter(Boolean).join(", ");
  return `${startLabel} – ${endLabel}${note ? ` (${note})` : ""}`;
}
const badge = (text, cls) => `<span class="badge badge-${cls}">${text}</span>`;
// Conduct scope pill — inline-styled (the colour varies by scope kind, so it
// can't use the static badge-<name> classes). Used in the conduct tables.
const conductScopeBadge = v => {
  const col = conductScopeColor(v);
  return `<span style="display:inline-block;font-size:10px;font-weight:700;line-height:1.4;color:${col};background:${col}1f;border:1px solid ${col}55;border-radius:10px;padding:2px 9px;white-space:nowrap">${conductScopeLabel(v)}</span>`;
};
const statusBadge = s => badge(s, s === "Active" ? "green" : s === "Warded" ? "red" : "orange");
const typeBadge = t => badge(t, t === "RSI" ? "orange" : t === "Injury" ? "red" : "yellow");
const awardBadge = s => { const a = getAward(s); const c = { "Gold★": "purple", Gold: "yellow", Silver: "accent", Pass: "green", Fail: "red", "N/A": "accent" }; return badge(a, c[a] || "accent"); };
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

// ─── IPPT: YTT detection + aggregation + stats ─────────────
// True when runTime is empty, zero, or a Sheets-formatted zero duration.
function isZeroRunTime(rt) {
  if (!rt) return true;
  const s = String(rt).trim();
  return s === "" || s === "0:00" || s === "00:00" || s === "0:00:00" || s === "00:00:00";
}

// True when the recruit registered no result — typically because they haven't
// taken IPPT yet. Distinct from "took it and scored 0", though in practice
// those are nearly identical for our purposes.
function isYTT(entry) {
  return (+entry.pushups || 0) === 0
      && (+entry.situps  || 0) === 0
      && isZeroRunTime(entry.runTime);
}

// Wraps awardBadge so the IPPT table can render "YTT" instead of "Fail"/"N/A"
// when the row is all zeros.
function ipptAwardBadge(entry) {
  if (isYTT(entry)) return badge("YTT", "accent");
  return awardBadge(entry.score);
}

function parseRunTimeToSeconds(rt) {
  if (!rt || isZeroRunTime(rt)) return 0;
  const parts = String(rt).split(":").map(n => +n || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];                   // mm:ss
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
  return 0;
}

function formatSeconds(s) {
  if (!s) return "—";
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Returns one IPPT entry per recruit, picked by mode:
//   "latest" → highest attempt number (ties broken by score)
//   "best"   → highest score (YTT counted as -1 so it loses ties)
function aggregateIPPT(entries, mode) {
  const byD4 = new Map();
  for (const e of entries) {
    const cur = byD4.get(e.d4);
    if (!cur) { byD4.set(e.d4, e); continue; }
    if (mode === "best") {
      const eScore = isYTT(e)   ? -1 : (+e.score   || 0);
      const cScore = isYTT(cur) ? -1 : (+cur.score || 0);
      if (eScore > cScore) byD4.set(e.d4, e);
    } else { // latest
      if ((+e.attempt || 0) > (+cur.attempt || 0)) byD4.set(e.d4, e);
    }
  }
  return [...byD4.values()];
}

// Tallies aggregated entries by award tier. Returns ready-to-render counts
// plus avg score (excluding YTT) and avg run seconds (excluding YTT).
function computeIPPTStats(entries) {
  const stats = { total: entries.length, ytt: 0, fail: 0, pass: 0, silver: 0, gold: 0, goldStar: 0, scoreSum: 0, scoreN: 0, runSecSum: 0, runSecN: 0 };
  for (const e of entries) {
    if (isYTT(e)) { stats.ytt++; continue; }
    const a = getAward(+e.score || 0);
    if (a === "Gold★") stats.goldStar++;
    else if (a === "Gold") stats.gold++;
    else if (a === "Silver") stats.silver++;
    else if (a === "Pass") stats.pass++;
    else stats.fail++;
    stats.scoreSum += (+e.score || 0); stats.scoreN++;
    const sec = parseRunTimeToSeconds(e.runTime);
    if (sec > 0) { stats.runSecSum += sec; stats.runSecN++; }
  }
  stats.taken    = stats.total - stats.ytt;
  stats.passed   = stats.pass + stats.silver + stats.gold + stats.goldStar;
  stats.avgScore = stats.scoreN  ? Math.round(stats.scoreSum  / stats.scoreN ) : 0;
  stats.avgRunSec = stats.runSecN ? Math.round(stats.runSecSum / stats.runSecN) : 0;
  return stats;
}

// ─── IPPT: multi-attempt score series (IPPT 1..N) ─────────────
// One row per recruit holding every VALID score they posted, keyed by attempt
// number: { d4, byAttempt: { 1: 68, 2: 74, 3: 81 } }. Valid = non-YTT with a
// real run time (the same rule the trend chart uses). Every cross-attempt
// visualization reads this so they all agree on who counts.
function ipptSeriesByRecruit(entries) {
  const byD4 = new Map();
  for (const e of entries) {
    const n = +e.attempt;
    if (!(n > 0) || isYTT(e) || parseRunTimeToSeconds(e.runTime) <= 0) continue;
    if (!byD4.has(e.d4)) byD4.set(e.d4, { d4: e.d4, byAttempt: {} });
    byD4.get(e.d4).byAttempt[n] = +e.score || 0;
  }
  return [...byD4.values()];
}

// Paired cohort for any two attempts a → b: recruits with a valid score in
// BOTH. Returns [{d4, s1, s2, delta}] with s1 = score at a, s2 = score at b.
function ipptPairedCohort(series, a, b) {
  return series
    .filter(r => r.byAttempt[a] != null && r.byAttempt[b] != null)
    .map(r => ({ d4: r.d4, s1: r.byAttempt[a], s2: r.byAttempt[b], delta: r.byAttempt[b] - r.byAttempt[a] }));
}

// Net direction of a recruit's whole journey: latest taken attempt vs their
// first. Drives the progression chart's line colour. Returns 0 for a recruit
// with fewer than two valid attempts.
function ipptNetDelta(row) {
  const ns = Object.keys(row.byAttempt).map(Number).sort((a, b) => a - b);
  if (ns.length < 2) return 0;
  return row.byAttempt[ns[ns.length - 1]] - row.byAttempt[ns[0]];
}

// BMI = kg / m². Height is stored in cm in the roster sheet.
// Categories follow the standard WHO bands. Returns null when either field
// is missing so callers can render an em-dash instead of NaN.
function calcBMI(r) {
  const h = +r.height, w = +r.weight;
  if (!h || !w) return null;
  return +(w / Math.pow(h / 100, 2)).toFixed(1);
}
function bmiColor(bmi) {
  if (bmi == null) return 'var(--muted)';
  if (bmi < 18.5) return 'var(--accent)';      // underweight
  if (bmi < 25)   return 'var(--green)';        // normal
  if (bmi < 30)   return 'var(--orange)';       // overweight
  return 'var(--red)';                          // obese
}

function exportCSV(data, filename) {
  const csv = Papa.unparse(data);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function exportJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// `roleFilter` is optional — pass "Commander" or "Recruit" to restrict the
// dropdown (e.g. the Leave form picks commanders only). Commander options
// render as "rank name" without the administrative 00xx prefix.
// `opts.onchange` lets callers wire an inline change handler — useful when
// the picker is one row in a list-style form (e.g. the Log Conduct wizard).
// Options are ordered senior-first (sortByRank), 4D order inside a rank, so
// every person picker in the app reads the same way round.
function rosterSelect(id = "form-d4", required = true, selected = "", roleFilter = "", opts = {}) {
  // Back-compat: some old callers pass {onchange: ...} as the fourth arg.
  if (roleFilter && typeof roleFilter === "object") { opts = roleFilter; roleFilter = ""; }
  const rows = sortByRank(roleFilter ? STATE.roster.filter(r => r.role === roleFilter) : STATE.roster);
  const optLabel = r => r.role === "Commander"
    ? [r.rank, r.name].filter(Boolean).join(" ")
    : `${r.id} ${r.name}`;
  const onchangeAttr = opts.onchange ? ` onchange="${escapeAttr(opts.onchange)}"` : "";
  return `<select id="${id}" ${required ? "required" : ""}${onchangeAttr} style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px;box-sizing:border-box"><option value="">Select...</option>${rows.map(r => `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${optLabel(r)}</option>`).join("")}</select>`;
}
function formField(id, label, type = "text", placeholder = "", extra = "") {
  const ph = placeholder ? ` placeholder="${placeholder}"` : "";
  return `<div class="form-group"><label>${label}</label><input id="${id}" type="${type}"${ph} ${extra}></div>`;
}
function formSelect(id, label, options, required = false, selected = "") {
  return `<div class="form-group"><label>${label}</label><select id="${id}" ${required ? "required" : ""}>${options.map(o => {
    const val = typeof o === "string" ? o : o[0];
    const lab = typeof o === "string" ? o : o[1];
    return `<option value="${val}" ${String(val) === String(selected) ? "selected" : ""}>${lab}</option>`;
  }).join("")}</select></div>`;
}
const gv = id => document.getElementById(id)?.value || "";

// Escape user-supplied text for safe interpolation into HTML attribute values.
const escapeAttr = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Local-time today as YYYY-MM-DD (avoids toISOString's UTC shift).
function todayISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "2026-05-17" → "17 May 2026" — matches what Apps Script formats sheet dates as.
function isoToDisplayDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Compact date for tight cells: "6 Sep" this year, "6 Sep 2027" beyond it —
// enough to be unambiguous without the year eating a phone column's width.
function isoToShortDate(iso) {
  const full = isoToDisplayDate(iso);
  const year = String(iso || "").slice(0, 4);
  return year === String(new Date().getFullYear()) ? full.replace(/\s+\d{4}$/, "") : full;
}

// "17 May 2026" or "17 May" → "2026-05-17" — for pre-filling <input type=date>.
// If year is missing, falls back to current year (matches the old free-text shape).
function displayDateToISO(s) {
  if (!s) return "";
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const m = String(s).match(/^(\d{1,2})\s+(\w{3})(?:\s+(\d{4}))?/);
  if (!m) return "";
  const mon = months[m[2]];
  if (!mon) return "";
  const day = m[1].padStart(2, "0");
  const year = m[3] || String(new Date().getFullYear());
  return `${year}-${mon}-${day}`;
}

// Normalize a time-of-day string to 4-digit HHMM. "930" → "0930", "7" →
// "0700", "0830" stays. Time ranges ("0700-2100") are normalized on both
// sides. Non-numeric / mixed strings are returned unchanged so we don't
// mangle anything unexpected (e.g. "TBC", "after lunch"). Safe to call
// on already-padded values — idempotent.
function pad4Time(t) {
  const s = String(t ?? "").trim();
  if (!s) return s;
  const range = s.match(/^(\d{1,4})\s*[-–]\s*(\d{1,4})$/);
  if (range) return pad4Time(range[1]) + "-" + pad4Time(range[2]);
  if (!/^\d{1,4}$/.test(s)) return s;
  if (s.length === 4) return s;
  if (s.length === 3) return "0" + s;          // "930" → "0930"
  if (s.length === 2) return s + "00";          // "07"  → "0700"
  return "0" + s + "00";                        // "7"   → "0700"
}

// Display-only formatter: normalize a clock time and append "Hrs", e.g.
// "0530" → "0530 Hrs", "0700-2100" → "0700-2100 Hrs". Empty → "". This is
// strictly for rendering (parade states, tables) — never persist its output;
// pad4Time remains the normalizer used for storage and matching keys. Leaves
// non-time strings (already-suffixed, "TBC", durations like "12:34") untouched.
function fmtHrs(t) {
  const p = pad4Time(t);
  if (!p || /hrs/i.test(p) || !/\d/.test(p) || p.includes(":")) return p;
  return `${p} Hrs`;
}

// ── MSK INJURY CLASSIFICATION ────────────────────────────
// Maps free-text injury descriptions ("sprained ankle", "TFCC right wrist",
// "shin splints") to body regions for analytics aggregation. Order matters
// for overlapping keywords — more specific terms (achilles, TFCC) win over
// generic (foot, wrist). Each row's `keys` are matched as substrings,
// case-insensitive, against the full text.
const MSK_REGION_MAP = [
  { keys: ["achilles", "calf", "shin", "lower leg"], region: "Shin / Lower Leg" },
  { keys: ["tfcc", "wrist"],                          region: "Hand / Wrist" },
  { keys: ["hand", "finger"],                         region: "Hand / Wrist" },
  { keys: ["ankle"],                                  region: "Ankle" },
  { keys: ["knee"],                                   region: "Knee" },
  { keys: ["tailbone", "coccyx"],                     region: "Back / Spine" },
  { keys: ["back", "spine", "lumbar"],                region: "Back / Spine" },
  { keys: ["shoulder", "rotator"],                    region: "Shoulder" },
  { keys: ["toe", "blister", "foot", "abrasion"],     region: "Foot" },
  { keys: ["thigh", "hamstring", "quad", "hip"],      region: "Upper Leg / Hip" },
  { keys: ["neck"],                                   region: "Neck" }
];

// Strong non-MSK signals — if these appear in a conductDetail.reason we
// exclude the row from MSK analytics regardless of other words. Catches
// the common "fever / cough / stomach / eczema" stuff that the CO doesn't
// want polluting injury charts.
const NON_MSK_KEYWORDS = [
  "fever", "flu", "cough", "sore throat", "stomach", "diarrh", "vomit",
  "nausea", "eczema", "rash", "skin", "lightheaded", "giddy", "headache",
  "blocked nose", "runny nose", "drowsy meds", "took meds"
];

// All known regions in display order — used by the manual-override picker
// menu and for "ensure all regions appear in the legend" type passes.
const MSK_REGION_LIST = [
  "Ankle", "Knee", "Back / Spine", "Shin / Lower Leg", "Shoulder",
  "Hand / Wrist", "Foot", "Upper Leg / Hip", "Neck", "Other"
];

// A CATEGORICAL ramp, not a status ramp: these encode which body part, so they
// must never be mapped onto --green/--red/--orange (a knee is not an error) and
// their only real job is being telling apart from each other. They are literals
// rather than tokens because styles.css is not ours to edit; if a future palette
// wants to own them, define --mskAnkle .. --mskOther on :root and they will win
// via mskRegionColor() below with no change here.
//
// Re-tuned for the ink blue-black ground: every hue lifted to the same vividness
// as the status colours, "Other" kept as a slate grey drawn from the --muted
// family so it recedes without reading as a hole in the deck, and "Neck" moved
// off pink-red to lime, because it, "Hand / Wrist" and "Ankle" were three
// neighbouring reds and the whole point of the set is that you can tell one
// segment from the next.
const MSK_REGION_COLORS = {
  "Ankle":             "#FF6A4D",
  "Knee":              "#FFA83D",
  "Back / Spine":      "#4DA3FF",
  "Shin / Lower Leg":  "#34D98F",
  "Shoulder":          "#A98CFF",
  "Hand / Wrist":      "#FF6FC4",
  "Foot":              "#35CFDB",
  "Upper Leg / Hip":   "#FFD34A",
  "Neck":              "#A8DB4D",
  "Other":             "#8A94AC"
};

// Region -> colour, preferring a --msk<Region> token if styles.css ever defines
// one, falling back to the literal ramp above.
function mskRegionColor(region) {
  const key = "--msk" + String(region || "Other").replace(/[^A-Za-z]/g, "");
  return cssColor(key, MSK_REGION_COLORS[region] || MSK_REGION_COLORS.Other);
}

function classifyInjuryRegions(text) {
  const t = String(text || "").toLowerCase();
  const hits = new Set();
  MSK_REGION_MAP.forEach(({ keys, region }) => {
    if (keys.some(k => t.includes(k))) hits.add(region);
  });
  return hits.size ? [...hits] : ["Other"];
}

// Returns true if a conductDetail.reason or similar text looks like an
// MSK case (mentions a region OR uses an injury verb). Non-MSK keywords
// veto it outright.
function isMSKReason(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (NON_MSK_KEYWORDS.some(k => t.includes(k))) return false;
  if (MSK_REGION_MAP.some(({ keys }) => keys.some(k => t.includes(k)))) return true;
  return /sprain|strain|injury|pain|sore|fell\b|hurt|swollen|inflam|fracture|tear/i.test(t);
}

// Resolves the regions for a recruit's MSK case. Manual override (set via
// the dashboard MSK card chips) wins. Otherwise unions auto-classified
// regions from BOTH the recruit's Report Injury rows AND any MSK-filtered
// conductDetail rows — so a recruit who falls out at PT due to MSK but
// never submits a Form report still shows up in region analytics with
// their reason text auto-classified.
function getMSKRegionsForRecruit(d4) {
  const reports = STATE.msk.filter(m =>
    m.d4 === d4 && (m.type || "").toLowerCase().includes("report")
  );

  // Manual override wins (stored on the Report Injury row, so only
  // available for recruits who submitted a form).
  const manual = reports.map(r => r.manualRegions).find(v => v && String(v).trim());
  if (manual) {
    return String(manual).split(",").map(s => s.trim()).filter(Boolean);
  }

  // Else union of auto-classified regions from form descriptions AND
  // MSK-classified conduct detail reasons for this recruit.
  const regions = new Set();
  reports.forEach(r => classifyInjuryRegions(r.description).forEach(reg => regions.add(reg)));
  STATE.conductDetail
    .filter(c => c.d4 === d4 && isMSKReason(c.reason))
    .forEach(c => classifyInjuryRegions(c.reason).forEach(reg => regions.add(reg)));

  // Strip "Other" if we found anything specific — keeps the region list clean.
  const result = [...regions];
  if (result.length > 1) return result.filter(r => r !== "Other");
  return result;
}
