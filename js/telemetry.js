// ============================================================================
// Usage telemetry — the collector. See TELEMETRY-DESIGN.md.
//
// Answers two questions with evidence instead of opinion:
//   1. what do people actually open?      → view dwell + feature click counts
//   2. what costs them the most clicks?   → task funnels (clicks, abandonment)
//
// THREE THINGS ABOUT THIS FILE THAT ARE NOT NEGOTIABLE
//
//   * It is a PASSIVE OBSERVER. Every entry point is wrapped so a failure in
//     here is caught, counted once, and swallowed. If telemetry is broken the
//     app must behave exactly as if this file were absent.
//   * It records FUNCTION NAMES, never arguments. This app holds medical
//     records for real soldiers; `openPerson('1101')` is recorded as
//     "openPerson" and nothing else. `scrubName` is the last line of defence
//     and strips any run of 2+ digits from every name before it is stored.
//   * It NEVER touches the sync machinery. No tab is marked dirty, no rev is
//     bumped, no write queue is entered, no error reaches the user. The usage
//     table is outside REV_TABS and outside readAll on purpose — an
//     append-only event stream behind revCheck would make every recorded click
//     wake every other phone in the company for a pull.
//
// LOAD ORDER: this file must be LAST, after every other js/*.js, so the
// globals it wraps already exist. Everything it declares lives on the single
// `TELEMETRY` const — js/*.js share one global scope and a duplicate top-level
// declaration blanks the whole dashboard (CLAUDE.md).
// ============================================================================

const TELEMETRY = (function () {
  "use strict";

  // ── Tunables ──────────────────────────────────────────────────────────────
  const KEY = "cougar-usage-v1";   // own localStorage key, NOT inside cougar-data-v3,
                                   // so a data-cache reset does not wipe the record
  const BUF_CAP = 400;             // raw events kept on the device, oldest pruned first
  const DAY_CAP = 30;              // days of pre-aggregated counters kept
  const ROW_CAP = 400;             // max counter rows in one flush batch
  const FLUSH_MS = 60000;          // timer flush cadence
  const NAME_CAP = 48;             // max characters in any recorded name

  // ── The task registry ─────────────────────────────────────────────────────
  //
  // A task is a named unit of intent with a start and a terminal. These names
  // were taken from js/forms.js as it actually stands, not guessed: every
  // entry below was verified to exist. The registry WILL drift as the app
  // changes, and drift must never break the app — a missing name is skipped
  // with one console warning at load.
  //
  // `start: null` means an instant task: a one-tap action with no funnel, so
  // it is always a completed task of cost 1.
  const TASKS = {
    book_out:        { start: "openBookOutForm",        done: "submitBookOut",        label: "Book Out" },
    book_in:         { start: null,                     done: "markPresentToday",     label: "Book In" },
    undo_book_out:   { start: null,                     done: "undoBookOut",          label: "Undo Book Out" },
    log_leave:       { start: "openLeaveForm",          done: "submitLeave",          label: "Log Leave" },
    appointment:     { start: "openAppointmentForm",    done: "submitAppointment",    label: "Appointment" },
    medical_status:  { start: "openMedicalForm",        done: "submitMedical",        label: "Medical Status" },
    log_conduct:     { start: "openLogConductWizard",   done: "saveLogConductWizard", label: "Log Conduct" },
    attendance:      { start: "openAttendanceForm",     done: "submitAttendance",     label: "Attendance" },
    conduct_detail:  { start: "openConductDetailForm",  done: "submitConductDetail",  label: "Conduct Detail" },
    ippt_entry:      { start: "openIPPTForm",           done: "submitIPPT",           label: "IPPT Entry" },
    report:          { start: "openReportModal",        done: "copyReportToClipboard", label: "Generate Report" },
    parade_compare:  { start: "openCompareModal",       done: "copyCompareSummary",   label: "Compare Parade States" },
    person_lookup:   { start: null,                     done: "openPerson",           label: "Person Lookup" },
    groups:          { start: "openGroupsForm",         done: "submitGroupNames",     label: "Edit Groups" },
    group_members:   { start: "openGroupMembersForm",   done: "submitGroupMembers",   label: "Group Members" },
    combined_group:  { start: "openCombinedForm",       done: "submitCombined",       label: "Combined Group" },
    commander:       { start: "openCommanderForm",      done: "submitCommander",      label: "Add Commander" }
  };

  // Human-readable labels for the views, used by the insights read-out. Keyed
  // by STATE.nav. Anything not listed falls back to the raw nav key.
  const VIEW_LABELS = {
    dashboard: "Dashboard", roster: "Roster", attendance: "Attendance",
    detail: "Conduct Detail", medical: "Medical", ippt: "IPPT",
    leave: "Out / Leave",
    mskAnalytics: "MSK Analytics", conducts: "Conducts", sync: "Sync & I/O",
    usage: "Usage Insights"
  };

  // ── Safety net ────────────────────────────────────────────────────────────
  // Everything the app can reach goes through here. One console line the first
  // time something breaks, silence afterwards, and never a throw into a user's
  // path.
  let _warned = false;
  function safe(fn, fallback) {
    try { return fn(); }
    catch (e) {
      if (!_warned) { _warned = true; try { console.warn("[telemetry] disabled after error:", e); } catch (_) {} }
      return fallback;
    }
  }

  const nowMs = () => Date.now();
  const dayOf = (t) => new Date(t == null ? nowMs() : t).toISOString().slice(0, 10);

  // ── Privacy ───────────────────────────────────────────────────────────────

  // The last line of defence on every recorded name, in two parts.
  //
  // scrubName CLEANS: a 4D is four digits and it is the universal join key, so
  // any run of two or more digits is deleted outright. No handler name in this
  // codebase contains one, so nothing legitimate is lost.
  function scrubName(s) {
    return String(s == null ? "" : s)
      .replace(/\d{2,}/g, "")           // 4D numbers, dates, phone numbers
      .replace(/[^\w:.#$ /-]+/g, " ")   // anything that is not plain identifier-ish
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_CAP);
  }

  // isSafeName ADMITS, and it is an allow-list rather than a deny-list on
  // purpose. Stripping digits defeats a 4D but not a NAME, and in this app
  // "TAN WEI MING" is a perfectly plausible string to find in the DOM. Every
  // legitimate descriptor this file produces — a function name, `nav:roster`,
  // `role:Commander`, `button.btn#pull-btn`, a task key — is a single token
  // with no whitespace. Prose is not a descriptor, so anything carrying a space
  // is refused outright rather than cleaned and stored.
  function isSafeName(s) {
    return !!s && /^[\w:.#$/-]+$/.test(s);
  }

  // Pseudonymous device id. The ONLY credential in this app is the opaque
  // device token in `cougar-auth`, and that token is live: writing it into a
  // data table would put a working credential in the analytics store. So the
  // id is a short non-reversible hash of it (FNV-1a, 32-bit). One device is
  // approximately one person, which is all this needs to be.
  function deviceIdFrom(token) {
    const s = String(token || "");
    if (!s) return "";
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  // ── Store ─────────────────────────────────────────────────────────────────
  //
  // Own key, and two layers inside it:
  //   `days`    cumulative pre-aggregated counters — what the insights view
  //             reads. Survives buffer pruning, which is the whole point of
  //             keeping counters instead of recomputing from raw events.
  //   `pending` the delta not yet flushed to Postgres. Cleared on a confirmed
  //             flush; a dropped batch simply stays pending until the next one.
  //   `buf`     raw events, capped and pruned oldest-first so a long-lived
  //             phone never hits quota.
  function emptyStore() {
    return { v: 1, device: "", buf: [], days: {}, pending: {}, lastFlush: 0 };
  }

  function loadStore() {
    return safe(() => {
      const raw = (typeof localStorage !== "undefined") && localStorage.getItem(KEY);
      if (!raw) return emptyStore();
      const d = JSON.parse(raw);
      const s = emptyStore();
      if (d && typeof d === "object") {
        s.device = typeof d.device === "string" ? d.device : "";
        s.buf = Array.isArray(d.buf) ? d.buf : [];
        s.days = (d.days && typeof d.days === "object") ? d.days : {};
        s.pending = (d.pending && typeof d.pending === "object") ? d.pending : {};
        s.lastFlush = +d.lastFlush || 0;
      }
      return s;
    }, emptyStore());
  }

  function saveStore(s) {
    safe(() => {
      if (typeof localStorage === "undefined") return;
      // Quota failure must never break a user action. Analytics is best-effort;
      // the tap that produced it is not.
      try { localStorage.setItem(KEY, JSON.stringify(s)); }
      catch (_) { s.buf = s.buf.slice(-Math.floor(BUF_CAP / 4)); try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (__) {} }
    });
  }

  // Oldest-first prune. Pure, so the unit suite can hold it.
  function pruneBuffer(buf, cap) {
    const c = cap == null ? BUF_CAP : cap;
    return buf.length > c ? buf.slice(buf.length - c) : buf;
  }

  function pruneDays(days, cap) {
    const c = cap == null ? DAY_CAP : cap;
    const keys = Object.keys(days).sort();
    if (keys.length <= c) return days;
    const keep = keys.slice(keys.length - c);
    const out = {};
    for (const k of keep) out[k] = days[k];
    return out;
  }

  const blankDay = () => ({ features: {}, views: {}, tasks: {} });

  // Fold one event into a counter map (both `days` and `pending` get the same
  // treatment, which is why this is one pure function).
  function aggregate(map, ev) {
    const day = ev.day || dayOf(ev.t);
    const d = map[day] || (map[day] = blankDay());
    if (ev.k === "click") {
      d.features[ev.n] = (d.features[ev.n] || 0) + 1;
    } else if (ev.k === "view") {
      const v = d.views[ev.n] || (d.views[ev.n] = { n: 0, ms: 0 });
      v.n += 1;
      v.ms += Math.max(0, +ev.ms || 0);
    } else if (ev.k === "task_start") {
      const t = d.tasks[ev.n] || (d.tasks[ev.n] = { starts: 0, done: 0, aban: 0, clicks: 0, ms: 0 });
      t.starts += 1;
    } else if (ev.k === "task_end") {
      const t = d.tasks[ev.n] || (d.tasks[ev.n] = { starts: 0, done: 0, aban: 0, clicks: 0, ms: 0 });
      if (ev.o === "completed") t.done += 1; else t.aban += 1;
      t.clicks += Math.max(0, +ev.c || 0);
      t.ms += Math.max(0, +ev.ms || 0);
    }
    return map;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  let store = null;
  let dirty = false;
  let saveTimer = null;

  function ensureStore() {
    if (!store) store = loadStore();
    // Checked on every call, not only on first load: clearLocal() resets the
    // store to a blank one, and a device with no id would then be unattributable.
    if (!store.device) {
      const tok = safe(() => (typeof localStorage !== "undefined" && localStorage.getItem("cougar-auth")) || "", "");
      // No token (offline / e2e / pre-invite): a random pseudonym so the device
      // still aggregates against itself.
      store.device = deviceIdFrom(tok) || ("x" + Math.random().toString(16).slice(2, 9));
      dirty = true;
    }
    return store;
  }

  // Coalesce writes: a burst of clicks should not be a burst of JSON.stringify
  // over the whole store on the main thread of a phone.
  function scheduleSave() {
    dirty = true;
    if (saveTimer || typeof setTimeout !== "function") return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) { dirty = false; saveStore(store); } }, 1200);
  }

  function record(ev) {
    return safe(() => {
      const s = ensureStore();
      ev.t = ev.t || nowMs();
      ev.n = scrubName(ev.n);
      // Refused, not cleaned: see isSafeName. A name that does not look like a
      // descriptor is dropped and nothing is recorded in its place.
      if (!isSafeName(ev.n)) return null;
      s.buf.push(ev);
      s.buf = pruneBuffer(s.buf);
      aggregate(s.days, ev);
      aggregate(s.pending, ev);
      s.days = pruneDays(s.days);
      scheduleSave();
      return ev;
    }, null);
  }

  // ── Layer 1: raw click capture ────────────────────────────────────────────
  //
  // CAPTURE PHASE IS MANDATORY. index.html puts onclick="event.stopPropagation()"
  // on .modal, and several row-action buttons call stopPropagation inline, so a
  // bubble listener would miss every click inside a modal — which is exactly
  // where the expensive multi-step tasks live.

  // Resolve a click to a stable descriptor, cheapest signal first. NEVER reads
  // an element's `.value` and NEVER reads an onclick's arguments.
  function descriptorFor(target) {
    let el = target;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      if (typeof el.getAttribute !== "function") continue;

      const tel = el.getAttribute("data-tel");
      if (tel) return scrubName(tel);

      // The leading function name of the inline handler — the single most
      // useful signal in this codebase, since all ~176 handlers are inline
      // onclick attributes. The regex stops at the "(" so an argument can
      // never be captured, and an identifier cannot start with a digit, so a
      // 4D cannot be the match. "event.stopPropagation()" does not match
      // (there is a "." before the paren) and correctly falls through.
      const oc = el.getAttribute("onclick");
      if (oc) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(oc);
        if (m) return m[1].slice(0, NAME_CAP);
      }

      const nav = el.getAttribute("data-nav");
      if (nav) return "nav:" + scrubName(nav);

      const role = el.getAttribute("data-role");
      if (role !== null && role !== undefined) return "role:" + (scrubName(role) || "all");

      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "button" || tag === "a" || tag === "select" || tag === "input" || tag === "label") {
        // Semantic fallback, from MARKUP ONLY: tag, first class, and the
        // element id. Deliberately NOT the element's text.
        //
        // TELEMETRY-DESIGN.md proposes "trimmed text content, stripped of
        // digits" here. Stripping digits defeats a 4D but not a NAME, and in
        // this app a row button's text is routinely "1101 TAN WEI MING". There
        // is no reliable way to tell a UI label from a soldier's name after the
        // fact — `scrubName` would happily pass "TAN WEI MING" through — so the
        // text is never read at all. Class and id in this codebase are static
        // markup (.nav-btn, .role-btn, #pull-btn) and carry no data, which
        // makes the descriptor deterministic AND provably clean. Anything that
        // genuinely needs a friendlier label should carry data-tel.
        const cls = String(el.className || "").split(/\s+/).filter(Boolean)[0] || "";
        const id = String(el.getAttribute("id") || "");
        const d = tag + (cls ? "." + cls : "") + (id ? "#" + id : "");
        return scrubName(d) || tag;
      }
    }
    return null;
  }

  function onClickCapture(e) {
    safe(() => {
      const n = descriptorFor(e && e.target);
      if (!n) return;
      if (openTask) openTask.clicks += 1;
      record({ k: "click", n });
    });
  }

  // ── Layer 2: task funnels ─────────────────────────────────────────────────

  let openTask = null;   // { key, t0, clicks }

  // `clicks` starts at 1, not 0: the tap that opened the form is part of what
  // the task cost. The capture listener runs BEFORE the inline handler, so at
  // that instant there was no open task to attribute it to.
  function beginTask(key) {
    safe(() => {
      if (openTask) endTask("superseded");
      openTask = { key, t0: nowMs(), clicks: 1 };
      record({ k: "task_start", n: key });
    });
  }

  function endTask(outcome) {
    safe(() => {
      const t = openTask;
      openTask = null;
      if (!t) return;
      record({ k: "task_end", n: t.key, o: outcome, c: t.clicks, ms: nowMs() - t.t0 });
    });
  }

  // Wrap a global function TRANSPARENTLY: same `this`, same arguments, same
  // return value, exceptions propagate unchanged. All bookkeeping is inside
  // safe(), so a telemetry bug can never surface in a user's path.
  function wrapGlobal(scope, name, before, after) {
    const orig = scope[name];
    if (typeof orig !== "function") return false;
    if (orig.__telWrapped) return true;
    const wrapper = function () {
      safe(() => { if (before) before(); });
      let out;
      try {
        out = orig.apply(this, arguments);
      } catch (e) {
        safe(() => { if (after) after(false); });
        throw e;                              // never swallow a user-path error
      }
      // An async submit returns a promise; its outcome is not known yet.
      // Observe it without altering it — the ORIGINAL promise is returned, so
      // the caller's own handling is untouched, and the derived promise has a
      // rejection handler so it cannot produce an unhandled rejection.
      if (out && typeof out.then === "function") {
        try { out.then(() => safe(() => after && after(true)), () => safe(() => after && after(false))); }
        catch (_) { safe(() => after && after(true)); }
      } else {
        safe(() => { if (after) after(true); });
      }
      return out;
    };
    wrapper.__telWrapped = true;
    wrapper.__telOriginal = orig;
    scope[name] = wrapper;
    return true;
  }

  function installTaskWrappers(scope) {
    const missing = [];
    for (const key of Object.keys(TASKS)) {
      const spec = TASKS[key];
      if (spec.start) {
        if (!wrapGlobal(scope, spec.start, () => beginTask(key), null)) missing.push(spec.start);
      }
      if (spec.done) {
        const instant = !spec.start;
        const ok = wrapGlobal(
          scope, spec.done,
          instant ? () => beginTask(key) : null,
          (success) => endTask(success ? "completed" : "error")
        );
        if (!ok) missing.push(spec.done);
      }
    }
    // A closing modal with a task still open is an abandonment — a form people
    // open and back out of is a form with a problem, and that is as interesting
    // as click cost. The `done` wrappers detach the task BEFORE the original
    // runs, so a submit that closes its own modal is never miscounted here.
    wrapGlobal(scope, "closeModal", () => { if (openTask) endTask("abandoned"); }, null);
    return missing;
  }

  // ── Layer 3: view dwell ───────────────────────────────────────────────────
  //
  // Wrapping render() rather than editing main.js: every nav change, filter
  // change and repaint goes through it, and STATE.nav is already the truth of
  // which view is showing. No call site is touched.
  let lastView = null;
  let lastViewAt = 0;

  function noteView(nav) {
    safe(() => {
      const v = String(nav || "");
      if (v === lastView) return;
      const t = nowMs();
      if (lastView) record({ k: "view", n: lastView, ms: t - lastViewAt });
      // Navigating away with a form open is an abandonment too.
      if (openTask) endTask("abandoned");
      lastView = v;
      lastViewAt = t;
    });
  }

  // NOTE the bare `STATE`, not `window.STATE`. js/state.js declares it with
  // `const` at the top level of a classic script, and a top-level const is NOT
  // a property of window — only `function` declarations are. Reading it off the
  // global OBJECT yields undefined, which made every dwell measurement resolve
  // to the same empty view and silently record nothing. Resolving it lexically
  // works because all js/*.js share one global scope.
  const currentNav = () => (typeof STATE !== "undefined" && STATE ? STATE.nav : "");

  function installViewTracking(scope) {
    wrapGlobal(scope, "render", () => { noteView(currentNav()); }, null);
  }

  // ── Storage → server ──────────────────────────────────────────────────────

  // Flatten the pending delta into counter rows. One row per
  // (day, kind, name); the server adds them into usage_daily.
  function rowsFrom(pending) {
    const rows = [];
    for (const day of Object.keys(pending || {}).sort()) {
      const d = pending[day] || {};
      for (const n of Object.keys(d.features || {})) {
        rows.push({ day, kind: "feature", name: n, events: d.features[n], completed: 0, abandoned: 0, clicks: 0, ms: 0 });
      }
      for (const n of Object.keys(d.views || {})) {
        const v = d.views[n];
        rows.push({ day, kind: "view", name: n, events: v.n, completed: 0, abandoned: 0, clicks: 0, ms: v.ms });
      }
      for (const n of Object.keys(d.tasks || {})) {
        const t = d.tasks[n];
        rows.push({ day, kind: "task", name: n, events: t.starts, completed: t.done, abandoned: t.aban, clicks: t.clicks, ms: t.ms });
      }
    }
    return rows.slice(0, ROW_CAP);
  }

  let flushing = false;

  // Flush BYPASSES autoSync entirely. No tab is marked dirty, nothing enters
  // the per-tab write queue, and a failure is never surfaced to the user: the
  // batch stays pending and goes out with the next one.
  async function flush(useBeacon) {
    return safe(async () => {
      const s = ensureStore();
      const rows = rowsFrom(s.pending);
      if (!rows.length) return { ok: true, rows: 0 };
      if (typeof API === "undefined" || !API || typeof STATE === "undefined") return { ok: false, rows: 0 };
      if (!STATE.authToken || !STATE.apiUrl) return { ok: false, rows: 0 };
      if (flushing) return { ok: false, rows: 0 };

      // A batch id makes the additive server-side upsert replay-safe: the
      // server records the id and ignores a second delivery of the same batch,
      // so a retried flush cannot double-count.
      const batchId = String(nowMs()) + "-" + Math.random().toString(16).slice(2, 10);
      const batch = { batchId, device: s.device, rows };

      // Page going away: sendBeacon is the only transport that reliably
      // survives it. We cannot learn the outcome, so the pending delta is
      // cleared optimistically — losing a batch of analytics is nothing.
      if (useBeacon && typeof API.usageBeacon === "function") {
        const queued = API.usageBeacon(batch);
        if (queued) { s.pending = {}; s.lastFlush = nowMs(); saveStore(s); dirty = false; }
        return { ok: !!queued, rows: rows.length, beacon: true };
      }

      flushing = true;
      try {
        const res = await API.usageAppend(batch);
        if (res && (res.ok || res.duplicate)) {
          s.pending = {};
          s.lastFlush = nowMs();
          saveStore(s);
          dirty = false;
          return { ok: true, rows: rows.length };
        }
        return { ok: false, rows: rows.length };
      } catch (_) {
        // Offline, timeout, revoked token — all identical from here: keep the
        // delta and try again later. Never a user-visible error.
        return { ok: false, rows: rows.length };
      } finally {
        flushing = false;
      }
    }, { ok: false, rows: 0 });
  }

  // ── Read-out ──────────────────────────────────────────────────────────────

  // Roll a counter map (local `days`, or server rows folded into the same
  // shape) into what the insights view actually asks of it.
  function summarize(days, opts) {
    const o = opts || {};
    const since = o.days ? dayOf(nowMs() - (o.days - 1) * 86400000) : null;
    const features = {}, views = {}, tasks = {};
    let span = 0;

    for (const day of Object.keys(days || {})) {
      if (since && day < since) continue;
      span++;
      const d = days[day] || {};
      for (const n of Object.keys(d.features || {})) features[n] = (features[n] || 0) + d.features[n];
      for (const n of Object.keys(d.views || {})) {
        const v = views[n] || (views[n] = { opens: 0, ms: 0 });
        v.opens += d.views[n].n; v.ms += d.views[n].ms;
      }
      for (const n of Object.keys(d.tasks || {})) {
        const t = tasks[n] || (tasks[n] = { starts: 0, done: 0, aban: 0, clicks: 0, ms: 0 });
        const s = d.tasks[n];
        t.starts += s.starts; t.done += s.done; t.aban += s.aban; t.clicks += s.clicks; t.ms += s.ms;
      }
    }

    const featureList = Object.keys(features)
      .map(n => ({ name: n, count: features[n] }))
      .sort((a, b) => b.count - a.count);

    const viewList = Object.keys(views)
      .map(n => ({ name: n, label: VIEW_LABELS[n] || n, opens: views[n].opens, ms: views[n].ms,
                   avgMs: views[n].opens ? Math.round(views[n].ms / views[n].opens) : 0 }))
      .sort((a, b) => b.opens - a.opens);

    const taskList = Object.keys(tasks).map(n => clickCost(n, tasks[n]))
      .sort((a, b) => b.cost - a.cost);

    return { days: span, features: featureList, views: viewList, tasks: taskList };
  }

  // Clicks-per-task and abandonment for one task's counters.
  //
  // `ended` (not `starts`) is the denominator for average clicks: a task still
  // open when the app closed contributed no click count, and dividing by it
  // would understate every cost. Abandonment is over ended sessions for the
  // same reason.
  function clickCost(key, c) {
    const spec = TASKS[key] || {};
    const ended = (c.done || 0) + (c.aban || 0);
    const avgClicks = ended ? +(c.clicks / ended).toFixed(1) : 0;
    const abandonRate = ended ? +((c.aban / ended) * 100).toFixed(0) : 0;
    return {
      key,
      label: spec.label || key,
      starts: c.starts || 0,
      completed: c.done || 0,
      abandoned: c.aban || 0,
      ended,
      avgClicks,
      abandonRate,
      avgMs: ended ? Math.round((c.ms || 0) / ended) : 0,
      // Total taps this task cost the company over the window. This is the
      // ranking that answers "what is expensive", because a 3-tap task done 50
      // times costs more than an 8-tap task done twice.
      cost: c.clicks || 0
    };
  }

  // The entire point of building this: which features should move to the front
  // of the dashboard. High frequency AND high click cost, stated in words.
  function recommend(summary) {
    const tasks = (summary && summary.tasks) || [];
    if (!tasks.length) return [];
    const ranked = tasks.filter(t => t.starts > 0);
    if (!ranked.length) return [];
    const medFreq = median(ranked.map(t => t.starts));
    const medCost = median(ranked.map(t => t.avgClicks));
    const out = [];
    for (const t of ranked) {
      const frequent = t.starts >= Math.max(2, medFreq);
      const expensive = t.avgClicks >= Math.max(3, medCost);
      const leaky = t.ended >= 3 && t.abandonRate >= 30;
      if (!frequent && !leaky) continue;
      let verdict, why;
      // Leak first. A form a third of people back out of is a broken form, and
      // that is a more urgent and more specific finding than "this is popular
      // and expensive" — promoting a leaky form to the dashboard just puts the
      // problem in front of more people.
      if (leaky) {
        verdict = "investigate";
        why = `${t.abandonRate}% of ${t.ended} attempts were abandoned`
            + (frequent ? `, and it is used ${t.starts}x` : "")
            + ` — the form is losing people`;
      } else if (frequent && expensive) {
        verdict = "promote";
        why = `used ${t.starts}x, averages ${t.avgClicks} taps — promote to the dashboard`;
      } else if (frequent) {
        verdict = "keep";
        why = `used ${t.starts}x at ${t.avgClicks} taps — already cheap, leave it where it is`;
      } else continue;
      out.push({ key: t.key, label: t.label, verdict, why, starts: t.starts, avgClicks: t.avgClicks, abandonRate: t.abandonRate });
    }
    // Leaks first, then promotions, then the "already fine" notes — the same
    // priority the verdicts are assigned in above.
    const order = { investigate: 0, promote: 1, keep: 2 };
    return out.sort((a, b) => (order[a.verdict] - order[b.verdict]) || (b.starts * b.avgClicks - a.starts * a.avgClicks));
  }

  function median(xs) {
    if (!xs.length) return 0;
    const a = xs.slice().sort((p, q) => p - q);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Fold server counter rows (day, kind, name, …) back into the `days` shape
  // so company-wide and this-device read-outs go through one summarize().
  function daysFromRows(rows) {
    const days = {};
    for (const r of (rows || [])) {
      const day = String(r.day || "").slice(0, 10);
      if (!day) continue;
      const d = days[day] || (days[day] = blankDay());
      const name = scrubName(r.name);
      if (!isSafeName(name)) continue;
      if (r.kind === "feature") d.features[name] = (d.features[name] || 0) + (+r.events || 0);
      else if (r.kind === "view") {
        const v = d.views[name] || (d.views[name] = { n: 0, ms: 0 });
        v.n += +r.events || 0; v.ms += +r.ms || 0;
      } else if (r.kind === "task") {
        const t = d.tasks[name] || (d.tasks[name] = { starts: 0, done: 0, aban: 0, clicks: 0, ms: 0 });
        t.starts += +r.events || 0; t.done += +r.completed || 0; t.aban += +r.abandoned || 0;
        t.clicks += +r.clicks || 0; t.ms += +r.ms || 0;
      }
    }
    return days;
  }

  // ── Install ───────────────────────────────────────────────────────────────

  let installed = false;

  function install(scope) {
    if (installed) return { installed: true, missing: [] };
    const g = scope || (typeof window !== "undefined" ? window : null);
    if (!g || typeof document === "undefined") return { installed: false, missing: [] };
    installed = true;

    ensureStore();

    document.addEventListener("click", onClickCapture, true);

    const missing = installTaskWrappers(g);
    installViewTracking(g);
    if (missing.length) {
      // ONE warning. The registry will drift as the app changes and drift must
      // never break the app, so a missing name is a note, not a failure.
      try { console.warn("[telemetry] registry drift — not found, skipped: " + missing.join(", ")); } catch (_) {}
    }

    // Seed the first view without waiting for a nav change.
    noteView(currentNav());

    if (typeof setInterval === "function") setInterval(() => { flush(false); }, FLUSH_MS);
    document.addEventListener("visibilitychange", () => {
      safe(() => {
        if (document.visibilityState !== "hidden") return;
        // Close the open dwell so a backgrounded phone does not book the whole
        // night as time spent on the roster.
        if (lastView) { record({ k: "view", n: lastView, ms: nowMs() - lastViewAt }); lastViewAt = nowMs(); }
        if (dirty) { dirty = false; saveStore(store); }
        flush(true);
      });
    });

    return { installed: true, missing };
  }

  const api = {
    // Read-out surface, used by js/render-usage.js
    localDays: () => ensureStore().days,
    deviceId: () => ensureStore().device,
    summarize, recommend, clickCost, daysFromRows,
    viewLabel: (n) => VIEW_LABELS[n] || n,
    taskLabel: (k) => (TASKS[k] && TASKS[k].label) || k,
    TASKS, VIEW_LABELS,
    flush,
    clearLocal: () => safe(() => {
      store = emptyStore();
      try { localStorage.removeItem(KEY); } catch (_) {}
      return true;
    }, false),
    // Pure internals — exposed so the unit suite can hold them directly.
    scrubName, isSafeName, deviceIdFrom, pruneBuffer, pruneDays, aggregate, rowsFrom,
    descriptorFor, emptyStore, KEY, BUF_CAP, DAY_CAP,
    _install: install,
    _wrapGlobal: wrapGlobal,
    _record: record,
    _buffer: () => ensureStore().buf,
    _pending: () => ensureStore().pending
  };

  // Self-install in a browser. In Node (the unit suite) there is no document,
  // so install() no-ops and only the pure surface is exercised.
  safe(() => install(typeof window !== "undefined" ? window : null));

  return api;
})();

// Node unit suite reaches in through module.exports; browsers ignore this.
if (typeof module !== "undefined" && module.exports) module.exports = TELEMETRY;
