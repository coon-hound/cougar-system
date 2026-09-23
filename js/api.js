// Thin wrapper around the Google Apps Script web app.
// Every data request carries an auth token. The token is obtained by redeeming
// a single-use invite link via API.redeemInvite() — see js/main.js bootstrap.

const AuthError = class extends Error {
  constructor(message) { super(message); this.name = "AuthError"; }
};

// Server couldn't take the write lock (body {error, code:503}) after the
// client exhausted its in-place retries. Carries no state - sync.js branches
// on the class to decide retry policy.
const BusyError = class extends Error {
  constructor(message) { super(message); this.name = "BusyError"; }
};

// The token is valid, but it is not allowed to do this (body {error, code:403}).
// A DIFFERENT thing from AuthError, and it needs the opposite retry policy from
// almost every other failure: retrying cannot outrun a permission you do not
// have, so the op is never replayed. Raised for the admin-only tabs.
const ForbiddenError = class extends Error {
  constructor(message) { super(message); this.name = "ForbiddenError"; }
};

// The backend does not know this tab. Almost always a DEPLOY ORDER problem:
// TABLE / STATE_KEY are module-level in the Edge Function, so a frontend that
// ships before the function is redeployed asks for a tab that does not exist
// yet. Retrying cannot fix it, and the tab is not coming back this session, so
// the client stops asking and keeps the data locally until it can.
const TabUnknownError = class extends Error {
  constructor(message, tab) { super(message); this.name = "TabUnknownError"; this.tab = tab; }
};

// Transport-level failure: fetch rejected (offline, DNS, CORS) or the request
// timed out. `timeout` distinguishes an abort-by-timer from other failures.
const NetError = class extends Error {
  constructor(message, timeout) { super(message); this.name = "NetError"; this.timeout = !!timeout; }
};

// Apps Script cold starts can take >10s; 30s separates "slow" from "gone".
// The launch readAll moves much more data, so it gets 60s (see API.pullAll).
const FETCH_TIMEOUT_MS = 30000;

// Single fetch path for every API call. Maps failures onto the error taxonomy:
//   body {code:401}      → throw AuthError (token revoked/expired)
//   AbortError (timeout) → throw NetError with .timeout = true
//   other fetch/json rejection → throw NetError
// Body-level {error} / {conflict} / {code:503} are NOT thrown here - they stay
// in the returned body so runWrite (sync.js) can apply per-class retry policy.
async function _fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
    data = await res.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw new NetError("Request timed out", true);
    throw new NetError((e && e.message) || String(e));
  } finally {
    clearTimeout(timer);
  }
  if (data && data.code === 401) throw new AuthError(data.error);
  return data;
}

// STATE-array-key → normalizer that assigns fresh sheet rows into STATE. Shared
// by the full pull (pullAll) and partial pulls (pullTabs) so both paths apply
// identical normalization. Keys match the readAll response keys.
const PULL_ASSIGN = {
  roster:        d => STATE.roster = normalizeRoster(d),
  medical:       d => STATE.medical = normalizeMedical(d),
  attendance:    d => STATE.attendance = normalizeAttendance(d),
  ippt:          d => STATE.ippt = normalizeIPPT(d),
  conductDetail: d => STATE.conductDetail = normalizeConductDetail(d),
  appointments:  d => STATE.appointments = normalizeAppointments(d),
  leave:         d => STATE.leave = normalizeLeave(d),
  msk:           d => STATE.msk = normalizeMSK(d),
  conducts:      d => STATE.conducts = padD4OnLayer(d),
  duty:          d => STATE.duty = normalizeDuty(d),
  calendar:      d => STATE.calendar = normalizeCalendar(d),
  oilRule:       d => STATE.oilRule = normalizeOilRule(d)
};

const API = {
  async get(action, tab, opts) {
    const auth = encodeURIComponent(STATE.authToken || "");
    const url = `${STATE.apiUrl}?action=${action}${tab ? "&tab=" + tab : ""}&auth=${auth}`;
    return _fetchJson(url, undefined, opts && opts.timeoutMs);
  },
  async post(body, opts) {
    return _fetchJson(STATE.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ...body, auth: STATE.authToken })
    }, opts && opts.timeoutMs);
  },
  // Redeem a single-use invite token. Does not require an existing auth token.
  async redeemInvite(token) {
    return _fetchJson(STATE.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "redeemInvite", token })
    });
  },
  // ── Access management ─────────────────────────────────────────────────
  //
  // whoami is asked by EVERY client on launch, so the app can say who is
  // signed in instead of holding an anonymous token string. The other three
  // are refused by the backend for any token without the can_invite
  // capability; hiding the screen in this file protects nothing, because this
  // file is public code served to every phone.
  async whoami() {
    return this.post({ action: "whoami" });
  },
  async listAccess() {
    return this.post({ action: "listAccess" });
  },
  // The name is NOT sent: the backend takes it from the roster row for this
  // 4D, so a tampered request cannot mint a credential labelled as someone it
  // is not — and that label is what the audit trail reports thereafter.
  async createInvite(d4, device, days, uses) {
    return this.post({ action: "createInvite", d4, device, days, uses });
  },
  // Revokes by PERSON. The client is never handed a token, so it cannot be
  // asked to give one back.
  // Kill the token they can no longer reach and mint a fresh link, in one
  // transaction, so a failure cannot leave somebody revoked with no way back.
  async reissueAccess(d4, device, days, uses) {
    return this.post({ action: "reissueAccess", d4, device, days, uses });
  },
  async revokeAccess(d4, what, device) {
    return this.post({ action: "revokeAccess", d4, what, device });
  },

  async pullAll() {
    // readAll moves every tab in one response - give it double the timeout.
    const data = await this.get("readAll", "", { timeoutMs: 60000 });
    if (data.error) throw new Error(data.error);
    // Only replace a STATE array when the response carries rows for it — an
    // empty array in the response must not wipe local data (matches prior behavior).
    for (const key in PULL_ASSIGN) {
      if (data[key]?.length) PULL_ASSIGN[key](data[key]);
    }
    if (data.revs) STATE.rev = data.revs;   // baseline per-tab revisions (sheet-keyed)
    saveLocal();
    return data;
  },
  // Partial pull — fetch ONLY the named sheet tabs (e.g. ["Medical"]) via the
  // single-tab read route, normalize via the same PULL_ASSIGN as pullAll, and
  // advance STATE.rev for each. Big unchanged tabs aren't re-fetched. Returns
  // { changed, tabs }.
  async pullTabs(sheetNames) {
    const fetched = await Promise.all((sheetNames || []).map(async sheet => {
      const res = await this.get("read", sheet);
      if (res && res.error) throw new Error(res.error);
      // read&tab now returns { rows, rev }; tolerate a bare array too.
      const rows = Array.isArray(res) ? res : (res && res.rows) || [];
      const rev = (res && res.rev != null) ? res.rev : undefined;
      return { sheet, rows, rev };
    }));
    let changed = false;
    for (const { sheet, rows, rev } of fetched) {
      const key = TAB_TO_STATE[sheet];
      if (key && PULL_ASSIGN[key] && Array.isArray(rows)) { PULL_ASSIGN[key](rows); changed = true; }
      if (rev != null) STATE.rev[sheet] = rev;
    }
    if (changed) saveLocal();
    return { changed, tabs: sheetNames };
  },
  // Cheap "what changed?" poll — returns { ok, revs: {Roster:N,…}, timestamp }.
  // No row data, so safe to call frequently.
  async revCheck() {
    return this.get("revCheck");
  },
  async pushTab(tabName, data) {
    return this.post({ action: "write", tab: tabName, data, baseRev: STATE.rev[tabName] });
  },
  async appendRow(tabName, row) {
    return this.post({ action: "append", tab: tabName, row, baseRev: STATE.rev[tabName] });
  },
  // ID-based row upsert — finds by row.id, updates in place if found, else
  // appends. The cross-device-safe write path: two devices editing different
  // rows of the same tab never clobber each other (no full-table rewrite).
  async upsertRow(tabName, row) {
    return this.post({ action: "upsertRow", tab: tabName, row, baseRev: STATE.rev[tabName] });
  },
  // ID-based row delete — surgical, doesn't rewrite the whole tab.
  async deleteRowById(tabName, id) {
    return this.post({ action: "deleteRowById", tab: tabName, id, baseRev: STATE.rev[tabName] });
  },
  // Lightweight pre-write staleness check. Returns { dataRows } for the tab.
  async rowCount(tabName) {
    return this.post({ action: "rowCount", tab: tabName });
  },
  // Sends one HTML email through the Apps Script owner's Gmail. Returns
  // { ok, remainingQuota } on success or { error, remainingQuota? } on
  // failure (quota exhaustion, bad recipient, transient send error).
  // inlineImages: optional { "cid_name": "base64_str_without_data_prefix" }
  // map — referenced from the htmlBody as <img src="cid:cid_name">.
  async sendEmail(to, subject, htmlBody, inlineImages) {
    // Sending (with inline images) can outrun the default 30s write timeout.
    return this.post({ action: "sendEmail", to, subject, htmlBody, inlineImages }, { timeoutMs: 120000 });
  },
  // Returns sender identity + current quota without sending anything.
  // Used by the report modal to surface "who emails will come from".
  async getEmailInfo() {
    return this.post({ action: "getEmailInfo" });
  },
  // Proxies one image to Claude via Apps Script (key lives in script
  // properties, never on the client). Returns
  //   { recruits: [{d4, avgHR, maxHR, calories, duration}], notes }
  // or { error }. validD4s seeds the prompt so Claude can ignore misreads.
  async analyzePhoto(imageBase64, mediaType, validD4s) {
    // Apps Script cold start + a Claude-vision extraction on a dense photo can
    // exceed 30s; give it a generous ceiling so OCR isn't aborted mid-flight.
    return this.post({ action: "analyzePhoto", imageBase64, mediaType, validD4s }, { timeoutMs: 120000 });
  },

  // ── Usage telemetry (js/telemetry.js) ─────────────────────────────────────
  //
  // These two deliberately sit OUTSIDE the sync machinery. They carry no
  // `tab` and no `baseRev`, they bump no revision, they mark no tab dirty and
  // they never enter the per-tab write queue — so a recorded click cannot
  // wake every other phone in the company through revCheck. The usage table is
  // excluded from REV_TABS and from readAll for the same reason; the insights
  // view reads it back on demand, never as part of a launch pull. See
  // TELEMETRY-DESIGN.md.
  //
  // Neither is ever allowed to surface an error to a user: telemetry.js catches
  // everything these throw and retries the batch later.

  // Append one batch of pre-aggregated counter deltas.
  // batch: { batchId, device, rows:[{day,kind,name,events,completed,abandoned,clicks,ms}] }
  // `batchId` makes the server's additive upsert replay-safe — a redelivered
  // batch is recognised and ignored rather than double-counted.
  async usageAppend(batch) {
    return this.post({ action: "usageAppend", ...batch }, { timeoutMs: 15000 });
  },

  // Fire-and-forget flush for `visibilitychange` → hidden, where a fetch is not
  // guaranteed to survive the page going away. Returns whether the browser
  // accepted the payload, not whether the server stored it — the caller treats
  // a dropped analytics batch as a non-event.
  usageBeacon(batch) {
    try {
      if (typeof navigator === "undefined" || !navigator.sendBeacon || !STATE.apiUrl) return false;
      const body = JSON.stringify({ ...batch, action: "usageAppend", auth: STATE.authToken });
      // text/plain matches API.post, so this stays a CORS simple request and
      // never needs a preflight the beacon could not perform.
      return navigator.sendBeacon(STATE.apiUrl, new Blob([body], { type: "text/plain" }));
    } catch { return false; }
  },

  // On-demand read for the insights view only. opts: { scope, device, days }
  // where scope is "device" (that one device) or "company" (everyone).
  async usageRead(opts) {
    return this.post({ action: "usageRead", ...(opts || {}) }, { timeoutMs: 20000 });
  }
};
