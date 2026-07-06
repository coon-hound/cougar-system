/*
 * COUGAR COMPANY DATA SYSTEM — Google Apps Script Backend
 * ═══════════════════════════════════════════════════════
 *
 * AUTH MODEL
 * ──────────
 * The script enforces token-based auth for all data operations. Two token types
 * live in PropertiesService:
 *
 *   invite:<token>  →  Two shapes:
 *     SINGLE-USE: {used, createdAt, usedAt?, issuedAuthToken?}
 *       • Mint via generateInvite(). Consumed on first click.
 *     BULK (multi-use): {maxUses, usedCount, redemptions[], createdAt, expiresAt?}
 *       • Mint via generateBulkInvite(maxUses, expiresInDays). Share ONE link
 *         with a whole team — each click issues a separate per-device auth
 *         token. Self-disables when cap or expiry is hit. Audit with
 *         bulkInviteStatus(token); kill with revokeInvite(token).
 *
 *   auth:<token>    →  {issuedAt, fromInvite}
 *     • Long-lived. Stored in the user's browser localStorage. Sent with every
 *       data request. Revoke with revokeAuthToken().
 *
 * SETUP (first deploy or after pulling these changes)
 * ───────────────────────────────────────────────────
 * 1. Open your Google Sheet → Extensions → Apps Script.
 * 2. Delete any existing code, paste this entire file.
 * 3. Update FRONTEND_BASE_URL below to match where your frontend is hosted.
 * 4. Deploy → Manage deployments → edit your existing deployment →
 *    pick a new Version → Deploy. (Keep the same web-app URL.)
 *    First time only: Deploy → New deployment → Web app:
 *      • Execute as: Me
 *      • Who has access: Anyone
 *      • Copy the Web App URL; paste it into js/state.js (APPS_SCRIPT_URL).
 * 5. Run generateInvite() from the editor → check the Execution log →
 *    open the printed URL on the device that needs access.
 *
 * SHEET TABS REQUIRED (create with headers in Row 1):
 *   Roster:     4d | name | age | status | notes | phone | email |
 *               ration | allergies | msk | highest education level |
 *               motorcycle license | height | weight | role | rank |
 *               leaveQuota
 *               (the column may be named "4d" or "id" — the frontend mirrors
 *                whichever is present into r.id at pull time. height in cm,
 *                weight in kg — BMI is computed client-side. role ∈
 *                {"Recruit", "Commander"} (defaults to Recruit if blank).
 *                Commanders use 4D 0001–0099, are never displayed in the
 *                UI by id — their rank+name shows instead. rank is free
 *                text ("3SG", "2LT", "CPT", "MSG"); leaveQuota is the
 *                off-in-lieu day cap (numeric, optional for recruits).)
 *   Medical:    id | d4 | date | reason | location | status | startDate | endDate
 *               (Each row represents a "report sick" event — `date` is the
 *                date the recruit reported sick. `location` is optional —
 *                the clinic/hospital where the recruit reported sick OUTSIDE;
 *                blank for in-camp report sick. status ∈ {MC, Warded, LD,
 *                RMJ, Excuse Heavy Load, Excuse Kneeling, Excuse Squatting,
 *                Excuse Uniform, Excuse RMJ, Excuse Swimming,
 *                Excuse Prolonged Standing, Excuse Upper Limb,
 *                Excuse Lower Limb, Pending, NIL}.
 *                NIL = MO saw the recruit and cleared them with no status.
 *                startDate/endDate are display-format dates ("16 May 2026")
 *                and BOTH ENDS ARE INCLUSIVE. Pending and NIL may have no
 *                startDate/endDate. After endDate, MC and LD get a 2-day
 *                "ghost" tag (MC+1, MC+2, LD+1, LD+2) computed client-side
 *                — not stored.)
 *   Attendance: id | date | time | conductId | total | participating | lms | px | fallout | remarks
 *               (time = "0730"/"1630" — same conduct on the same day at
 *                different times produces distinct rows. The Log Conduct
 *                wizard writes it directly; the legacy form leaves it blank.)
 *               (RSI removed from summary — morning report-sicks belong in
 *                the Medical log, not duplicated per-conduct. Legacy `rsi`
 *                column may still exist on older sheets; safe to delete.)
 *               (lms = how many of the participating recruits attended LMS for this conduct;
 *                LMS participation rate = lms / participating, computed client-side)
 *               (px = count of recruits on pre-existing medical status who
 *                did NOT participate. Renamed to "Status" in the UI but the
 *                sheet column name stays `px` for history continuity.)
 *               (remarks = free-text flags on data inconsistencies / per-recruit notes)
 *   IPPT:       id | d4 | attempt | date | pushups | situps | runTime | score
 *   RouteMarch: id | d4 | rmNum | date | time | avgHr | maxHr | pass
 *   SOC:        id | d4 | socNum | date | time | avgHr | pass
 *   PolarFlow:  id | d4 | conduct | date | avgHr | maxHr | minHr | z1 | z2 | z3 | z4 | z5 | calories | trainingLoad | recovery | duration | distance
 *   ConductDetail: id | date | time | conduct | d4 | type | reason
 *               (one row per non-participating recruit per conduct.
 *                type ∈ {PX, RSI, Fallout, ReportSick}:
 *                  PX         = pre-existing status before the conduct (MC/LD/RMJ);
 *                  RSI        = reporting sick at first parade that morning;
 *                  Fallout    = dropped out during the conduct itself;
 *                  ReportSick = sent to MO mid-day after the conduct.
 *                Aggregates in the Attendance sheet should match the
 *                per-conduct totals of these rows.)
 *
 *   Appointments: id | d4 | reason | date | time | location | outOfCamp | resolved
 *               (Booked future events — medical specialist visits, IPPT
 *                retakes, board appearances, etc. Sheet keeps full history;
 *                dashboard only shows entries where date >= today. date is
 *                display-format ("16 May 2026"); time is free text ("0930").
 *                outOfCamp = TRUE when the recruit leaves camp for the appt
 *                (shown in the parade state's MEDICAL APPT "Camp:" line);
 *                resolved = TRUE hides it from the dashboard + parade state.)
 *
 *   Leave:      id | d4 | type | startDate | endDate | days | reason
 *               (Personnel absences. type ∈ {Leave, Compassionate,
 *                Off-in-Lieu, Weekend, Night's Out, Course, Guard Duty,
 *                NDP, Other}. Only
 *                Off-in-Lieu decrements the per-commander leaveQuota
 *                (roster field). Night's Out = same-day evening off-camp
 *                (start = end = same date). startDate/endDate inclusive,
 *                display-format. `days` is numeric — defaults to
 *                (endDate − startDate + 1) but is editable for half-days.)
 *
 *   MSK:        timestamp | type | d4 | description | physioDate | cleared
 *               (Recruit self-reports from a Google Form ("Cougar MSK /
 *                Physio Log") that posts directly here. type ∈
 *                {"Report Injury", "Log Exercises"}. `cleared` is NOT
 *                in the form — manually add the column header after the
 *                first form response lands, leave new rows blank. The
 *                dashboard's "Mark Cleared" action writes TRUE; runs
 *                via the standard pushTab so cleared bits round-trip on
 *                the next Push All.)
 */

var FRONTEND_BASE_URL = "https://coon-hound.github.io/cougar-system/";

// ─── ROUTING ───────────────────────────────────────────

function doGet(e) {
  var output;
  try {
    var action = e.parameter.action || "readAll";
    var tab = e.parameter.tab || "";
    var auth = e.parameter.auth || "";

    // Public action: ping (used by the frontend to verify the URL is reachable).
    if (action === "ping") {
      output = { ok: true, sheets: getTabNames(), timestamp: new Date().toISOString() };
    } else if (!isValidAuth(auth)) {
      output = { error: "Unauthorized — invite required", code: 401 };
    } else if (action === "readAll") {
      output = readAllTabs();
    } else if (action === "revCheck") {
      // Cheap "what changed?" poll — just the per-tab revisions, no row data.
      output = { ok: true, revs: getAllRevs(), timestamp: new Date().toISOString() };
    } else if (action === "read" && tab) {
      // Single-tab read for partial pulls; carries the tab's current revision.
      output = { rows: readTab(tab), rev: getRev(tab) };
    } else {
      output = { error: "Unknown action. Use: readAll, revCheck, read&tab=TabName, or ping" };
    }
  } catch (err) {
    output = { error: err.message };
  }

  return jsonResponse(output);
}

function doPost(e) {
  // ── Telegram webhook branch ──────────────────────────
  // Telegram posts its update JSON here. Apps Script can't read request
  // headers, so the shared secret rides in the `tgsecret` query param that
  // setTelegramWebhook() bakes into the webhook URL. Everything else falls
  // through to the existing frontend routing untouched.
  if (e && e.parameter && e.parameter.tgsecret !== undefined) {
    return handleTelegramWebhook(e);
  }

  var output;
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || "write";
    var tab = body.tab || "";
    var auth = body.auth || "";

    // Public action: redeem a single-use invite token in exchange for an auth token.
    if (action === "redeemInvite") {
      output = redeemInvite(body.token);
    } else if (!isValidAuth(auth)) {
      output = { error: "Unauthorized — invite required", code: 401 };
    } else if (action === "write" && tab && body.data) {
      // Full-tab replace — the catastrophe vector. ENFORCE: reject if the
      // client's baseRev is stale so a stale tab can't clobber newer rows.
      output = withRevLock(tab, body.baseRev, true, function () { return writeTab(tab, body.data); });
    } else if (action === "append" && tab && body.row) {
      // Additive — no lost-update risk, so don't reject; still bump the rev.
      output = withRevLock(tab, body.baseRev, false, function () { return appendRow(tab, body.row); });
    } else if (action === "appendMany" && tab && body.rows) {
      output = withRevLock(tab, body.baseRev, false, function () { return appendMany(tab, body.rows); });
    } else if (action === "upsertRow" && tab && body.row) {
      // ID-based upsert — updates one row in place (or appends). It is ROW-SCOPED:
      // it never touches other rows, so two devices editing DIFFERENT rows of the
      // same tab can't clobber each other. Therefore do NOT enforce the tab
      // revision (that caused false conflicts + a retry storm) — just apply and
      // bump. Same-row simultaneous edits remain last-write-wins (acceptable).
      output = withRevLock(tab, body.baseRev, false, function () { return upsertRow(tab, body.row); });
    } else if (action === "deleteRowById" && tab && body.id !== undefined) {
      // ID-based delete — also row-scoped; no enforce (can't clobber other rows).
      output = withRevLock(tab, body.baseRev, false, function () { return deleteRowById(tab, body.id); });
    } else if (action === "rowCount" && tab) {
      // Lightweight pre-write staleness check. Returns the sheet's current
      // data-row count so the frontend can warn before a bulk pushTab if
      // another device added rows since the last pull.
      output = rowCount(tab);
    } else if (action === "deleteRow" && tab && body.rowIndex !== undefined) {
      output = withRevLock(tab, body.baseRev, false, function () { return deleteRow(tab, body.rowIndex); });
    } else if (action === "updateRow" && tab && body.rowIndex !== undefined && body.row) {
      output = withRevLock(tab, body.baseRev, false, function () { return updateRow(tab, body.rowIndex, body.row); });
    } else if (action === "sendEmail") {
      output = sendEmailHelper(body);
    } else if (action === "getEmailInfo") {
      // All three Apps Script calls below require OAuth scopes that aren't
      // granted by default. Wrap each so the missing-scope case shows a
      // clear, actionable message instead of crashing the whole modal.
      var senderEmail = "";
      try { senderEmail = Session.getEffectiveUser().getEmail(); } catch (e) { /* no userinfo.email scope */ }
      if (!senderEmail) {
        try { senderEmail = Session.getActiveUser().getEmail(); } catch (e) { /* no userinfo.email scope */ }
      }
      var remainingQuota = null, quotaError = null;
      try {
        remainingQuota = MailApp.getRemainingDailyQuota();
      } catch (e) {
        quotaError = "Email scope not granted yet — grant the script.send_mail permission to enable sending.";
      }
      output = {
        senderEmail: senderEmail || "",
        remainingQuota: remainingQuota,
        quotaError: quotaError
      };
    } else if (action === "analyzePhoto") {
      output = analyzePhotoHelper(body);
    } else {
      output = { error: "Invalid request" };
    }
  } catch (err) {
    output = { error: err.message };
  }

  return jsonResponse(output);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── AUTH / INVITE FLOW ────────────────────────────────

function isValidAuth(token) {
  if (!token) return false;
  return PropertiesService.getScriptProperties().getProperty("auth:" + token) !== null;
}

// ─── REVISION TRACKING / OPTIMISTIC CONCURRENCY ─────────
// Each data tab carries a monotonic revision counter in ScriptProperties
// (key "rev:<TabName>"), bumped on every successful write. Clients send the
// revision they last saw as `baseRev`; a write whose baseRev no longer matches
// the server is REJECTED (conflict) instead of being allowed to clobber newer
// data. A single script lock makes the check → write → bump sequence atomic,
// since Apps Script web apps do NOT serialize concurrent requests.
var REV_TABS = ["Roster", "Medical", "Attendance", "IPPT", "RouteMarch", "SOC",
  "PolarFlow", "ConductDetail", "Appointments", "Leave", "MSK", "Conducts"];

function getRev(tabName) {
  var p = PropertiesService.getScriptProperties();
  var v = p.getProperty("rev:" + tabName);
  if (v === null) { p.setProperty("rev:" + tabName, "1"); return 1; }  // lazily seed
  return Number(v) || 1;
}

function bumpRev(tabName) {
  var p = PropertiesService.getScriptProperties();
  var next = (Number(p.getProperty("rev:" + tabName)) || 1) + 1;
  p.setProperty("rev:" + tabName, String(next));
  return next;
}

function getAllRevs() {
  var p = PropertiesService.getScriptProperties();
  var out = {};
  for (var i = 0; i < REV_TABS.length; i++) {
    var v = p.getProperty("rev:" + REV_TABS[i]);
    out[REV_TABS[i]] = v === null ? 1 : (Number(v) || 1);
  }
  return out;
}

// Optional one-time editor run; getRev also seeds lazily so this isn't required.
function initAllRevs() {
  for (var i = 0; i < REV_TABS.length; i++) getRev(REV_TABS[i]);
  return getAllRevs();
}

// Lock used for DATA writes. Deliberately the DOCUMENT lock, NOT the script
// lock — the Telegram poller (tgPoll) holds the *script* lock for up to 5
// minutes while long-polling, which would otherwise block every web-app write
// until its waitLock timeout. The document lock scopes contention to actual
// sheet writers. Falls back to the script lock for a standalone (unbound) script.
function getDataLock() {
  try { var l = LockService.getDocumentLock(); if (l) return l; } catch (e) {}
  return LockService.getScriptLock();
}

// Atomic write wrapper. `enforce` true → reject when the client's `baseRev` no
// longer matches the server (lost-update prevention). Runs fn() (the actual
// sheet mutation) under the data lock, then bumps the tab's revision on success
// and returns it as `result.rev` so the client can advance its baseline.
// Backward-compat: a missing baseRev (old cached client) skips the check but
// still bumps, so newer clients immediately see the change.
function withRevLock(tabName, baseRev, enforce, fn) {
  var lock = getDataLock();
  try { lock.waitLock(15000); }
  catch (e) { return { error: "Server busy, please retry", code: 503 }; }
  try {
    var serverRev = getRev(tabName);
    if (enforce && baseRev !== undefined && baseRev !== null && baseRev !== "" &&
        Number(baseRev) !== serverRev) {
      return { conflict: true, tab: tabName, serverRev: serverRev };
    }
    var result = fn();
    if (result && result.error) return result;          // don't bump on failure
    if (!result) result = { ok: true };
    result.rev = bumpRev(tabName);
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ── Manual-edit propagation (installable onEdit trigger) ─────
// App/bot writes bump the revision through withRevLock, but typing directly into
// the Google Sheet bypasses all of that — so dashboards' revCheck poll would
// never notice a hand edit. This trigger bumps the edited tab's revision on any
// human edit in the Sheets UI, so manual edits auto-refresh into open tabs too.
// NOTE: programmatic writes (the web app's setValues) do NOT fire onEdit, so
// this never double-counts app writes. Run installEditTrigger() ONCE from the
// editor to enable it (an installable trigger is required — simple onEdit can't
// reliably use ScriptProperties/LockService).
function onEditBumpRev(e) {
  try {
    var sheet = e && e.range && e.range.getSheet();
    if (!sheet) return;
    var name = sheet.getName();
    if (REV_TABS.indexOf(name) === -1) return;   // only tracked data tabs
    // Lock so the bump can't race a concurrent app write to the same tab — both
    // must land as distinct revisions or a client could miss one. Use the DATA
    // (document) lock, not the script lock the Telegram poller holds for minutes.
    var lock = getDataLock();
    try { lock.waitLock(10000); } catch (le) { bumpRev(name); return; }  // best-effort
    try { bumpRev(name); } finally { lock.releaseLock(); }
  } catch (err) {
    // Triggers must fail quietly — never block the user's edit.
    try { Logger.log("onEditBumpRev error: " + err); } catch (e2) {}
  }
}

// One-time setup: run this ONCE from the Apps Script editor (it asks for the
// ScriptApp authorization). Idempotent — removes any prior copy first.
function installEditTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "onEditBumpRev") ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger("onEditBumpRev")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  return "Installed onEdit rev-bump trigger for: " + REV_TABS.join(", ");
}

// One-time admin: store the Anthropic API key in script properties so
// analyzePhotoHelper can read it without exposing the key to the public
// web app URL. Run from the editor:  setAnthropicKey("sk-ant-…")
// (then DELETE the literal from your editor history so it doesn't sit
// in your git history or screenshare).
function setAnthropicKey(key) {
  if (!key || String(key).indexOf("sk-ant-") !== 0) {
    Logger.log("Refusing to store — key should start with sk-ant-");
    return;
  }
  PropertiesService.getScriptProperties().setProperty("ANTHROPIC_API_KEY", key);
  Logger.log("Key stored. Length: " + key.length);
}

// Proxies a Claude vision call to extract Polar class summary data from
// a photo. Frontend sends:
//   { imageBase64: "...", mediaType: "image/jpeg", validD4s: ["1101", ...] }
// Returns:
//   { recruits: [{d4, avgHR, maxHR, calories, duration}], notes, raw }
//   { error: "..." } on any failure (missing key, API error, parse error).
function analyzePhotoHelper(body) {
  if (!body || !body.imageBase64) return { error: "Missing imageBase64" };

  var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!key) {
    return { error: "Anthropic API key not set. Run setAnthropicKey('sk-ant-…') from the Apps Script editor once." };
  }

  var validD4s = Array.isArray(body.validD4s) ? body.validD4s : [];
  var mediaType = body.mediaType || "image/jpeg";

  var systemPrompt = "You analyse photos of Polar Flow class summary screens for a Singapore Army training company (Cougar Coy). " +
    "Each photo is a screenshot of the Polar Flow app's class summary, showing a table where every row is one recruit's session: " +
    "their 4D number, average heart rate (bpm), maximum heart rate (bpm), calories burned (kcal), and session duration. " +
    "Recruit 4D numbers are exactly 4 digits (e.g. 1101, 4213).\n\n" +
    "COMPLETENESS IS CRITICAL. Missing rows is the #1 failure mode. Follow this procedure:\n" +
    "1. First, look at the entire image and COUNT the total number of recruit rows visible (top to bottom). Call this N.\n" +
    "2. Extract EVERY row, one by one, top to bottom. Do not skip rows. Do not summarise.\n" +
    "3. Before responding, verify your `recruits` array has exactly N entries. If it doesn't, go back and find the missing rows.\n" +
    "4. Set `rowCount` in your response to N (your initial count) so the operator can spot truncation.\n\n" +
    "Valid recruit 4Ds in this company: " + validD4s.join(", ") + ".\n" +
    "Use this list to RESOLVE AMBIGUITY when a digit is unclear (e.g. you read '1108' but only '1109' is in the list — prefer '1109'). " +
    "DO NOT drop a row just because its 4D isn't in the list — include it and set `unverified: true` so the operator can review. " +
    "Dropping rows silently is much worse than including a slightly-wrong 4D.\n\n" +
    "Respond ONLY with a JSON object, no markdown fences, no explanation outside the JSON:\n" +
    "{\n" +
    "  \"rowCount\": 22,\n" +
    "  \"recruits\": [\n" +
    "    {\"d4\": \"1108\", \"avgHR\": 155, \"maxHR\": 185, \"calories\": 420, \"duration\": 25},\n" +
    "    {\"d4\": \"1109\", \"avgHR\": 148, \"maxHR\": 178, \"calories\": 380, \"duration\": 25, \"unverified\": true},\n" +
    "    ...\n" +
    "  ],\n" +
    "  \"notes\": \"optional one-line observation (e.g. 'rows 18-20 blurry', or empty string)\"\n" +
    "}\n\n" +
    "Numbers should be integers (no units, no 'bpm' text). If a single field for a row isn't readable, omit that key from the object but STILL include the row. " +
    "If you can't read any data at all, return { \"rowCount\": 0, \"recruits\": [], \"notes\": \"no Polar data detected\" }.";

  var payload = {
    model: "claude-sonnet-4-5",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: body.imageBase64 } },
        { type: "text", text: "Extract every recruit row from this Polar class summary. Count rows first, then extract — do not skip any." }
      ]
    }]
  };

  try {
    var res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      contentType: "application/json",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code < 200 || code >= 300) {
      // Try to surface Anthropic's error message.
      try { var errObj = JSON.parse(text); return { error: "Anthropic " + code + ": " + (errObj.error && errObj.error.message || text) }; }
      catch (e) { return { error: "Anthropic " + code + ": " + text.slice(0, 200) }; }
    }

    var resp = JSON.parse(text);
    var raw = "";
    (resp.content || []).forEach(function (block) { if (block.type === "text") raw += block.text; });
    // Strip markdown code fences Claude sometimes emits despite being told not to.
    var clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    var parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { return { error: "Could not parse Claude response as JSON", raw: clean.slice(0, 500) }; }

    if (!parsed.recruits) parsed.recruits = [];
    // Surface rowCount so the frontend can warn the user when the extracted
    // row count is less than Claude's own count of visible rows (= truncation).
    return {
      recruits: parsed.recruits,
      rowCount: parsed.rowCount != null ? +parsed.rowCount : parsed.recruits.length,
      notes: parsed.notes || ""
    };
  } catch (e) {
    return { error: "Network/UrlFetch error: " + e.message };
  }
}

// Sends a single HTML email via the script owner's Gmail. Used by the
// dashboard's Fitness Report sender — one POST per recruit. Returns the
// remaining daily quota so the frontend loop can abort cleanly when 0.
// MailApp quota: 100/day on free Gmail, 1500/day on Workspace.
function sendEmailHelper(body) {
  if (!body || !body.to) return { error: "Missing recipient" };
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining <= 0) return { error: "Daily quota exhausted", remainingQuota: 0 };

  // Convert any inline image base64 strings into Blob objects so MailApp
  // can attach + reference them via cid:. Gmail blocks data: URIs in
  // <img src>, but cid: works fine. Frontend sends:
  //   inlineImages: { "chart_0": "iVBORw0KGgo...", "chart_1": "..." }
  // and the htmlBody contains <img src="cid:chart_0">.
  var inlineImages = {};
  if (body.inlineImages && typeof body.inlineImages === "object") {
    for (var key in body.inlineImages) {
      var b64 = String(body.inlineImages[key] || "");
      if (b64.indexOf("base64,") !== -1) b64 = b64.split("base64,")[1];
      if (!b64) continue;
      inlineImages[key] = Utilities.newBlob(Utilities.base64Decode(b64), "image/jpeg", key + ".jpg");
    }
  }

  try {
    var opts = {
      to: body.to,
      subject: body.subject || "Cougar Fitness Report",
      htmlBody: body.htmlBody || "",
      name: "Cougar Coy Training"
    };
    if (Object.keys(inlineImages).length) opts.inlineImages = inlineImages;
    MailApp.sendEmail(opts);
    return { ok: true, remainingQuota: MailApp.getRemainingDailyQuota() };
  } catch (e) {
    return { error: e.message, remainingQuota: remaining };
  }
}

function redeemInvite(inviteToken) {
  if (!inviteToken) return { error: "Missing invite token" };
  var props = PropertiesService.getScriptProperties();
  var key = "invite:" + inviteToken;
  var raw = props.getProperty(key);
  if (!raw) return { error: "Invalid invite link" };

  var invite = JSON.parse(raw);
  var now = new Date().toISOString();
  var nowMs = Date.now();

  // Multi-use invite: tracked via maxUses + usedCount. The same link can be
  // shared with a whole team; each device gets its own auth token, and the
  // link self-expires once the cap or expiry date is hit. Single-use invites
  // (no maxUses field) keep the legacy behavior below.
  if (typeof invite.maxUses === "number") {
    if (invite.expiresAt && nowMs > Date.parse(invite.expiresAt)) return { error: "This invite link has expired" };
    if ((invite.usedCount || 0) >= invite.maxUses) return { error: "This invite link is full — ask your admin for a new one" };

    var authTokenM = Utilities.getUuid();
    invite.usedCount = (invite.usedCount || 0) + 1;
    invite.redemptions = invite.redemptions || [];
    invite.redemptions.push({ at: now, authToken: authTokenM });
    props.setProperty(key, JSON.stringify(invite));
    props.setProperty("auth:" + authTokenM, JSON.stringify({ issuedAt: now, fromInvite: inviteToken }));
    return { ok: true, authToken: authTokenM };
  }

  if (invite.used) return { error: "This invite has already been used" };

  var authToken = Utilities.getUuid();

  invite.used = true;
  invite.usedAt = now;
  invite.issuedAuthToken = authToken;
  props.setProperty(key, JSON.stringify(invite));
  props.setProperty("auth:" + authToken, JSON.stringify({ issuedAt: now, fromInvite: inviteToken }));

  return { ok: true, authToken: authToken };
}

// ─── ADMIN FUNCTIONS — run from the Apps Script editor ─

function generateInvite() {
  var token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(
    "invite:" + token,
    JSON.stringify({ used: false, createdAt: new Date().toISOString() })
  );
  var link = FRONTEND_BASE_URL + "?token=" + token;
  Logger.log("───────────────────────────────────────────");
  Logger.log("NEW INVITE LINK (single-use):");
  Logger.log(link);
  Logger.log("───────────────────────────────────────────");
  return link;
}

// Multi-use invite for bulk onboarding (e.g. dropping one link in a WhatsApp
// group of 30 PCs). Each click issues a separate per-device auth token, so
// revoking one user later does not affect the rest. The link self-disables
// once `maxUses` is hit or `expiresInDays` passes.
//
// Usage from the editor: generateBulkInvite(30, 7)
//   maxUses        — cap on redemptions (default 30)
//   expiresInDays  — link auto-expires after N days (default 7; pass 0 to disable)
function generateBulkInvite(maxUses, expiresInDays) {
  var max = (typeof maxUses === "number" && maxUses > 0) ? Math.floor(maxUses) : 30;
  var days = (typeof expiresInDays === "number" && expiresInDays >= 0) ? expiresInDays : 7;
  var token = Utilities.getUuid();
  var now = new Date();
  var record = {
    maxUses: max,
    usedCount: 0,
    redemptions: [],
    createdAt: now.toISOString()
  };
  if (days > 0) record.expiresAt = new Date(now.getTime() + days * 86400000).toISOString();

  PropertiesService.getScriptProperties().setProperty("invite:" + token, JSON.stringify(record));
  var link = FRONTEND_BASE_URL + "?token=" + token;
  Logger.log("═══════════════════════════════════════════");
  Logger.log("NEW BULK INVITE LINK");
  Logger.log("  uses: 0 / " + max + (days > 0 ? "    expires: " + record.expiresAt : "    (no expiry)"));
  Logger.log("  share this ONE link with your group:");
  Logger.log("  " + link);
  Logger.log("═══════════════════════════════════════════");
  Logger.log("To audit redemptions later:  bulkInviteStatus(\"" + token + "\")");
  Logger.log("To kill the link:            revokeInvite(\"" + token + "\")");
  return link;
}

// Print redemption count + timestamps for a bulk invite. Auth tokens are not
// printed to keep the log safe to screenshot.
function bulkInviteStatus(token) {
  var raw = PropertiesService.getScriptProperties().getProperty("invite:" + token);
  if (!raw) { Logger.log("No invite with token: " + token); return; }
  var inv = JSON.parse(raw);
  Logger.log("Invite " + token);
  Logger.log("  type:    " + (typeof inv.maxUses === "number" ? "bulk" : "single-use"));
  if (typeof inv.maxUses === "number") {
    Logger.log("  uses:    " + (inv.usedCount || 0) + " / " + inv.maxUses);
    Logger.log("  expires: " + (inv.expiresAt || "(no expiry)"));
    Logger.log("  redemptions:");
    (inv.redemptions || []).forEach(function (r, i) {
      Logger.log("    " + (i + 1) + ". " + r.at);
    });
  } else {
    Logger.log("  used:    " + !!inv.used + (inv.usedAt ? " at " + inv.usedAt : ""));
  }
}

function listInvites() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var rows = [];
  for (var key in props) {
    if (key.indexOf("invite:") === 0) {
      rows.push(key + " → " + props[key]);
    }
  }
  Logger.log("Invites (" + rows.length + "):");
  rows.forEach(function (r) { Logger.log(r); });
}

function listAuthTokens() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var rows = [];
  for (var key in props) {
    if (key.indexOf("auth:") === 0) {
      rows.push(key + " → " + props[key]);
    }
  }
  Logger.log("Auth tokens (" + rows.length + "):");
  rows.forEach(function (r) { Logger.log(r); });
}

function revokeAuthToken(token) {
  PropertiesService.getScriptProperties().deleteProperty("auth:" + token);
  Logger.log("Revoked auth token: " + token);
}

function revokeInvite(token) {
  PropertiesService.getScriptProperties().deleteProperty("invite:" + token);
  Logger.log("Revoked invite: " + token);
}

// Nuclear option: kicks every authenticated device. Each user will need a
// fresh invite link from you to regain access. Invites themselves are NOT
// touched — only issued auth tokens.
function revokeAllAuthTokens() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var count = 0;
  for (var key in all) {
    if (key.indexOf("auth:") === 0) {
      props.deleteProperty(key);
      count++;
    }
  }
  Logger.log("Revoked " + count + " auth token(s). Every device must redeem a new invite.");
}

// ─── READ OPERATIONS ───────────────────────────────────

function getTabNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheets().map(function (s) { return s.getName(); });
}

function readTab(tabName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found", available: getTabNames() };

  var range = sheet.getDataRange();
  var data = range.getValues();
  if (data.length < 2) return [];

  // getDisplayValues() is a SECOND full read of the sheet — only fetch it when
  // the tab actually contains time-only Date cells (epoch year < 1900), whose
  // user-chosen display format (mm:ss / hh:mm) we must preserve. Most tabs have
  // none, so this skips the second read and roughly halves the per-tab cost.
  var needDisplay = false;
  for (var di = 1; di < data.length && !needDisplay; di++) {
    var drow = data[di];
    for (var dj = 0; dj < drow.length; dj++) {
      if (drow[dj] instanceof Date && drow[dj].getFullYear() < 1900) { needDisplay = true; break; }
    }
  }
  var display = needDisplay ? range.getDisplayValues() : null;
  var tz = Session.getScriptTimeZone();

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var rows = [];

  for (var i = 1; i < data.length; i++) {
    var row = {};
    var hasData = false;
    for (var j = 0; j < headers.length; j++) {
      if (headers[j]) {
        var val = data[i][j];
        // For Date-typed cells:
        //   • Time-only values (spreadsheet epoch 1899-12-30) → use the sheet's
        //     display string so the user's chosen format flows through as-is.
        //   • Real calendar dates → force "dd MMM yyyy" for locale stability.
        if (val instanceof Date) {
          val = val.getFullYear() < 1900
            ? (display ? display[i][j] : Utilities.formatDate(val, tz, "HH:mm"))
            : Utilities.formatDate(val, tz, "dd MMM yyyy");
        }
        row[headers[j]] = val;
        if (val !== "" && val !== null && val !== undefined) hasData = true;
      }
    }
    if (hasData) rows.push(row);
  }

  return rows;
}

function readAllTabs() {
  var tabMap = {
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

  var result = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  for (var tabName in tabMap) {
    var sheet = ss.getSheetByName(tabName);
    if (sheet) {
      result[tabMap[tabName]] = readTab(tabName);
    } else {
      result[tabMap[tabName]] = [];
    }
  }

  result.timestamp = new Date().toISOString();
  result.sheetName = ss.getName();
  result.revs = getAllRevs();   // per-tab revisions so the client can baseline
  return result;
}

// ─── WRITE OPERATIONS ──────────────────────────────────

function writeTab(tabName, data) {
  if (!Array.isArray(data) || data.length === 0) {
    return { error: "Data must be a non-empty array of objects" };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }

  var headers = Object.keys(data[0]);

  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sheet.setFrozenRows(1);

  var rows = data.map(function (obj) {
    return headers.map(function (h) {
      var val = obj[h];
      return val !== undefined && val !== null ? val : "";
    });
  });

  if (rows.length > 0) {
    setValuesAsText(sheet.getRange(2, 1, rows.length, headers.length), rows);
  }

  return {
    ok: true,
    tab: tabName,
    rowsWritten: rows.length,
    timestamp: new Date().toISOString()
  };
}

// Ensures the sheet has a column for every key in `keys`. Any missing header is
// appended to row 1 (bold) so NEW fields persist on first write instead of being
// silently dropped — the row-level writers only map to existing columns, which
// otherwise loses a field until someone does a full re-push. Returns the
// up-to-date trimmed header list.
// Google Sheets auto-coerces strings like "12:30" (a 2.4km run time) or "26 Jun"
// into time/date serials on write, silently corrupting them — the bad value then
// round-trips back into the app and breaks parsing (e.g. the IPPT run-time charts
// vanish because every run reads as 0). Forcing the target range to plain-text
// number format BEFORE setValues makes Sheets store every value verbatim. The app
// reads strings and parses them itself, so text storage is always correct here.
function setValuesAsText(range, values) {
  range.setNumberFormat("@");
  range.setValues(values);
}

function ensureColumnsForKeys(sheet, keys) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var trimmed = headers.map(function (h) { return String(h).trim(); });
  var missing = [];
  keys.forEach(function (k) {
    if (k && trimmed.indexOf(k) === -1 && missing.indexOf(k) === -1) missing.push(k);
  });
  if (missing.length) {
    var rng = sheet.getRange(1, trimmed.length + 1, 1, missing.length);
    rng.setValues([missing]);
    rng.setFontWeight("bold");
    trimmed = trimmed.concat(missing);
  }
  return trimmed;
}

function appendRow(tabName, rowData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };

  var trimmed = ensureColumnsForKeys(sheet, Object.keys(rowData));
  var newRow = trimmed.map(function (h) {
    var val = rowData[h];
    return val !== undefined && val !== null ? val : "";
  });

  setValuesAsText(sheet.getRange(sheet.getLastRow() + 1, 1, 1, newRow.length), [newRow]);

  return {
    ok: true,
    tab: tabName,
    newRowIndex: sheet.getLastRow() - 1,
    timestamp: new Date().toISOString()
  };
}

function appendMany(tabName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: "Rows must be a non-empty array" };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };

  var keySet = {};
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { keySet[k] = true; }); });
  var trimmed = ensureColumnsForKeys(sheet, Object.keys(keySet));
  var newRows = rows.map(function (rowData) {
    return trimmed.map(function (h) {
      var val = rowData[h];
      return val !== undefined && val !== null ? val : "";
    });
  });

  var startRow = sheet.getLastRow() + 1;
  setValuesAsText(sheet.getRange(startRow, 1, newRows.length, trimmed.length), newRows);

  return {
    ok: true,
    tab: tabName,
    rowsAppended: newRows.length,
    timestamp: new Date().toISOString()
  };
}

// ID-based upsert. Finds the row whose `id` column matches `rowData.id`,
// overwrites that row in place. If no such row exists, appends a new one.
// This is the cross-device-safe write primitive — two devices editing
// different rows of the same tab won't clobber each other (no full-table
// rewrite). Same-row simultaneous edits remain last-write-wins per row.
function upsertRow(tabName, rowData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };
  if (!rowData || rowData.id === undefined || rowData.id === null || rowData.id === "") {
    return { error: "upsertRow requires a non-empty id field on the row" };
  }
  if (!sheet.getLastColumn()) return { error: "Tab '" + tabName + "' has no header row" };
  // Auto-create columns for any new fields so they persist instead of dropping.
  var trimmed = ensureColumnsForKeys(sheet, Object.keys(rowData));
  var idCol = trimmed.indexOf("id");
  if (idCol === -1) return { error: "No 'id' column in tab " + tabName };

  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var idCells = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    var target = String(rowData.id);
    for (var i = 0; i < idCells.length; i++) {
      if (String(idCells[i][0]) === target) {
        var sheetRow = i + 2;
        var updatedRow = trimmed.map(function (h) {
          var val = rowData[h];
          return val !== undefined && val !== null ? val : "";
        });
        setValuesAsText(sheet.getRange(sheetRow, 1, 1, trimmed.length), [updatedRow]);
        return {
          ok: true,
          tab: tabName,
          action: "updated",
          rowIndex: sheetRow,
          timestamp: new Date().toISOString()
        };
      }
    }
  }
  // Not found — append a new row.
  var newRow = trimmed.map(function (h) {
    var val = rowData[h];
    return val !== undefined && val !== null ? val : "";
  });
  setValuesAsText(sheet.getRange(sheet.getLastRow() + 1, 1, 1, newRow.length), [newRow]);
  return {
    ok: true,
    tab: tabName,
    action: "appended",
    rowIndex: sheet.getLastRow(),
    timestamp: new Date().toISOString()
  };
}

// ID-based row delete. Finds the row whose `id` column matches and removes
// it. Returns ok:false (not an error) when the id isn't found — the
// frontend treats "row already gone" as a no-op success.
function deleteRowById(tabName, rowId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };
  var lastCol = sheet.getLastColumn();
  if (!lastCol) return { error: "Tab '" + tabName + "' has no header row" };
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var trimmed = headers.map(function (h) { return String(h).trim(); });
  var idCol = trimmed.indexOf("id");
  if (idCol === -1) return { error: "No 'id' column in tab " + tabName };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, action: "noop", note: "tab empty" };
  var idCells = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var target = String(rowId);
  for (var i = 0; i < idCells.length; i++) {
    if (String(idCells[i][0]) === target) {
      sheet.deleteRow(i + 2);
      return {
        ok: true,
        tab: tabName,
        action: "deleted",
        rowIndex: i + 2,
        timestamp: new Date().toISOString()
      };
    }
  }
  return { ok: true, action: "noop", note: "id " + rowId + " not found in " + tabName };
}

// Lightweight pre-write staleness check. Returns just the data-row count
// (last row minus header) so the frontend can warn before a bulk pushTab
// when another device added rows since this device's last pull.
function rowCount(tabName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };
  var last = sheet.getLastRow();
  return { ok: true, tab: tabName, dataRows: Math.max(0, last - 1) };
}

function updateRow(tabName, rowIndex, rowData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var sheetRow = rowIndex + 2;

  if (sheetRow > sheet.getLastRow()) {
    return { error: "Row index " + rowIndex + " out of range" };
  }

  var updatedRow = headers.map(function (h) {
    var val = rowData[String(h).trim()];
    return val !== undefined && val !== null ? val : "";
  });

  setValuesAsText(sheet.getRange(sheetRow, 1, 1, headers.length), [updatedRow]);

  return {
    ok: true,
    tab: tabName,
    rowUpdated: rowIndex,
    timestamp: new Date().toISOString()
  };
}

function deleteRow(tabName, rowIndex) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return { error: "Tab '" + tabName + "' not found" };

  var sheetRow = rowIndex + 2;
  if (sheetRow > sheet.getLastRow()) {
    return { error: "Row index " + rowIndex + " out of range" };
  }

  sheet.deleteRow(sheetRow);

  return {
    ok: true,
    tab: tabName,
    rowDeleted: rowIndex,
    timestamp: new Date().toISOString()
  };
}

/* ════════════════════════════════════════════════════════════════════
 * TELEGRAM REPORT-SICK (RSO) BOT
 * ════════════════════════════════════════════════════════════════════
 *
 * A serverless Telegram bot that guides a recruit through reporting sick
 * the right way and logs it straight into the existing Sheet (Medical /
 * ReportSick) so it shows up in the dashboard + parade states, then pings
 * the section commander in a commanders' group.
 *
 * ONE-TIME SETUP (run from the Apps Script editor, in order):
 *   1. setupBotTabs()                       — creates TgUsers / ReportSick / Config tabs
 *   2. setTelegramSecrets("<bot-token>", "<any-random-secret>")
 *   3. Deploy the web app (same deployment / new version)
 *   4. setTelegramWebhook()                 — registers the webhook
 *   5. getTelegramWebhookInfo()             — confirm "ok":true, no last_error
 *   6. Add the bot to the commanders' group, type /here in that group,
 *      copy the printed chat id into Config!botGroupChatId.
 *
 * Config tab (single data row, edited by the duty COS):
 *   botGroupChatId | nextBookInDate | nextBookInTime | outOfCamp | cutoffHours | rsoFormUrl
 *   e.g.  -1002345 | 12 Jul 2026    | 2200           | TRUE      | 4           | https://form.gov.sg/...
 */

var TG_PROCEDURE =
  "📋 Report-Sick (RSO) Procedure\n\n" +
  "BEFORE seeing a doctor:\n" +
  "• Inform your Section Commander.\n" +
  "• Tell me the reason + which clinic (this bot logs it + pings your SC).\n\n" +
  "OUT OF CAMP: your status/MC must be SUBMITTED by the cut-off = 4 hours before book-in. " +
  "That means you must report sick, see the doctor, AND send your status here before that time — " +
  "so start early; don't wait. While on MC: rest at home the whole duration, no overseas/strenuous activity, " +
  "only leave home for food/meds/doctor.\n\n" +
  "IN CAMP: inform your duty commander + sign the Report-Sick book at the COS office, then use this bot.\n\n" +
  "AFTER the doctor: come back and tap “Submit MC”, choose your status + days, and upload a photo of the MC slip. " +
  "This must be in by the cut-off (4h before book-in).";

// ─── Patch notes ("What's New") ────────────────────────
// Shown once to each registered user on their first message/tap after this
// string changes. Bump TG_PATCH_VERSION (any short human-readable tag — a date
// or "v3") whenever you want to announce something; edit TG_PATCH_NOTES to match.
// Per-user "seen" state lives in the TgUsers.patchSeen column. Plain text only
// (tgSend sends no parse_mode) — no *markdown*, just emoji + newlines like TG_PROCEDURE.
var TG_PATCH_VERSION = "2026-07-02";
var TG_PATCH_NOTES =
  "🆕 What's New\n\n" +
  "This bot walks you through reporting sick the right way so you don't miss cut-offs or forget to tell your SC.\n\n" +
  "• Tap 📋 Report Sick to log a report — I'll ask your reason + clinic and ping your Section Commander for you.\n" +
  "• After the doctor, tap “Submit MC” to send your status, days, and a photo of the MC slip.\n" +
  "• Tap ℹ️ RSO Procedure any time for the full steps and cut-off rules.\n" +
  "• Useful commands: /reportsick, /procedure, /whoami, /cancel.\n\n" +
  "Send /start to open the menu.";

// ─── Telegram transport ────────────────────────────────

function tgProp(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function tgApi(method, payload) {
  var token = tgProp("TG_BOT_TOKEN");
  if (!token) { Logger.log("Telegram: TG_BOT_TOKEN not set"); return null; }
  try {
    var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return JSON.parse(res.getContentText());
  } catch (e) {
    Logger.log("Telegram api " + method + " error: " + e);
    return null;
  }
}

function tgSend(chatId, text, markup, entities) {
  var p = { chat_id: chatId, text: text, disable_web_page_preview: true };
  if (markup) p.reply_markup = markup;
  if (entities && entities.length) p.entities = entities;
  return tgApi("sendMessage", p);
}

function tgAnswer(callbackId, text) {
  tgApi("answerCallbackQuery", { callback_query_id: callbackId, text: text || "" });
}

function kb(rows) { return { inline_keyboard: rows }; }
function btn(text, data) { return { text: text, callback_data: data }; }

// Removes the inline keyboard from a message once a button has been used, so
// it can't be tapped again (defence against double-taps during slow processing).
function tgStripKeyboard(cb) {
  if (cb && cb.message) {
    tgApi("editMessageReplyMarkup", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  }
}

// Downloads a Telegram photo and saves it to a Drive folder; returns the file URL.
function tgSavePhoto(fileId, name) {
  var token = tgProp("TG_BOT_TOKEN");
  var info = tgApi("getFile", { file_id: fileId });
  if (!info || !info.ok) return "";
  try {
    var path = info.result.file_path;
    var blob = UrlFetchApp.fetch("https://api.telegram.org/file/bot" + token + "/" + path,
      { muteHttpExceptions: true }).getBlob();
    blob.setName(name || "MC.jpg");
    var folder = tgMcFolder();
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (e) {
    Logger.log("tgSavePhoto error: " + e);
    return "";
  }
}

function tgMcFolder() {
  var id = tgProp("TG_MC_FOLDER_ID");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
  var folder = DriveApp.createFolder("Cougar MC Submissions");
  PropertiesService.getScriptProperties().setProperty("TG_MC_FOLDER_ID", folder.getId());
  return folder;
}

// ─── Setup helpers (run from the editor) ───────────────

function setTelegramSecrets(token, secret) {
  var p = PropertiesService.getScriptProperties();
  if (token) p.setProperty("TG_BOT_TOKEN", token);
  if (secret) p.setProperty("TG_WEBHOOK_SECRET", secret);
  Logger.log("Stored. token length " + (token ? token.length : "unchanged") + ", secret " + (secret ? "set" : "unchanged"));
}

function setTelegramWebhook() {
  var token = tgProp("TG_BOT_TOKEN"), secret = tgProp("TG_WEBHOOK_SECRET");
  if (!token || !secret) { Logger.log("Run setTelegramSecrets(token, secret) first."); return; }
  var url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log("Deploy as a web app first, then re-run."); return; }
  // getUrl() often returns the editor-only /dev endpoint, which Telegram can't
  // reach (it requires the developer to be logged in). The public webhook must
  // hit the deployed /exec URL. If you ever need to override, paste your
  // Manage-deployments /exec URL into TG_EXEC_URL via setTelegramExecUrl().
  var override = tgProp("TG_EXEC_URL");
  if (override) url = override;
  else url = url.replace(/\/dev$/, "/exec");
  var hookUrl = url + (url.indexOf("?") === -1 ? "?" : "&") + "tgsecret=" + encodeURIComponent(secret);
  var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ url: hookUrl, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
    muteHttpExceptions: true
  });
  Logger.log("setWebhook → " + res.getContentText());
}

// Pin the public /exec URL the webhook should use (copy from Deploy →
// Manage deployments → Web app URL — it ends in /exec). Run once, then
// re-run setTelegramWebhook().
function setTelegramExecUrl(execUrl) {
  PropertiesService.getScriptProperties().setProperty("TG_EXEC_URL", execUrl);
  Logger.log("Stored exec URL: " + execUrl);
}

function getTelegramWebhookInfo() {
  var token = tgProp("TG_BOT_TOKEN");
  if (!token) { Logger.log("No token."); return "(no token)"; }
  var txt = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/getWebhookInfo", { muteHttpExceptions: true }).getContentText();
  Logger.log(txt);
  return txt;
}

function deleteTelegramWebhook() {
  var token = tgProp("TG_BOT_TOKEN");
  if (!token) { Logger.log("No token."); return; }
  Logger.log(UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/deleteWebhook?drop_pending_updates=true", { muteHttpExceptions: true }).getContentText());
}

// ─── POLLING MODE (recommended — avoids the Apps Script 302 webhook issue) ──
//
// Apps Script web apps answer with a 302 redirect, which Telegram rejects
// ("Wrong response 302") and then retry-storms. Polling with getUpdates has
// none of that. startTelegramPolling() deletes the webhook and installs a
// 1-minute trigger that runs tgPoll(); tgPoll long-polls for up to ~5 min so
// replies are effectively real-time, and a script lock keeps only one poller
// alive at a time.

function startTelegramPolling() {
  deleteTelegramWebhook();   // getUpdates 409s if a webhook is still set
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "tgPoll") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("tgPoll").timeBased().everyMinutes(1).create();
  Logger.log("Polling started: webhook removed + 1-min trigger installed. Now run tgPoll() once to begin immediately.");
}

function stopTelegramPolling() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "tgPoll") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Polling stopped (tgPoll triggers removed).");
}

// Run this to see whether polling is currently ON. Check View → Logs after running.
function tgPollingStatus() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "tgPoll") n++;
  });
  var offset = PropertiesService.getScriptProperties().getProperty("TG_OFFSET");
  Logger.log("Polling is " + (n > 0 ? "ON ✅" : "OFF ❌") + " (" + n + " tgPoll trigger(s) installed).");
  Logger.log("TG_OFFSET (last acked update + 1): " + (offset || "(none yet)"));
  Logger.log("Webhook (the \"url\" field should be EMPTY when polling): " + getTelegramWebhookInfo());
  return n > 0;
}

function tgPoll() {
  var token = tgProp("TG_BOT_TOKEN");
  if (!token) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return;   // another poller is already running
  try {
    var start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {     // stay under the 6-min cap
      var offset = Number(PropertiesService.getScriptProperties().getProperty("TG_OFFSET") || 0);
      var url = "https://api.telegram.org/bot" + token + "/getUpdates?timeout=50" +
        "&allowed_updates=" + encodeURIComponent('["message","callback_query"]') +
        (offset ? "&offset=" + offset : "");
      var res, data;
      try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); data = JSON.parse(res.getContentText()); }
      catch (e) { Utilities.sleep(1500); continue; }
      if (!data || !data.ok) { Utilities.sleep(1500); continue; }
      var updates = data.result || [];
      for (var i = 0; i < updates.length; i++) {
        var u = updates[i];
        try { handleTelegramUpdate(u); }
        catch (err) { Logger.log("tgPoll handle error: " + err + (err && err.stack ? "\n" + err.stack : "")); }
        // Advancing the offset past this update_id acks it server-side, so
        // Telegram never resends it — no dedupe needed, no 302.
        PropertiesService.getScriptProperties().setProperty("TG_OFFSET", String(u.update_id + 1));
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// Diagnostic / reset: clears the dedupe marker + all in-progress conversation
// state. Run from the editor if the bot gets wedged. Also logs the current
// dedupe marker so you can see what it thinks the last update_id was.
function tgResetBot() {
  var props = PropertiesService.getScriptProperties();
  Logger.log("TG_LAST_UPDATE was: " + props.getProperty("TG_LAST_UPDATE"));
  props.deleteProperty("TG_LAST_UPDATE");
  var all = props.getProperties();
  var cleared = 0;
  for (var k in all) { if (k.indexOf("tg:state:") === 0) { props.deleteProperty(k); cleared++; } }
  Logger.log("Reset done. Cleared dedupe marker + " + cleared + " conversation state(s).");
}

function setupBotTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  function ensure(name, headers, seed) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
      sh.setFrozenRows(1);
      if (seed) sh.getRange(2, 1, 1, headers.length).setValues([headers.map(function (h) {
        return seed[h] !== undefined ? seed[h] : "";
      })]);
    }
  }
  ensure("TgUsers", ["id", "chatId", "userId", "username", "d4", "name", "role", "sectionsOwned", "registeredAt", "patchSeen"]);
  ensure("ReportSick", ["id", "d4", "name", "plt", "sect", "context", "reason", "clinic", "reportedAt", "cutoffAt", "bookInAt", "status", "startDate", "endDate", "mcUrl", "state", "notifiedSC"]);
  ensure("Config", ["botGroupChatId", "nextBookInDate", "nextBookInTime", "outOfCamp", "cutoffHours", "rsoFormUrl"], { cutoffHours: 4, outOfCamp: "FALSE" });
  Logger.log("Bot tabs ready: TgUsers, ReportSick, Config");
}

// ─── Small utilities ───────────────────────────────────

function tgPadD4(v) {
  var s = String(v == null ? "" : v).trim().toUpperCase();
  if (s.charAt(0) === "C") s = s.slice(1);
  s = s.replace(/[^0-9]/g, "");
  while (s.length > 0 && s.length < 4) s = "0" + s;
  return s;
}

function tgTruthy(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "y";
}

function tgNorm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim(); }

function tgNameMatches(rosterName, typed) {
  var a = tgNorm(rosterName), b = tgNorm(typed);
  if (!a || !b) return false;
  if (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
  var ta = a.split(" "), tb = b.split(" "), overlap = 0;
  ta.forEach(function (t) { if (t.length >= 3 && tb.indexOf(t) !== -1) overlap++; });
  return overlap >= 2;
}

function tgAddDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function tgDisplayDate(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd MMM yyyy"); }
function tgHHMM(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "HHmm") + "hrs"; }
function tgDateTimeLabel(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "EEE dd MMM, HHmm") + "hrs"; }

function tgParseDisplayDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  var months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var parts = String(dateStr).trim().split(/\s+/);   // "12 Jul 2026"
  if (parts.length < 3) return null;
  var day = parseInt(parts[0], 10);
  var mon = months[parts[1].slice(0, 3).toLowerCase()];
  var year = parseInt(parts[2], 10);
  if (isNaN(day) || mon == null || isNaN(year)) return null;
  var digits = String(timeStr == null ? "0000" : timeStr).replace(/[^0-9]/g, "");
  if (digits.length === 3) digits = "0" + digits;
  if (digits.length < 4) digits = "0000";
  return new Date(year, mon, day, parseInt(digits.slice(0, 2), 10), parseInt(digits.slice(2, 4), 10), 0);
}

// ─── Config + cut-off ──────────────────────────────────

function tgReadConfig() {
  var rows = readTab("Config");
  if (rows.error || !rows.length) return {};
  return rows[0];
}

function tgComputeCutoff(cfg) {
  var bookIn = tgParseDisplayDateTime(cfg.nextBookInDate, cfg.nextBookInTime);
  var hours = parseFloat(cfg.cutoffHours) || 4;
  var out = { outOfCamp: tgTruthy(cfg.outOfCamp), bookIn: bookIn, cutoff: null, tooLate: false, hours: hours };
  if (bookIn) {
    out.cutoff = new Date(bookIn.getTime() - hours * 3600 * 1000);
    out.tooLate = new Date() > out.cutoff;
  }
  return out;
}

// ─── Identity ──────────────────────────────────────────

function tgFindUser(chatId) {
  var rows = readTab("TgUsers");
  if (rows.error) return null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(chatId) || String(rows[i].chatId) === String(chatId)) {
      var u = rows[i];
      u.d4 = tgPadD4(u.d4);
      u.plt = u.d4.charAt(0);
      u.sect = u.d4.charAt(1);
      return u;
    }
  }
  return null;
}

function tgUpsertUser(u) { return upsertRow("TgUsers", u); }

// Returns the TgUsers row that already claims this 4D on a DIFFERENT chat, else null.
// This is what stops anyone from registering as someone they aren't: a 4D can only be
// linked to one Telegram account, and a second account can't silently take it over.
function tg4dClaimedByOther(d4, chatId) {
  var rows = readTab("TgUsers");
  if (!rows || rows.error) return null;
  for (var i = 0; i < rows.length; i++) {
    if (tgPadD4(rows[i].d4) === d4 && String(rows[i].id) !== String(chatId)) return rows[i];
  }
  return null;
}

// Finalise a registration the recruit has explicitly confirmed is them.
function tgConfirmRegistration(chatId) {
  var state = tgGetState(chatId);
  var d = state && state.draft;
  if (!d || state.step !== "reg_confirm") { tgStartRegistration(chatId); return; }

  var other = tg4dClaimedByOther(d.d4, chatId);
  if (other) {
    tgClearState(chatId);
    tgSend(chatId, "⚠️ 4D " + d.d4 + " is already linked to another Telegram account" +
      (other.name ? " (" + other.name + ")" : "") + ".\n\nIf this is genuinely you, ask your COS/SC to remove the old link first — this is how we stop anyone registering as someone they're not. Then /start again.");
    return;
  }

  var u = {
    id: chatId, chatId: chatId, userId: d.userId || "", username: d.username || "",
    d4: d.d4, name: d.name, role: d.role, rank: d.rank || "",
    sectionsOwned: "", registeredAt: new Date().toISOString()
  };
  tgUpsertUser(u);
  if (d.role === "Commander") {
    tgSetState(chatId, { step: "reg_sections" });
    tgSend(chatId, "You're a commander ✅. Which section(s) do you command? e.g. P1S3 (comma-separate for multiple).");
  } else {
    tgClearState(chatId);
    tgSendMenu(chatId, "✅ Registered: REC " + d.name + " (C" + d.d4 + "), Platoon " + d.d4.charAt(0) + " Section " + d.d4.charAt(1) + ".\nWhenever you feel unwell, tap below or type /reportsick.");
  }
}

// Restart registration for this chat (frees its own link first; can't claim another's 4D).
function tgDoReRegister(chatId) {
  try { deleteRowById("TgUsers", chatId); } catch (e) {}
  tgClearState(chatId);
  tgStartRegistration(chatId);
}

function tgRosterLookup(d4) {
  var rows = readTab("Roster");
  if (rows.error) return null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rid = tgPadD4(r["4d"] != null && r["4d"] !== "" ? r["4d"] : r.id);
    if (rid === d4) {
      return {
        name: String(r.name || "").trim(),
        role: String(r.role || "Recruit").trim() || "Recruit",
        rank: String(r.rank || "").trim()
      };
    }
  }
  return null;
}

// Returns ALL commanders who own this section (a section can have more than one).
function tgFindSectionCmds(plt, sect) {
  var key = ("P" + plt + "S" + sect).toUpperCase();
  var out = [];
  var rows = readTab("TgUsers");
  if (!rows || rows.error) return out;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.role) === "Commander" && r.sectionsOwned) {
      var owned = String(r.sectionsOwned).toUpperCase().split(/[,\s]+/);
      if (owned.indexOf(key) !== -1) out.push(r);
    }
  }
  return out;
}

function tgRN(user) {
  if (user.role === "Commander") return (user.rank ? user.rank + " " : "") + user.name;
  return "REC " + user.name + " (C" + tgPadD4(user.d4) + ")";
}

// ─── Group notify (with @mention of the SC) ────────────

// Posts to the commanders' group. If photoFileId is given, the message is sent
// as that photo with the text as its caption (so the MC image shows inline
// instead of a Drive link). `scs` may be a single commander or an array — every
// one is @mentioned via a text_mention entity (a section can have multiple SCs).
function tgGroupNotify(text, scs, photoFileId) {
  var cfg = tgReadConfig();
  var gid = cfg.botGroupChatId;
  if (!gid) return;
  if (scs && !Array.isArray(scs)) scs = [scs];
  scs = (scs || []).filter(Boolean);
  var full = text + "\n", entities = [];
  if (scs.length) {
    full += "SC: ";
    for (var i = 0; i < scs.length; i++) {
      var sc = scs[i];
      if (i > 0) full += ", ";
      if (sc.userId) {
        var offset = full.length;        // UTF-16 code units — what Telegram expects
        var nm = sc.name || "SC";
        full += nm;
        entities.push({ type: "text_mention", offset: offset, length: nm.length, user: { id: Number(sc.userId) } });
      } else if (sc.username) {
        full += "@" + String(sc.username).replace(/^@/, "");
      } else {
        full += (sc.name || "SC") + " (not on bot)";
      }
    }
    full += "  ← please acknowledge";
  } else {
    full += "(section commander not registered — please acknowledge)";
  }
  if (photoFileId) {
    var p = { chat_id: gid, photo: photoFileId, caption: full };
    if (entities.length) p.caption_entities = entities;
    var r = tgApi("sendPhoto", p);
    if (r && r.ok) return;
    // Photo send failed (e.g. file_id expired) — fall back to a text message.
  }
  tgSend(gid, full, null, entities);
}

// ─── Conversation state (per chat, in ScriptProperties) ─

function tgStateKey(chatId) { return "tg:state:" + chatId; }
function tgGetState(chatId) { var s = tgProp(tgStateKey(chatId)); if (!s) return {}; try { return JSON.parse(s); } catch (e) { return {}; } }
function tgSetState(chatId, obj) { PropertiesService.getScriptProperties().setProperty(tgStateKey(chatId), JSON.stringify(obj)); }
function tgClearState(chatId) { PropertiesService.getScriptProperties().deleteProperty(tgStateKey(chatId)); }

// ─── Webhook entry + dispatch ──────────────────────────

function handleTelegramWebhook(e) {
  try {
    var secret = tgProp("TG_WEBHOOK_SECRET");
    if (!secret || e.parameter.tgsecret !== secret) return ContentService.createTextOutput("");
    var update = JSON.parse(e.postData.contents);

    // Telegram delivers AT LEAST ONCE — because Apps Script answers via a 302
    // redirect, Telegram sometimes resends the same update, which would replay
    // the same reply (e.g. the welcome message). Dedupe by update_id under a
    // script lock so each update is processed exactly once.
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (le) { return ContentService.createTextOutput(""); }
    try {
      var uid = update.update_id;
      var last = Number(tgProp("TG_LAST_UPDATE") || 0);
      if (uid == null || uid > last) {
        if (uid != null) PropertiesService.getScriptProperties().setProperty("TG_LAST_UPDATE", String(uid));
        handleTelegramUpdate(update);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log("Telegram webhook error: " + err + (err && err.stack ? "\n" + err.stack : ""));
  }
  return ContentService.createTextOutput("");   // always 200 so Telegram doesn't retry-storm
}

function handleTelegramUpdate(update) {
  if (update.callback_query) { tgHandleCallback(update.callback_query); return; }
  if (update.message) { tgHandleMessage(update.message); return; }
}

// If this registered user hasn't seen the current patch notes, send them once
// and stamp their row. Called after the user is resolved in both handlers, so it
// catches a first message OR a first button tap after a patch. Sends an extra
// message and returns — normal dispatch continues, so it never swallows the
// user's action or interrupts an in-flight report-sick flow.
function tgMaybePatchNotes(user) {
  if (!user) return;                                   // mid-registration: no row yet, skip
  if (String(user.patchSeen || "") === TG_PATCH_VERSION) return;
  tgSend(user.chatId, TG_PATCH_NOTES);
  user.patchSeen = TG_PATCH_VERSION;
  try { tgUpsertUser(user); } catch (e) { Logger.log("tgMaybePatchNotes upsert error: " + e); }
}

function tgHandleMessage(msg) {
  var chatId = msg.chat.id;

  // Group/supergroup: only respond to /here (so the COS can grab the chat id).
  if (msg.chat.type !== "private") {
    if ((msg.text || "").indexOf("/here") === 0) {
      tgSend(chatId, "This chat's ID: " + chatId + "\nPaste it into the Config tab → botGroupChatId.");
    }
    return;
  }

  var text = (msg.text || "").trim();
  var user = tgFindUser(chatId);
  var state = tgGetState(chatId);

  tgMaybePatchNotes(user);   // show "What's New" once per patch, then continue normally

  // Global commands (work in any state).
  if (text === "/cancel") { tgClearState(chatId); tgSendMenu(chatId, "Cancelled. What would you like to do?"); return; }
  if (text === "/start") {
    if (user) tgSendMenu(chatId, "Welcome back, " + (user.role === "Commander" ? user.name : ("REC " + user.name)) + ".");
    else tgStartRegistration(chatId);
    return;
  }
  if (text === "/help" || text === "/procedure") { tgSend(chatId, TG_PROCEDURE); return; }
  if (text === "/whoami") {
    if (!user) { tgSend(chatId, "You're not registered yet. Send /start."); return; }
    var wd4 = tgPadD4(user.d4);
    tgSend(chatId, "You're registered as " + tgRN(user) +
      (user.role === "Commander" ? "" : " · Platoon " + wd4.charAt(0) + " Section " + wd4.charAt(1)) + ".",
      kb([[btn("🔄 Not me — re-register", "reg:again")]]));
    return;
  }
  if (text === "/register") { tgDoReRegister(chatId); return; }
  if (text === "/reportsick" || text === "/report") {
    if (!user) { tgSend(chatId, "Please /start to register first."); return; }
    tgBeginReportSick(chatId, user);
    return;
  }

  // Registration flow (user not yet linked).
  if (!user) {
    if (state.step === "reg_d4") {
      var d4 = tgPadD4(text);
      if (d4.length !== 4) { tgSend(chatId, "That doesn't look like a 4D number. Send 4 digits, e.g. 1311."); return; }
      state.d4 = d4; state.step = "reg_name"; tgSetState(chatId, state);
      tgSend(chatId, "And your full name as in the system?");
      return;
    }
    if (state.step === "reg_name") {
      var match = tgRosterLookup(state.d4);
      if (!match) { tgClearState(chatId); tgSend(chatId, "❌ 4D " + state.d4 + " isn't in the system. Check with your SC, then /start again."); return; }
      if (!tgNameMatches(match.name, text)) {
        state.tries = (state.tries || 0) + 1;
        if (state.tries >= 3) { tgClearState(chatId); tgSend(chatId, "❌ Name didn't match after 3 tries. Please check with your SC, then /start again."); }
        else { tgSetState(chatId, state); tgSend(chatId, "❌ That name doesn't match 4D " + state.d4 + ". Type your full name as in your 11B."); }
        return;
      }
      var role = match.role || "Recruit";
      // Confirm before saving, so a wrong 4D/name is caught up front.
      state.step = "reg_confirm";
      state.draft = {
        d4: state.d4, name: match.name, role: role, rank: match.rank || "",
        userId: (msg.from && msg.from.id) || "", username: (msg.from && msg.from.username) || ""
      };
      tgSetState(chatId, state);
      var who = role === "Commander"
        ? ((match.rank ? match.rank + " " : "") + match.name)
        : ("REC " + match.name + " (C" + state.d4 + ")");
      tgSend(chatId, "Please confirm — you're registering as:\n\n" + who +
        "\nPlatoon " + state.d4.charAt(0) + " Section " + state.d4.charAt(1) + "\n\nIs this you?",
        kb([[btn("✅ Yes, that's me", "reg:confirm")], [btn("🔄 No, re-enter", "reg:redo")]]));
      return;
    }
    if (state.step === "reg_confirm") { tgSend(chatId, "Please tap ✅ Yes or 🔄 No above to finish registering."); return; }
    tgSend(chatId, "Please /start to register first.");
    return;
  }

  // MC photo upload.
  if (state.step === "mc_photo") {
    if (msg.photo && msg.photo.length) { tgPhotoReceived(chatId, state, msg.photo[msg.photo.length - 1].file_id); return; }
    if (msg.document && String(msg.document.mime_type || "").indexOf("image") === 0) { tgPhotoReceived(chatId, state, msg.document.file_id); return; }
    tgSend(chatId, "Please upload a PHOTO of your MC / status slip 📷 (or /cancel).");
    return;
  }

  // Stateful free-text steps.
  switch (state.step) {
    case "reg_sections": {
      var owned = text.toUpperCase().replace(/[^0-9PS,\s]/g, "").replace(/\s+/g, "").trim();
      var cu = tgFindUser(chatId); cu.sectionsOwned = owned; tgUpsertUser(cu); tgClearState(chatId);
      tgSendMenu(chatId, "✅ Registered as commander for: " + owned + "\nYou'll be pinged in the group when your recruits report sick.");
      return;
    }
    case "rs_reason":
      if (!text) { tgSend(chatId, "✍️ Please TYPE your reason as a text message below (e.g. “Fever and sore throat”), or tap ✖️ Cancel.", kb([[btn("✖️ Cancel report sick", "rs:cancel")]])); return; }
      state.reason = text; tgSetState(chatId, state);
      if (state.context === "OutOfCamp") { state.step = "rs_clinic"; tgSetState(chatId, state); tgSend(chatId, "✍️ Which clinic / polyclinic / hospital will you go to? Type it below (e.g. “Healthway Medical, Yishun”).", kb([[btn("✖️ Cancel report sick", "rs:cancel")]])); }
      else tgAskSC(chatId, state, user);
      return;
    case "rs_clinic":
      if (!text) { tgSend(chatId, "✍️ Please TYPE the clinic / hospital name as a text message below, or tap ✖️ Cancel.", kb([[btn("✖️ Cancel report sick", "rs:cancel")]])); return; }
      state.clinic = text; tgSetState(chatId, state); tgAskSC(chatId, state, user);
      return;
    default:
      // User typed text during a button-only step — guide them back to the right
      // action instead of capturing the text into the wrong field or dumping them out.
      if (state.step === "rs_confirm")
        return void tgSend(chatId, "👆 Please tap a button above to continue, or ✖️ Cancel.", kb([[btn("✖️ Cancel report sick", "rs:cancel")]]));
      if (state.step === "rs_sc")
        return void tgSend(chatId, "👆 Don't type it here. After you've actually WhatsApp'd your SC, tap “✅ I have messaged my SC on WhatsApp” above.", kb([[btn("✖️ Cancel report sick", "rs:cancel")]]));
      if (state.step === "post_request")
        return void tgSend(chatId, "👆 When you have your status, tap “📄 Submit MC / status” above.\nEven if the doctor gave you NO status, still tap it.", kb([[btn("📄 Submit MC / status", "rs:submitmc")]]));
      if (state.step === "mc_photo")
        return void tgSend(chatId, "📷 Please UPLOAD a photo of your MC / status slip — don't type it.\nNo status? Tap the button below.", kb([[btn("🚫 No status given (nothing to upload)", "mc:nostatus")], [btn("✖️ Cancel", "rs:cancel")]]));
      if (state.step === "mc_saving")
        return void tgSend(chatId, "⏳ Still saving your last MC — hang on a moment.");
      if (state.step === "toolate")
        return void tgSend(chatId, "👆 Please tap one of the options above.");
      tgSendMenu(chatId, "Tap an option, or type /reportsick.");
      return;
  }
}

function tgHandleCallback(cb) {
  tgAnswer(cb.id);
  if (!cb.message || cb.message.chat.type !== "private") return;
  var chatId = cb.message.chat.id;
  var data = cb.data || "";
  var user = tgFindUser(chatId);
  var state = tgGetState(chatId);

  // Registration callbacks — must work before a TgUsers row exists.
  if (data === "reg:confirm") { tgStripKeyboard(cb); tgConfirmRegistration(chatId); return; }
  if (data === "reg:redo" || data === "reg:again") { tgStripKeyboard(cb); tgDoReRegister(chatId); return; }

  if (!user) { tgSend(chatId, "Please /start to register first."); return; }

  tgMaybePatchNotes(user);   // show "What's New" once per patch, then continue normally

  var step = state.step;

  if (data === "info") { tgSend(chatId, TG_PROCEDURE); return; }
  if (data === "rs:begin") { tgBeginReportSick(chatId, user); return; }
  if (data === "rs:cancel") { tgClearState(chatId); tgStripKeyboard(cb); tgSendMenu(chatId, "Cancelled. What would you like to do?"); return; }

  if (data === "rs:start" || data === "incamp:continue") {
    if (step !== "rs_confirm") return;                       // already past this step — ignore repeat taps
    tgStripKeyboard(cb);
    tgAskReason(chatId, state);
    return;
  }

  if (data === "toolate:tellsc") {
    if (step !== "toolate") return;                          // one-shot
    tgSetState(chatId, { step: "toolate_done" });            // claim immediately so a repeat tap is a no-op
    tgStripKeyboard(cb);
    var sc0 = tgFindSectionCmds(user.plt, user.sect);
    tgGroupNotify("⚠️ FEELING UNWELL (past report-sick cut-off) — " + tgRN(user) + " · P" + user.plt + " S" + user.sect + "\nWill report sick in camp at next book-in.", sc0);
    tgSend(chatId, "📨 Your SC has been notified. Book in as normal and report sick at first parade.");
    tgClearState(chatId);
    tgSendMenu(chatId, "What would you like to do?");
    return;
  }

  if (data === "sc:informed") {
    if (step !== "rs_sc") return;                            // already submitted — ignore repeat taps
    state.step = "rs_finalizing"; tgSetState(chatId, state); // claim immediately
    tgStripKeyboard(cb);
    tgFinalizeRequest(chatId, user, state, true);            // SC is pinged regardless
    return;
  }

  if (data === "rs:submitmc") {
    if (step !== "post_request") return;   // only valid right after a finalized request — ignore stale taps
    tgStripKeyboard(cb);
    tgAskMCPhoto(chatId, state);
    return;
  }

  if (data === "mc:nostatus") {
    if (step !== "mc_photo") return;
    tgStripKeyboard(cb);
    tgCompleteNoStatus(chatId, state);
    return;
  }

}

// ─── Flows ─────────────────────────────────────────────

function tgSendMenu(chatId, text) {
  tgSend(chatId, text || "What would you like to do?", kb([[btn("📋 Report Sick", "rs:begin")], [btn("ℹ️ RSO Procedure", "info")]]));
}

function tgStartRegistration(chatId) {
  tgSetState(chatId, { step: "reg_d4", tries: 0 });
  tgSend(chatId, "👋 Welcome to the Cougar Report-Sick bot. This helps you report sick the right way and notifies your commander automatically.\n\nFirst, let's verify who you are. What's your 4D number? (e.g. 1311)");
}

function tgBeginReportSick(chatId, user) {
  var cfg = tgReadConfig();
  var cc = tgComputeCutoff(cfg);

  if (cc.outOfCamp) {
    if (cc.bookIn && cc.tooLate) {
      tgSetState(chatId, { step: "toolate" });
      tgSend(chatId,
        "⚠️ It's now " + tgHHMM(new Date()) + ". Your status/MC had to be SUBMITTED by " + tgHHMM(cc.cutoff) +
        " (" + cc.hours + "h before book-in at " + tgHHMM(cc.bookIn) + ") — and there's no longer enough time to see a doctor and submit it before then.\n\n" +
        "❌ You can no longer report sick outside for this book-in.\n\n" +
        "What to do instead:\n" +
        "• Book in as normal.\n" +
        "• Report sick IN CAMP at first parade — inform your duty commander on arrival.\n" +
        "• Real emergency? Go to A&E now and message your SC immediately.",
        kb([[btn("📨 Tell my SC I'm unwell", "toolate:tellsc")], [btn("ℹ️ RSO Procedure", "info")]]));
      return;
    }
    var msg = "You're currently OUT OF CAMP (booked out).\n";
    if (cc.bookIn) msg += "📅 Next book-in: " + tgDateTimeLabel(cc.bookIn) + "\n⏰ Your status/MC must be SUBMITTED by " + tgHHMM(cc.cutoff) + " (" + cc.hours + "h before book-in). See the doctor and send it here before then — start now, don't wait. ✅\n\n";
    else msg += "⏰ Book-in time not set by COS yet — proceed, but confirm timings with your SC.\n\n";
    msg += "Before you see a doctor, take note (GOM rules while on MC):\n" +
      "• Rest at home for the FULL duration, including off-hours.\n" +
      "• ❌ No overseas travel, no clubbing/drinking, no strenuous activity/sports.\n" +
      "• You may leave home ONLY to buy takeaway, buy meds, or see a doctor — tell your commander.\n\n" +
      "Ready to log your report-sick request?";
    tgSetState(chatId, { step: "rs_confirm", context: "OutOfCamp" });
    tgSend(chatId, msg, kb([[btn("✅ Yes, start", "rs:start")], [btn("Cancel", "rs:cancel")]]));
  } else {
    tgSetState(chatId, { step: "rs_confirm", context: "InCamp" });
    tgSend(chatId,
      "You're IN CAMP. To report sick here:\n" +
      "1️⃣ Inform your duty commander now.\n" +
      "2️⃣ Sign the Report-Sick book at the COS office.\n" +
      "3️⃣ Complete this form so it's logged + your SC is pinged.",
      kb([[btn("✅ Done 1 & 2, continue", "incamp:continue")], [btn("Cancel", "rs:cancel")]]));
  }
}

function tgAskReason(chatId, state) {
  state.step = "rs_reason"; tgSetState(chatId, state);
  tgSend(chatId, "✍️ What's wrong? Type a short reason below (e.g. “Fever and sore throat”) — this goes to your commander.",
    kb([[btn("✖️ Cancel report sick", "rs:cancel")]]));
}

function tgAskSC(chatId, state, user) {
  state.step = "rs_sc"; tgSetState(chatId, state);
  var scs = tgFindSectionCmds(user.plt, user.sect);
  var scName = scs.length ? scs.map(function (s) { return s.name; }).join(" / ") : "your Section Commander";
  tgSend(chatId, "🛑 STOP. DO NOT report sick until you have personally messaged " + scName + " on WhatsApp.\n\n" +
    "This is NOT optional. You MUST tell " + scName + " directly that you are reporting sick — BEFORE you go anywhere.\n\n" + 
    "Only tap below AFTER you have actually sent that WhatsApp message:",
    kb([[btn("✅ I have messaged my SC on WhatsApp", "sc:informed")], [btn("✖️ Cancel report sick", "rs:cancel")]]));
}

function tgFinalizeRequest(chatId, user, state, informed) {
  var cfg = tgReadConfig();
  var cc = tgComputeCutoff(cfg);
  var now = new Date();
  var rsId = Date.now();
  var row = {
    id: rsId, d4: user.d4, name: user.name, plt: user.plt, sect: user.sect,
    context: state.context || "", reason: state.reason || "", clinic: state.clinic || "",
    reportedAt: Utilities.formatDate(now, Session.getScriptTimeZone(), "dd MMM yyyy HHmm"),
    cutoffAt: cc.cutoff ? tgHHMM(cc.cutoff) : "", bookInAt: cc.bookIn ? tgDateTimeLabel(cc.bookIn) : "",
    status: "", startDate: "", endDate: "", mcUrl: "", state: "Requested",
    notifiedSC: informed ? "informed" : "pinged"
  };
  upsertRow("ReportSick", row);

  var sc = tgFindSectionCmds(user.plt, user.sect);
  var gtext = "🤒 REPORT SICK — " + tgRN(user) + " · P" + user.plt + " S" + user.sect + "\n" +
    "Context: " + (state.context === "InCamp" ? "In camp" : "Out of camp") + "\n" +
    "Reason: " + (state.reason || "-") +
    (state.clinic ? ("\nClinic: " + state.clinic) : "") + "\n" +
    "Reported: " + row.reportedAt + (cc.cutoff ? (" · Cut-off " + tgHHMM(cc.cutoff)) : "") + "\n" +
    "(recruit confirms he has messaged his SC on WhatsApp — please acknowledge)";
  tgGroupNotify(gtext, sc);

  state.step = "post_request"; state.rsId = rsId; tgSetState(chatId, state);
  var ack = "📨 Logged" + (cfg.botGroupChatId ? " and your SC has been notified in the commanders' group." : ".") + "\n";
  ack += state.context === "InCamp"
    ? "Head to the Medical Centre. After you've seen the MO, tap “Submit MC” below."
    : ("Now go see the doctor. AFTER you've seen the MO, come back and tap “Submit MC” below" + (cc.cutoff ? (" — your status/MC must be submitted by " + tgHHMM(cc.cutoff) + " (4h before book-in). Don't leave it to the last minute.") : "."));
  ack += "\n\n⚠️ Even if the doctor gives you NO status, you must STILL tap “Submit MC” — there's a “No status given” option on the next screen.";
  tgSend(chatId, ack, kb([[btn("📄 Submit MC / status", "rs:submitmc")]]));
}

function tgAskMCPhoto(chatId, state) {
  state.step = "mc_photo"; tgSetState(chatId, state);
  tgSend(chatId, "Upload a clear PHOTO of your MC / status slip 📷\n\nYour commander will read the status and duration straight off the slip — no need to type them in.",
    kb([[btn("🚫 No status given (nothing to upload)", "mc:nostatus")], [btn("✖️ Cancel", "rs:cancel")]]));
}

function tgPhotoReceived(chatId, state, fileId) {
  // Claim the step immediately so a duplicate photo / retry can't double-process,
  // and give instant feedback before the (slower) Drive save + group post.
  state.step = "mc_saving"; tgSetState(chatId, state);
  tgSend(chatId, "📷 Got your MC — saving and notifying your commanders…");
  var url = "";
  try { url = tgSavePhoto(fileId, "MC_" + (state && state.rsId ? state.rsId : Date.now()) + ".jpg"); }
  catch (e) { Logger.log("tgPhotoReceived save error: " + e); }
  tgCompleteMC(chatId, state, url, fileId);
}

function tgGetReportSickById(id) {
  var rows = readTab("ReportSick");
  if (rows.error) return null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
  return null;
}

function tgCompleteMC(chatId, state, url, fileId) {
  var user = tgFindUser(chatId);
  if (!user) {
    tgSend(chatId, "⚠️ I couldn't find your registration to log this. Your MC image: " + (url || "(not saved)") + "\nPlease /start to re-register, or tell your SC directly.");
    tgClearState(chatId);
    return;
  }
  var today = tgDisplayDate(new Date());

  try {
    if (state.rsId) {
      var rs = tgGetReportSickById(state.rsId);
      if (rs) {
        // status/startDate/endDate left blank — the COS keys them in from the MC image.
        rs.mcUrl = url || ""; rs.state = "MC-Submitted";
        upsertRow("ReportSick", rs);
      }
    }
    // Append a Medical row so it flows into the dashboard + parade state. Status
    // and dates are left BLANK for the COS to fill in from the MC image — recruits
    // no longer self-declare their status. `location` carries the clinic/hospital
    // captured in the rs_clinic step (out-of-camp only) so report-sick-outside
    // cases show the location in the parade state. Falls back to the ReportSick
    // row's clinic in case the conversation state was trimmed.
    appendRow("Medical", {
      id: Date.now(), d4: user.d4, date: today,
      reason: state.reason || "Reported sick",
      location: state.clinic || (rs && rs.clinic) || "",
      status: "", startDate: "", endDate: ""
    });
    // This write bypasses doPost/withRevLock (it's a server-side bot action), so
    // bump the Medical revision manually — otherwise dashboards' revCheck poll
    // would never see the change and would silently miss the bot-reported sick
    // record until a manual full pull.
    bumpRev("Medical");
  } catch (e) {
    Logger.log("tgCompleteMC sheet error: " + e);
  }

  var sc = tgFindSectionCmds(user.plt, user.sect);
  // Caption (no Drive link — the photo itself is shown in the group). The
  // Drive copy is still kept in ReportSick.mcUrl for the records/dashboard.
  tgGroupNotify(
    "📄 MC SUBMITTED — " + tgRN(user) + " · P" + user.plt + " S" + user.sect + "\n" +
    "Status + duration: read from the MC image below — please record it in the system.", sc, fileId);

  tgSend(chatId, "✅ Received — your MC has been sent to your commanders.\n Get the book in timing from your Commaders, and remember to book in on time once your status ends.");
  tgClearState(chatId);
  tgSendMenu(chatId, "What would you like to do?");
}

function tgCompleteNoStatus(chatId, state) {
  var user = tgFindUser(chatId);
  if (state.rsId) {
    var rs = tgGetReportSickById(state.rsId);
    if (rs) { rs.status = "NIL"; rs.state = "NoStatus"; upsertRow("ReportSick", rs); }
  }
  var sc = tgFindSectionCmds(user.plt, user.sect);
  tgGroupNotify("ℹ️ NO STATUS — " + tgRN(user) + " · P" + user.plt + " S" + user.sect + "\nMO saw him, no status given.", sc);
  tgSend(chatId, "Noted — no status given, you're fit for normal duties. Remember to still book in on time. 💪");
  tgClearState(chatId);
  tgSendMenu(chatId, "What would you like to do?");
}
