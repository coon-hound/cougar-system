// Master NR - the column registry behind the Roster view.
//
// The Roster tab is a configurable nominal roll: pick columns, filter rows, sort
// by any column. Every column here READS an existing helper (outOfCampMap,
// currentMedicalEffectiveAll, aggregateIPPT, commanderBalances, dutyHoldersFor
// ...) and nothing is ever stored: a column is a view over the records, so it
// can never disagree with the dashboard, the parade state or the person card.
//
// Everything lives under one top-level `const NR` because every js/* file shares
// one global scope (test/static.test.js compiles them together). The handlers
// the markup calls (openNRColumns, openNRColMenu ...) are plain functions in
// js/render.js, beside renderRoster, so telemetry can wrap them by name.
//
// Column shape:
//   { id, label, group, type: "text"|"enum"|"bool"|"number"|"date",
//     get(r, ctx)   raw value: string | string[] (enum) | boolean | number|null | ISO
//     text(r, ctx)  plain text for CSV / copy / search (defaults from get)
//     cell(r, ctx)  inner HTML of the <td> (defaults to escaped text)
//     td            static style for the <td>, or tdStyle(r, ctx)
//     th            static style for the <th>
//     sort(r, ctx)  sort key when get() is not the right one
//     multi         get() returns several values per man (Status, Quals ...),
//                   so a filter can ask for any or all of them
//     blankLabel    how the filter menu names "" ("Active" on Status)
//     vlabel(v)     how the filter menu names a value ("1" -> "PL 1")
//     range         { parse, fmt, hint } when a number column's range is not
//                   typed as a plain number (2.4 km: mm:ss, kept in seconds) }
//
// ctx is built once per render and memoises every index lazily, so a column
// nobody shows costs nothing.
const NR = (() => {
  const LS_KEY = "cougar-nr-v1";
  const DASH = '<span style="color:var(--muted)">—</span>';

  // ── Per-render context ────────────────────────────────────────────────────
  function makeCtx(today) {
    today = today || todayISO();
    const memo = {};
    const once = (k, f) => (k in memo ? memo[k] : (memo[k] = f()));
    const group = (rows, keyOf) => {
      const m = new Map();
      (rows || []).forEach(x => { if (!x) return; const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
      return m;
    };
    const byD4 = entries => new Map(entries.map(e => [e.d4, e]));
    return {
      today,
      get outMap() { return once("outMap", () => outOfCampMap(today)); },
      // d4 -> [{record, tag, ghostDay}], most severe first (the Status column's source).
      get effByD4() {
        return once("effByD4", () => {
          const o = {};
          currentMedicalEffectiveAll(today).forEach(e => { o[e.d4] = e.statuses; });
          return o;
        });
      },
      get medByD4() { return once("medByD4", () => group(STATE.medical, m => m.d4)); },
      get rsiCount() {
        return once("rsiCount", () => {
          const c = {};
          (STATE.medical || []).forEach(m => { c[m.d4] = (c[m.d4] || 0) + 1; });
          return c;
        });
      },
      get ipptLatest() { return once("ipptLatest", () => byD4(aggregateIPPT(STATE.ippt || [], "latest"))); },
      get ipptBest() { return once("ipptBest", () => byD4(aggregateIPPT(STATE.ippt || [], "best"))); },
      // Per series, exactly as the IPPT view builds its progression lines: an
      // attempt number only means something inside one series.
      get ipptSeriesRows() {
        return once("ipptSeriesRows", () => {
          const o = {};
          IPPT_SERIES.forEach(s => {
            o[s] = new Map(ipptSeriesByRecruit((STATE.ippt || []).filter(e => ipptSeriesOf(e) === s)).map(x => [x.d4, x]));
          });
          return o;
        });
      },
      // The IPPT view's YTT chase: no non-YTT KH result.
      get khTaken() {
        return once("khTaken", () => new Set((STATE.ippt || []).filter(e => ipptSeriesOf(e) === "KH" && !isYTT(e)).map(e => e.d4)));
      },
      // Leave covering today, the Out / Leave view's own "on leave today" test.
      get leaveToday() {
        return once("leaveToday", () => group((STATE.leave || []).filter(l => {
          const s = displayDateToISO(l.startDate) || "", e = displayDateToISO(l.endDate) || "";
          return s <= today && today <= e;
        }), l => l.d4));
      },
      get nextLeave() {
        return once("nextLeave", () => {
          const m = new Map();
          (STATE.leave || []).forEach(l => {
            const s = displayDateToISO(l.startDate) || "";
            if (!s || s <= today) return;
            const cur = m.get(l.d4);
            if (!cur || s < cur.iso) m.set(l.d4, { iso: s, rec: l });
          });
          return m;
        });
      },
      // Unresolved appointments today or later, the MSK card's "upcoming" test.
      get nextAppt() {
        return once("nextAppt", () => {
          const m = new Map();
          (STATE.appointments || []).forEach(a => {
            const iso = displayDateToISO(a.date) || "";
            if (a.resolved || iso < today) return;
            const cur = m.get(a.d4);
            if (!cur || iso < cur.iso) m.set(a.d4, { iso, rec: a });
          });
          return m;
        });
      },
      get apptToday() {
        return once("apptToday", () => new Set((STATE.appointments || [])
          .filter(a => !a.resolved && displayDateToISO(a.date) === today).map(a => a.d4)));
      },
      get apptOut() {
        return once("apptOut", () => new Set(typeof outsideApptsForParade === "function"
          ? outsideApptsForParade(today).map(a => a.d4) : []));
      },
      // Published duty only: a draft month is not who is on duty.
      get dutyToday() {
        return once("dutyToday", () => {
          const m = new Map();
          Object.entries(dutyHoldersFor(today, false)).forEach(([k, d4]) => {
            if (!m.has(d4)) m.set(d4, []);
            m.get(d4).push(k);
          });
          return m;
        });
      },
      get dutyTally() { return once("dutyTally", () => dutyTallies()); },
      get missed() {
        return once("missed", () => {
          const c = {};
          (STATE.conductDetail || []).forEach(d => { c[d.d4] = (c[d.d4] || 0) + 1; });
          return c;
        });
      },
      balances(d4) { const k = "bal:" + d4; return once(k, () => commanderBalances(d4)); },
    };
  }

  // ── Small builders ────────────────────────────────────────────────────────
  const isCmd = r => r && r.role === "Commander";
  // A section role is "/"-separated parts ("2 LMG / Gunner", "(2GL) / PC
  // Runner"), split the way mountOf splits it, so filtering on Gunner also
  // finds the men who are Gunner and something else. Case is folded onto the
  // suggestion list, so "BRONCO OPERATOR" and "Bronco Operator" are one value.
  // A blank role stays one "" value so "(blank)" can still be filtered on.
  const roleParts = r => {
    const parts = String((r && r.billet) || "").split("/")
      .map(p => p.replace(/[()]/g, "").trim()).filter(Boolean)
      .map(p => (typeof BILLET_SUGGESTIONS !== "undefined" && BILLET_SUGGESTIONS.find(b => b.toLowerCase() === p.toLowerCase())) || p);
    return parts.length ? [...new Set(parts)] : [""];
  };
  const field = (key, label, group, type, extra) => Object.assign({
    id: key, label, group, type: type || "text",
    get: r => {
      const v = r[key];
      if (type === "number") return v === "" || v == null || isNaN(+v) ? null : +v;
      return v == null ? "" : String(v);
    },
  }, extra || {});
  const boolCell = v => v ? '<span style="color:var(--green);font-weight:600">Yes</span>' : '<span style="color:var(--dim)">No</span>';
  const statusesOf = (r, ctx) => ctx.effByD4[r.id] || [];
  const latest = (r, ctx) => ctx.ipptLatest.get(r.id) || null;
  const best = (r, ctx) => ctx.ipptBest.get(r.id) || null;
  const ipptScoreText = e => !e ? "" : isYTT(e) ? "YTT" : String(+e.score || 0);
  const medDates = (r, ctx) => (ctx.medByD4.get(r.id) || []).map(m => displayDateToISO(m.date) || "").filter(Boolean);
  const daysAgo = (today, n) => { const d = new Date(today + "T00:00:00"); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const rsWithin = (n) => (r, ctx) => {
    const from = daysAgo(ctx.today, n - 1);
    return medDates(r, ctx).filter(iso => iso >= from && iso <= ctx.today).length;
  };

  // Camp - the existing Roster column, verbatim. Reads outOfCampMap so it can
  // never disagree with the dashboard / parade strength.
  const CAMP_COLOR = { medical: "--red", leave: "--purple", bookedout: "--orange" };
  const CAMP_WHY = { medical: "Medical", leave: "Leave", bookedout: "Booked out" };
  const forcedInOf = (r, ctx) => !ctx.outMap.get(r.id) && isForcedIn(r, ctx.today) && derivedCampOut(r.id, ctx.today);
  function campText(r, ctx) {
    const o = ctx.outMap.get(r.id);
    if (o) return "Out · " + (CAMP_WHY[o.kind] || o.kind);
    return forcedInOf(r, ctx) ? "In camp · manual" : "In camp";
  }
  function campCell(r, ctx) {
    const outInfo = ctx.outMap.get(r.id);
    const forcedIn = forcedInOf(r, ctx);
    const campBadge = outInfo
      ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:color-mix(in srgb, var(${CAMP_COLOR[outInfo.kind] || "--muted"}) 13%, transparent);color:var(${CAMP_COLOR[outInfo.kind] || "--muted"})" title="Out of camp — ${escapeAttr(outInfo.reason || "")}${outInfo.back ? ` (back ${isoToDisplayDate(outInfo.back)})` : ""}">Out · ${CAMP_WHY[outInfo.kind] || outInfo.kind}</span>${typeof backLine === "function" ? backLine(outInfo) : ""}`
      : forcedIn
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(var(--tealRGB),.13);color:var(--teal)" title="Manually kept in camp today — would be out: ${escapeAttr(forcedIn.reason || "")}. Resets tomorrow.">In camp · manual</span>`
        : `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(var(--greenRGB),.09);color:var(--green)">In camp</span>`;
    const campToggle = outInfo
      ? (outInfo.kind === "bookedout"
        ? `<button class="btn btn-icon btn-success" style="font-size:10px;padding:2px 7px" onclick="event.stopPropagation(); undoBookOut('${r.id}')" title="Removes today's book-out">↩ Book in</button>`
        : `<button class="btn btn-icon" style="font-size:10px;padding:2px 7px;color:var(--teal)" onclick="event.stopPropagation(); markPresentToday('${r.id}')" title="Count as present today despite the ${outInfo.kind} record (resets tomorrow)">✓ Book in anyway</button>`)
      : forcedIn
        ? `<button class="btn btn-icon" style="font-size:10px;padding:2px 7px" onclick="event.stopPropagation(); clearPresentOverride('${r.id}')" title="Remove the manual book-in; they return to their out status">✕ Undo book-in</button>`
        : `<button class="btn btn-icon" style="font-size:10px;padding:2px 7px" onclick="event.stopPropagation(); openBookOutForm({ d4: '${r.id}' })" title="Book out of camp for today or a date range">🚪 Book out</button>`;
    return `<div style="display:inline-flex;flex-direction:column;gap:3px;align-items:center">${campBadge}${campToggle}</div>`;
  }

  // ── The catalogue ─────────────────────────────────────────────────────────
  // Group order is the order the Columns modal lists them in.
  const G = {
    id: "Identity", camp: "Camp today", med: "Medical", leave: "Leave and movement",
    fit: "Fitness", duty: "Duty and attendance", quals: "Qualifications",
    personal: "Personal (sensitive)",
  };
  const COLUMNS = [
    // Identity
    { id: "d4", label: "4D", group: G.id, type: "text", td: "font-weight:700;color:var(--accent)", tdClass: "mono",
      get: r => displayId(r.id) },
    { id: "name", label: "Name", group: G.id, type: "text", th: "text-align:left", td: "text-align:left", sticky: true,
      get: r => isCmd(r) ? `${r.rank ? r.rank + " " : ""}${r.name || ""}` : (r.name || "") },
    // The Default "Role" column: Commander badge, or section role + mount tag.
    { id: "role", label: "Role", group: G.id, type: "enum", multi: true,
      get: r => isCmd(r) ? ["Commander"] : roleParts(r),
      text: r => isCmd(r) ? "Commander" : (r.billet || ""), sort: r => isCmd(r) ? "Commander" : (r.billet || ""),
      cell: r => isCmd(r) ? `<span class="badge badge-purple">Commander</span>` : `${r.billet ? escapeHtml(r.billet) : `<span style="color:var(--muted)">—</span>`}<div style="margin-top:2px">${mountBadge(r)}</div>` },
    { id: "rank", label: "Rank", group: G.id, type: "enum", get: r => rosterRank(r) },
    { id: "kind", label: "Cmdr / Rec", group: G.id, type: "enum", get: r => r.role || "" },
    { id: "plt", label: "Platoon", group: G.id, type: "enum", get: r => getPlt(r), text: r => getPlt(r) ? "PL " + getPlt(r) : "COY HQ",
      vlabel: v => v ? "PL " + v : "COY HQ" },
    { id: "sect", label: "Section", group: G.id, type: "enum", get: r => getSect(r) },
    field("appt", "Appt", G.id, "enum"),
    { id: "billet", label: "Section role", group: G.id, type: "enum", multi: true,
      get: r => roleParts(r), text: r => r.billet || "", sort: r => r.billet || "" },
    { id: "mount", label: "Mounted", group: G.id, type: "enum",
      get: r => mountOf(r) ? MOUNT_LABEL[mountOf(r)] : "", cell: r => mountBadge(r) || DASH },
    { id: "groups", label: "Groups", group: G.id, type: "enum", multi: true, get: r => getGroups(r), text: r => getGroups(r).join(", ") },
    field("intake", "Intake", G.id, "enum"),
    field("age", "Age", G.id, "number"),
    field("phone", "Phone", G.id),
    field("email", "Email", G.id),
    field("ration", "Ration", G.id, "enum"),
    field("highest education level", "Education", G.id, "enum", { id: "edu" }),
    field("motorcycle license", "Motorcycle licence", G.id, "enum", { id: "moto" }),
    field("height", "Height (cm)", G.id, "number"),
    field("weight", "Weight (kg)", G.id, "number"),
    { id: "bmi", label: "BMI", group: G.id, type: "number",
      get: r => isCmd(r) ? null : calcBMI(r),
      tdStyle: r => `font-weight:700;color:${bmiColor(calcBMI(r))}`,
      cell: r => isCmd(r) ? "—" : String(calcBMI(r) ?? "—") },
    field("notes", "Notes", G.id, "text", { td: "text-align:left;white-space:normal;max-width:240px;font-size:11px" }),

    // Camp today
    { id: "camp", label: "Camp", group: G.camp, type: "enum", td: "white-space:nowrap",
      get: campText, cell: campCell },
    { id: "in_camp", label: "In camp", group: G.camp, type: "bool", get: (r, ctx) => !ctx.outMap.has(r.id) },
    { id: "out_kind", label: "Out because", group: G.camp, type: "enum",
      get: (r, ctx) => { const o = ctx.outMap.get(r.id); return o ? (CAMP_WHY[o.kind] || o.kind) : ""; } },
    { id: "out_reason", label: "Out reason", group: G.camp, type: "text", td: "text-align:left;white-space:normal;max-width:220px;font-size:11px",
      get: (r, ctx) => (ctx.outMap.get(r.id) || {}).reason || "" },
    { id: "back_on", label: "Back on", group: G.camp, type: "date",
      get: (r, ctx) => (ctx.outMap.get(r.id) || {}).back || "" },
    { id: "forced_in", label: "Manually booked in", group: G.camp, type: "bool", get: (r, ctx) => !!forcedInOf(r, ctx) },

    // Medical
    { id: "status", label: "Status", group: G.med, type: "enum", multi: true, blankLabel: "Active",
      get: (r, ctx) => statusesOf(r, ctx).map(s => s.tag),
      text: (r, ctx) => statusesOf(r, ctx).map(s => s.tag).join(", ") || "Active",
      sort: (r, ctx) => { const s = statusesOf(r, ctx)[0]; return s ? medSeverityRank(s.tag) : -1; },
      cell: (r, ctx) => { const st = statusesOf(r, ctx); return st.length ? st.map(s => `<div style="padding:2px 0">${medTagBadge(s.tag)}</div>`).join("") : statusBadge("Active"); } },
    { id: "med_top", label: "Most severe status", group: G.med, type: "enum",
      get: (r, ctx) => { const s = statusesOf(r, ctx)[0]; return s ? s.tag : ""; },
      sort: (r, ctx) => { const s = statusesOf(r, ctx)[0]; return s ? medSeverityRank(s.tag) : -1; },
      cell: (r, ctx) => { const s = statusesOf(r, ctx)[0]; return s ? medTagBadge(s.tag) : DASH; } },
    { id: "med_until", label: "Status until", group: G.med, type: "date",
      get: (r, ctx) => { const s = statusesOf(r, ctx)[0]; const run = s && medStatusRun(s.record); return run ? run.endIso : ""; } },
    { id: "mc_in_camp", label: "MC in camp", group: G.med, type: "bool",
      get: (r, ctx) => statusesOf(r, ctx).some(s => s.ghostDay === 0 && isAwayMedStatus(s.record.status) && !!s.record.inCamp) },
    { id: "recovery", label: "On recovery (+1/+2)", group: G.med, type: "enum", multi: true,
      get: (r, ctx) => statusesOf(r, ctx).filter(s => s.ghostDay > 0).map(s => s.tag) },
    { id: "rsis", label: "RSIs", group: G.med, type: "number",
      get: (r, ctx) => ctx.rsiCount[r.id] || 0,
      tdStyle: (r, ctx) => `color:${(ctx.rsiCount[r.id] || 0) > 1 ? "var(--red)" : "var(--muted)"}`,
      cell: (r, ctx) => String(ctx.rsiCount[r.id] || 0) },
    { id: "rs_7", label: "RSIs (7 days)", group: G.med, type: "number", get: rsWithin(7) },
    { id: "rs_30", label: "RSIs (30 days)", group: G.med, type: "number", get: rsWithin(30) },
    { id: "rs_last", label: "Last report sick", group: G.med, type: "date",
      get: (r, ctx) => medDates(r, ctx).reduce((a, b) => (b > a ? b : a), "") },
    { id: "msk_regions", label: "MSK regions", group: G.med, type: "enum", multi: true, get: r => getMSKRegionsForRecruit(r.id), text: r => getMSKRegionsForRecruit(r.id).join(", ") },
    { id: "msk_open", label: "MSK case open", group: G.med, type: "bool",
      get: r => { const rows = (STATE.msk || []).filter(m => m.d4 === r.id); return rows.length > 0 && !rows.every(m => m.cleared); } },
    field("msk", "MSK history (profile)", G.med, "text", { td: "text-align:left;white-space:normal;max-width:220px;font-size:11px" }),

    // Leave and movement
    { id: "on_leave", label: "On leave today", group: G.leave, type: "bool", get: (r, ctx) => ctx.leaveToday.has(r.id) },
    { id: "leave_type", label: "Leave type today", group: G.leave, type: "enum", multi: true,
      get: (r, ctx) => (ctx.leaveToday.get(r.id) || []).map(l => l.type || "Leave") },
    { id: "next_leave", label: "Next leave", group: G.leave, type: "date",
      get: (r, ctx) => (ctx.nextLeave.get(r.id) || {}).iso || "",
      text: (r, ctx) => { const n = ctx.nextLeave.get(r.id); return n ? `${isoToDisplayDate(n.iso)}${n.rec.type ? " (" + n.rec.type + ")" : ""}` : ""; } },
    field("leaveQuota", "Leave quota", G.leave, "number", { id: "leave_quota" }),
    { id: "al_used", label: "AL used", group: G.leave, type: "number",
      get: (r, ctx) => { const b = ctx.balances(r.id); return b ? b.al.used : null; } },
    { id: "al_left", label: "AL balance", group: G.leave, type: "number",
      get: (r, ctx) => { const b = ctx.balances(r.id); return b ? b.al.remaining : null; } },
    { id: "oil_left", label: "OIL balance", group: G.leave, type: "number",
      get: (r, ctx) => { const b = ctx.balances(r.id); return b ? b.oil.remaining : null; } },
    { id: "next_appt", label: "Next appointment", group: G.leave, type: "date",
      get: (r, ctx) => (ctx.nextAppt.get(r.id) || {}).iso || "",
      text: (r, ctx) => { const n = ctx.nextAppt.get(r.id); return n ? `${isoToDisplayDate(n.iso)}${n.rec.time ? " " + fmtHrs(n.rec.time) : ""}${n.rec.reason ? " - " + n.rec.reason : ""}` : ""; },
      td: "text-align:left;white-space:normal;max-width:220px;font-size:11px" },
    { id: "appt_today", label: "Appointment today", group: G.leave, type: "bool", get: (r, ctx) => ctx.apptToday.has(r.id) },
    { id: "appt_out", label: "Appointment out of camp", group: G.leave, type: "bool", get: (r, ctx) => ctx.apptOut.has(r.id) },

    // Fitness
    { id: "ippt_which", label: "Latest IPPT", group: G.fit, type: "enum",
      get: (r, ctx) => { const e = latest(r, ctx); return e ? ipptConductLabel(ipptSeriesOf(e), +e.attempt || "", true) : ""; } },
    { id: "ippt_score", label: "IPPT score", group: G.fit, type: "number",
      get: (r, ctx) => { const e = latest(r, ctx); return e && !isYTT(e) ? (+e.score || 0) : null; },
      text: (r, ctx) => ipptScoreText(latest(r, ctx)) },
    { id: "ippt_award", label: "IPPT award", group: G.fit, type: "enum",
      get: (r, ctx) => { const e = latest(r, ctx); return !e ? "" : isYTT(e) ? "YTT" : getAward(+e.score || 0); },
      cell: (r, ctx) => { const e = latest(r, ctx); return e ? ipptAwardBadge(e) : DASH; } },
    // Stored and compared in seconds; its range is typed and shown as mm:ss.
    { id: "ippt_run", label: "2.4 km", group: G.fit, type: "number", tdClass: "mono",
      range: { parse: v => /^\d{1,2}:\d{2}$/.test(String(v).trim()) ? parseRunTimeToSeconds(String(v).trim()) : null, fmt: formatSeconds, hint: "mm:ss" },
      get: (r, ctx) => { const e = latest(r, ctx); const s = e ? parseRunTimeToSeconds(e.runTime) : 0; return s > 0 ? s : null; },
      text: (r, ctx) => { const e = latest(r, ctx); const s = e ? parseRunTimeToSeconds(e.runTime) : 0; return s > 0 ? formatSeconds(s) : ""; } },
    { id: "ippt_best", label: "Best IPPT", group: G.fit, type: "number",
      get: (r, ctx) => { const e = best(r, ctx); return e && !isYTT(e) ? (+e.score || 0) : null; },
      text: (r, ctx) => ipptScoreText(best(r, ctx)) },
    // ipptNetDelta: latest valid attempt minus the first, inside the series of
    // the man's latest IPPT (attempt numbers restart per series).
    { id: "ippt_change", label: "IPPT change (first to latest)", group: G.fit, type: "number",
      get: (r, ctx) => {
        const e = latest(r, ctx); if (!e) return null;
        const row = ctx.ipptSeriesRows[ipptSeriesOf(e)].get(r.id);
        return row && Object.keys(row.byAttempt).length >= 2 ? ipptNetDelta(row) : null;
      },
      tdStyle: (r, ctx) => { const v = COL.ippt_change.get(r, ctx); return v > 0 ? "color:var(--green);font-weight:600" : v < 0 ? "color:var(--red);font-weight:600" : ""; },
      text: (r, ctx) => { const v = COL.ippt_change.get(r, ctx); return v == null ? "" : (v > 0 ? "+" : "") + v; } },
    { id: "ytt", label: "YTT (IPPT KH)", group: G.fit, type: "bool", get: (r, ctx) => !isCmd(r) && !ctx.khTaken.has(r.id) },

    // Duty and attendance
    { id: "on_duty", label: "On duty today", group: G.duty, type: "enum", multi: true, get: (r, ctx) => ctx.dutyToday.get(r.id) || [] },
    { id: "duty_count", label: "Duties done", group: G.duty, type: "number",
      get: (r, ctx) => isCmd(r) ? dutyTallyOf(ctx.dutyTally, r.id).total : null },
    { id: "missed", label: "Conducts missed", group: G.duty, type: "number", get: (r, ctx) => ctx.missed[r.id] || 0 },

    // Qualifications. PES and SOC are real roster columns (0015);
    // THT shows weapons only, primary first, like the person card.
    field("pes", "PES", G.quals, "enum"),
    field("socLevel", "Latest SOC", G.quals, "enum"),
    { id: "tht", label: "THT weapons", group: G.quals, type: "enum", multi: true, get: r => thtWeapons(r) },
    { id: "quals", label: "Qualifications", group: G.quals, type: "enum", multi: true,
      get: r => getQuals(r).map(q => q.name).sort((a, b) => a.localeCompare(b)),
      td: "text-align:left;white-space:normal;max-width:220px;font-size:11px" },

    // Personal (sensitive). Decrypted by roster_api_row on every read, so they
    // are in STATE.roster for every signed-in device already (the person card
    // shows them). Off by default; only the Contacts / NOK preset turns them on.
    field("dob", "DOB", G.personal),
    field("bloodType", "Blood type", G.personal, "enum"),
    field("allergies", "Allergies", G.personal, "text", { td: "text-align:left;white-space:normal;max-width:220px;font-size:11px" }),
    field("otherMedical", "Other medical", G.personal, "text", { td: "text-align:left;white-space:normal;max-width:220px;font-size:11px" }),
    field("nokName", "NOK name", G.personal),
    field("nokRelation", "NOK relation", G.personal, "enum"),
    field("nokPhone", "NOK phone", G.personal),
    field("address", "Address", G.personal, "text", { td: "text-align:left;white-space:normal;max-width:240px;font-size:11px" }),
  ];
  const COL = Object.fromEntries(COLUMNS.map(c => [c.id, c]));
  const GROUPS = Object.values(G);
  const SENSITIVE = new Set(COLUMNS.filter(c => c.group === G.personal).map(c => c.id));

  // ── Reading a column ──────────────────────────────────────────────────────
  // Every accessor tolerates a blank record and a throwing helper: one broken
  // column must cost one empty cell, never the whole roster.
  function getVal(c, r, ctx) {
    try { return c.get(r || {}, ctx); } catch (e) { return c.type === "bool" ? false : c.type === "number" ? null : ""; }
  }
  function textOf(c, r, ctx) {
    try {
      if (c.text) return String(c.text(r || {}, ctx) ?? "");
      const v = getVal(c, r, ctx);
      if (Array.isArray(v)) return v.join(", ");
      if (c.type === "bool") return v ? "Yes" : "No";
      if (c.type === "date") return v ? isoToDisplayDate(v) : "";
      return v == null ? "" : String(v);
    } catch (e) { return ""; }
  }
  function cellOf(c, r, ctx) {
    try {
      if (c.cell) return c.cell(r || {}, ctx);
      if (c.type === "bool") return boolCell(getVal(c, r, ctx));
      if (c.type === "date") { const v = getVal(c, r, ctx); return v ? escapeHtml(isoToShortDate(v)) : DASH; }
      const t = textOf(c, r, ctx);
      return t === "" ? DASH : escapeHtml(t);
    } catch (e) { return DASH; }
  }
  function tdStyleOf(c, r, ctx) {
    try { return c.tdStyle ? c.tdStyle(r || {}, ctx) : (c.td || ""); } catch (e) { return c.td || ""; }
  }
  function sortVal(c, r, ctx) {
    try {
      if (c.sort) return c.sort(r || {}, ctx);
      const v = getVal(c, r, ctx);
      if (Array.isArray(v)) return v.join(", ");
      return v;
    } catch (e) { return null; }
  }
  // Enum values as a list (an enum column may return one value or several).
  const enumVals = (c, r, ctx) => { const v = getVal(c, r, ctx); return (Array.isArray(v) ? v : [v]).map(x => String(x ?? "")); };

  // ── Presets ───────────────────────────────────────────────────────────────
  // Default is EXACTLY the Roster columns as they were, so nobody sees a change
  // until they pick another preset.
  const PRESETS = [
    { id: "default", label: "Default", cols: ["d4", "name", "role", "status", "camp", "bmi", "rsis"] },
    { id: "daily", label: "Daily strength", cols: ["d4", "name", "plt", "sect", "camp", "out_reason", "back_on", "status", "on_duty"] },
    { id: "out", label: "Out of camp", cols: ["d4", "name", "plt", "out_kind", "out_reason", "back_on", "camp"], chips: ["out"] },
    { id: "medical", label: "Medical", cols: ["d4", "name", "plt", "status", "med_until", "mc_in_camp", "recovery", "rsis", "rs_30", "rs_last", "next_appt", "msk_regions"] },
    { id: "ippt", label: "IPPT", cols: ["d4", "name", "plt", "ippt_which", "ippt_score", "ippt_award", "ippt_run", "ippt_best", "ippt_change", "ytt"] },
    { id: "leave", label: "Leave", cols: ["d4", "name", "plt", "on_leave", "leave_type", "next_leave", "leave_quota", "al_used", "al_left", "oil_left"] },
    { id: "quals", label: "Qualifications", cols: ["d4", "name", "plt", "sect", "pes", "socLevel", "tht", "quals"] },
    { id: "contacts", label: "Contacts / NOK", cols: ["d4", "name", "phone", "email", "nokName", "nokRelation", "nokPhone", "address", "dob", "bloodType", "allergies", "otherMedical"] },
  ];

  // ── Quick filter chips ────────────────────────────────────────────────────
  // Each chip has two one-tap actions: its label shows only (+), its − hides
  // (excludes); tapping the one in force again clears it. `s.chips` holds the
  // shown-only ids and `s.xchips` the hidden ones. A chip and its `excludes`
  // partner are complements, so setting either one clears the other.
  // Mounted / Dismounted replaced the Roster's own mount picker, so every
  // filter on this screen lives in one place; a mixed role counts as both.
  const CHIPS = [
    { id: "incamp", label: "In camp", test: (r, ctx) => !ctx.outMap.has(r.id), excludes: "out" },
    { id: "out", label: "Out of camp", test: (r, ctx) => ctx.outMap.has(r.id), excludes: "incamp" },
    { id: "status", label: "On status", test: (r, ctx) => statusesOf(r, ctx).length > 0 },
    // MC, Warded and Hospitalisation Leave rank 100, LD 80 (medSeverityRank),
    // and only while active - a +1/+2 recovery day is not on MC/LD.
    { id: "mcld", label: "On MC/LD", test: (r, ctx) => statusesOf(r, ctx).some(s => s.ghostDay === 0 && medSeverityRank(s.tag) >= 80) },
    { id: "leave", label: "On leave", test: (r, ctx) => ctx.leaveToday.has(r.id) },
    { id: "appt", label: "Appointment today", test: (r, ctx) => ctx.apptToday.has(r.id) },
    { id: "mounted", label: "Mounted", test: r => ["mounted", "both"].includes(mountOf(r)) },
    { id: "dismounted", label: "Dismounted", test: r => ["dismounted", "both"].includes(mountOf(r)) },
  ];
  const CHIP = Object.fromEntries(CHIPS.map(c => [c.id, c]));

  // ── Per-device state (localStorage `cougar-nr-v1`) ─────────────────────────
  // Own key, not inside STORAGE_KEY, so clearing the data cache keeps a man's
  // views. Every access is guarded: a private window or a full quota must cost
  // the preference, never the roster.
  const blank = () => ({ v: 1, preset: "default", cols: null, chips: [], xchips: [], filters: {}, sort: null, custom: [] });
  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { raw = null; }
    return sanitize(raw);
  }
  function sanitize(raw) {
    const s = blank();
    if (!raw || typeof raw !== "object") return s;
    const okCols = a => Array.isArray(a) ? [...new Set(a.filter(id => COL[id]))] : null;
    s.custom = Array.isArray(raw.custom) ? raw.custom
      .filter(p => p && typeof p.id === "string" && /^u[\w-]+$/.test(p.id))
      .map(p => {
        const v = { id: p.id, label: String(p.label || "My view").slice(0, 40), cols: okCols(p.cols) || [] };
        // A saved view also keeps its filters; an older preset is columns only.
        if (p.filters && typeof p.filters === "object") Object.assign(v, cleanView(p));
        return v;
      })
      .filter(p => p.cols.length) : [];
    s.preset = presetById(raw.preset, s.custom) ? raw.preset : "default";
    const cols = okCols(raw.cols);
    s.cols = cols && cols.length ? cols : null;
    Object.assign(s, cleanView(raw));
    return s;
  }
  // The row-narrowing half of a view: chips, column filters and the sort.
  function cleanView(raw) {
    const chips = Array.isArray(raw.chips) ? [...new Set(raw.chips.filter(id => CHIP[id]))] : [];
    const xchips = Array.isArray(raw.xchips) ? [...new Set(raw.xchips.filter(id => CHIP[id] && !chips.includes(id)))] : [];
    const filters = {};
    if (raw.filters && typeof raw.filters === "object") {
      Object.keys(raw.filters).forEach(id => {
        const f = COL[id] ? cleanFilter(raw.filters[id], COL[id]) : null;
        if (f) filters[id] = f;
      });
    }
    const sort = raw.sort && COL[raw.sort.id] ? { id: raw.sort.id, dir: raw.sort.dir === "desc" ? "desc" : "asc" } : null;
    return { chips, xchips, filters, sort };
  }
  function save(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); return true; } catch (e) { return false; }
  }
  function presetById(id, custom) {
    return PRESETS.find(p => p.id === id) || (custom || []).find(p => p.id === id) || null;
  }
  function visibleCols(s) {
    const p = presetById(s.preset, s.custom) || PRESETS[0];
    return (s.cols || p.cols).filter(id => COL[id]).map(id => COL[id]);
  }
  // Columns changed away from the preset without being saved as one.
  function isModified(s) {
    if (!s.cols) return false;
    const p = presetById(s.preset, s.custom) || PRESETS[0];
    return s.cols.join(",") !== p.cols.join(",");
  }
  // A saved view (a custom preset with filters) brings its filters with it.
  // Any other preset is a column layout: the filters in force stay, so
  // switching from Default to IPPT keeps "PL 2, not on MC". A preset's own
  // chips (Out of camp) come on with it and go off when you leave it.
  function applyPreset(s, id) {
    const p = presetById(id, s.custom);
    if (!p) return s;
    if (p.filters) return Object.assign({}, s, { preset: p.id, cols: null }, cleanView(p));
    const prev = (presetById(s.preset, s.custom) || {}).chips || [];
    const own = p.chips || [];
    const chips = [...new Set((s.chips || []).filter(c => !prev.includes(c)).concat(own))];
    const xchips = (s.xchips || []).filter(c => !own.includes(c));
    const keepSort = s.sort && p.cols.includes(s.sort.id) ? s.sort : null;
    return Object.assign({}, s, { preset: p.id, cols: null, chips, xchips, sort: keepSort });
  }
  // Save what is on screen - columns, chips, filters, sort - as a named view.
  function saveView(s, label) {
    const id = "u" + Date.now().toString(36);
    const view = Object.assign({ id, label: String(label || "My view").trim().slice(0, 40) || "My view",
      cols: visibleCols(s).map(c => c.id) }, cleanView(s));
    return Object.assign({}, s, { custom: (s.custom || []).concat(view), preset: id, cols: null });
  }
  // "in" (show only), "out" (excluded) or "" (off).
  const chipState = (s, id) => (s.chips || []).includes(id) ? "in" : (s.xchips || []).includes(id) ? "out" : "";
  // want: "in" (the label) or "out" (the −). Tapping the state in force clears it.
  function toggleChip(s, id, want) {
    if (!CHIP[id] || !["in", "out"].includes(want)) return s;
    const next = chipState(s, id) === want ? "" : want;
    const drop = [id, CHIP[id].excludes].filter(Boolean);
    const chips = (s.chips || []).filter(c => !(next && drop.includes(c)) && c !== id);
    const xchips = (s.xchips || []).filter(c => !(next && drop.includes(c)) && c !== id);
    if (next === "in") chips.push(id);
    if (next === "out") xchips.push(id);
    return Object.assign({}, s, { chips, xchips });
  }
  function setSort(s, id, dir) {
    const same = s.sort && s.sort.id === id && s.sort.dir === dir;
    return Object.assign({}, s, { sort: same ? null : { id, dir } });
  }
  function cycleSort(s, id) {
    if (!COL[id]) return s;
    const cur = s.sort && s.sort.id === id ? s.sort.dir : "";
    const sort = cur === "" ? { id, dir: "asc" } : cur === "asc" ? { id, dir: "desc" } : null;
    return Object.assign({}, s, { sort });
  }

  // ── Row filtering + sorting ───────────────────────────────────────────────
  // A column filter is a set of conditions, and a row must meet all of them:
  //   in        values to SHOW ONLY: the row has one of them, or every one of
  //             them when `all` is set (only meaningful on a multi column)
  //   out       values to EXCLUDE: the row has none of them
  //   min, max  inclusive range on a number column
  //   from, to  inclusive ISO range on a date column
  // Exclusion is its own list rather than "every other value ticked". On a
  // ticked list, a man on MC and LD stays visible with MC unticked because LD
  // is still ticked, and a value that first appears tomorrow (a new status, a
  // new qualification) is hidden because nobody ticked it. Different columns
  // are AND. "No filter" is the key being absent. contains / is / op + v are
  // older shapes, still honoured so a saved view keeps working.
  const hasNum = x => x !== undefined && x !== null && x !== "" && typeof x !== "boolean" && !isNaN(+x);
  const isISO = x => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const LEGACY_OPS = ["today", "before", "after", "on"];

  // The canonical shape of a filter, or null when it filters nothing. With a
  // column, keys that mean nothing for its type are dropped.
  function cleanFilter(f, c) {
    if (!f || typeof f !== "object") return null;
    const strs = a => Array.isArray(a) ? [...new Set(a.filter(v => v != null && typeof v !== "object").map(String))] : [];
    const type = c && c.type;
    const o = {};
    // A date column's values are its display dates. Older saved views held
    // the cell text ("1 Dec 2026 (AL)"); that reduces to its date.
    const asDate = a => type === "date" ? [...new Set(a.map(v => v === "" ? "" : isoToDisplayDate(displayDateToISO(v)) || v))] : a;
    const inc = asDate(strs(f.in));
    const exc = asDate(strs(f.out)).filter(v => !inc.includes(v));
    if (inc.length) o.in = inc;
    if (exc.length) o.out = exc;
    if (o.in && f.all === true && (!c || c.multi)) o.all = true;
    if (!type || type === "number") {
      if (hasNum(f.min)) o.min = +f.min;
      if (hasNum(f.max)) o.max = +f.max;
    }
    if (!type || type === "date") {
      if (isISO(f.from)) o.from = f.from;
      if (isISO(f.to)) o.to = f.to;
      if (f.op === "today") o.op = "today";
      else if (LEGACY_OPS.includes(f.op) && isISO(f.v)) { o.op = f.op; o.v = f.v; }
    }
    if ((!type || type === "bool") && (f.is === "yes" || f.is === "no")) o.is = f.is;
    if (typeof f.contains === "string" && f.contains.trim()) o.contains = f.contains.trim();
    return Object.keys(o).length ? o : null;
  }
  const filterActive = (f, c) => !!cleanFilter(f, c);

  // The values a row offers a filter: each part of a multi column (a man who
  // is "2 LMG / Gunner" is under both), with "" when he has none, so a man
  // with no status or no qualification can still be picked or excluded; a
  // date column's display date; otherwise the cell text as shown.
  function filterVals(c, r, ctx) {
    if (c.type === "enum") { const v = enumVals(c, r, ctx); return v.length ? v : [""]; }
    if (c.type === "date") { const v = getVal(c, r, ctx); return [v ? isoToDisplayDate(v) : ""]; }
    return [textOf(c, r, ctx)];
  }
  // f must already be clean.
  function meets(c, f, r, ctx) {
    if (f.in || f.out) {
      const vals = filterVals(c, r, ctx);
      if (f.in && !(f.all ? f.in.every(v => vals.includes(v)) : f.in.some(v => vals.includes(v)))) return false;
      if (f.out && f.out.some(v => vals.includes(v))) return false;
    }
    if (hasNum(f.min) || hasNum(f.max)) {
      const v = getVal(c, r, ctx);
      if (!hasNum(v)) return false;
      if (hasNum(f.min) && +v < f.min) return false;
      if (hasNum(f.max) && +v > f.max) return false;
    }
    if (f.from || f.to || f.op) {
      const v = getVal(c, r, ctx);
      if (!v) return false;
      if (f.from && v < f.from) return false;
      if (f.to && v > f.to) return false;
      if (f.op === "today" && v !== ctx.today) return false;
      if (f.op === "before" && !(v < f.v)) return false;
      if (f.op === "after" && !(v > f.v)) return false;
      if (f.op === "on" && v !== f.v) return false;
    }
    if (f.is && (f.is === "yes") !== !!getVal(c, r, ctx)) return false;
    if (f.contains && !textOf(c, r, ctx).toLowerCase().includes(f.contains.toLowerCase())) return false;
    return true;
  }
  function passes(c, f, r, ctx) {
    const clean = cleanFilter(f, c);
    return !clean || meets(c, clean, r, ctx);
  }

  // ── Editing a filter (pure: each returns the next state) ──────────────────
  // A value's state on a column: "in" (shown only), "out" (excluded) or "".
  const valueState = (f, v) => f && (f.in || []).includes(v) ? "in" : f && (f.out || []).includes(v) ? "out" : "";
  function withFilter(s, id, f) {
    const filters = Object.assign({}, s.filters);
    const clean = COL[id] ? cleanFilter(f, COL[id]) : null;
    if (clean) filters[id] = clean; else delete filters[id];
    return Object.assign({}, s, { filters });
  }
  // Put values in one state: "in", "out" or "" (cleared).
  function setValues(s, id, vals, state) {
    if (!COL[id]) return s;
    const f = Object.assign({}, s.filters[id] || {});
    const set = new Set(vals.map(String));
    f.in = (f.in || []).filter(x => !set.has(x)).concat(state === "in" ? [...set] : []);
    f.out = (f.out || []).filter(x => !set.has(x)).concat(state === "out" ? [...set] : []);
    return withFilter(s, id, f);
  }
  // One tap, as on the chips: want "in" (the value itself: show only) or
  // "out" (its −: hide). Tapping the state a value already has clears it.
  // With several values ("All matching"), they all take `want` unless every
  // one already has it, in which case they all clear.
  function toggleValues(s, id, vals, want) {
    if (!["in", "out"].includes(want)) return s;
    const f = s.filters[id];
    const all = vals.length > 0 && vals.every(v => valueState(f, String(v)) === want);
    return setValues(s, id, vals, all ? "" : want);
  }
  const toggleValue = (s, id, v, want) => toggleValues(s, id, [v], want);
  function setMatchAll(s, id, all) {
    const f = Object.assign({}, s.filters[id] || {});
    if (all) f.all = true; else delete f.all;
    return withFilter(s, id, f);
  }
  // key: min / max (number columns) or from / to (date columns); "" clears it.
  function setRange(s, id, key, val) {
    if (!["min", "max", "from", "to"].includes(key)) return s;
    const f = Object.assign({}, s.filters[id] || {});
    if (val === "" || val == null) delete f[key]; else f[key] = val;
    return withFilter(s, id, f);
  }
  const clearFilter = (s, id) => withFilter(s, id, null);

  // ── A filter in words, for its pill above the table ───────────────────────
  // "MC or LD, not RSO" / "61 to 85" / "from 1 Dec". A long list names the
  // first two and counts the rest; the pill's title carries every value.
  function valueLabel(c, v) {
    if (v === "" && c && c.blankLabel) return c.blankLabel;
    if (c && c.vlabel) {
      try { const l = c.vlabel(v); if (l != null && l !== "") return String(l); } catch (e) { /* fall through */ }
    }
    return v === "" ? "(blank)" : String(v);
  }
  function listWords(c, vals, word, full) {
    const l = vals.map(v => valueLabel(c, v));
    if (l.length <= 1) return l.join("");
    if (!full && l.length > 3) return `${l[0]}, ${l[1]} ${word} ${l.length - 2} more`;
    return `${l.slice(0, -1).join(", ")} ${word} ${l[l.length - 1]}`;
  }
  function describeFilter(c, f, full) {
    f = cleanFilter(f, c);
    if (!c || !f) return "";
    const parts = [];
    if (f.in) parts.push(listWords(c, f.in, f.all ? "and" : "or", full));
    if (f.out) parts.push("not " + listWords(c, f.out, "or", full));
    if (hasNum(f.min) || hasNum(f.max)) {
      const n = x => c.range ? c.range.fmt(x) : `${x}`;
      parts.push(hasNum(f.min) && hasNum(f.max) ? (f.min === f.max ? n(f.min) : `${n(f.min)} to ${n(f.max)}`)
        : hasNum(f.min) ? `${n(f.min)} or more` : `${n(f.max)} or less`);
    }
    if (f.from || f.to) {
      const d = iso => isoToShortDate(iso);
      parts.push(f.from && f.to ? (f.from === f.to ? `on ${d(f.from)}` : `${d(f.from)} to ${d(f.to)}`)
        : f.from ? `from ${d(f.from)}` : `until ${d(f.to)}`);
    }
    if (f.op) parts.push(f.op === "today" ? "today" : `${f.op} ${isoToShortDate(f.v)}`);
    if (f.is) parts.push(f.is === "yes" ? "Yes" : "No");
    if (f.contains) parts.push(`contains "${f.contains}"`);
    return parts.join(", ");
  }

  function matchesSearch(r, cols, ctx, q) {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return true;
    if (String(r.id || "").toLowerCase().includes(needle)) return true;
    if (String(r.name || "").toLowerCase().includes(needle)) return true;
    return cols.some(c => textOf(c, r, ctx).toLowerCase().includes(needle));
  }
  // rows arrive in sortByRank order (the Default); a header tap re-sorts.
  // A filter on a column that is not shown still applies (its pill says so).
  function apply(rows, s, ctx, q) {
    const cols = visibleCols(s);
    const fs = Object.keys(s.filters || {})
      .map(id => [COL[id], COL[id] ? cleanFilter(s.filters[id], COL[id]) : null])
      .filter(([c, f]) => c && f);
    const inChips = (s.chips || []).filter(id => CHIP[id]);
    const outChips = (s.xchips || []).filter(id => CHIP[id]);
    let out = rows.filter(r =>
      inChips.every(id => CHIP[id].test(r, ctx)) &&
      outChips.every(id => !CHIP[id].test(r, ctx)) &&
      fs.every(([c, f]) => meets(c, f, r, ctx)) &&
      matchesSearch(r, cols, ctx, q));
    if (s.sort && COL[s.sort.id]) {
      const c = COL[s.sort.id];
      const dir = s.sort.dir === "desc" ? -1 : 1;
      const keyed = out.map((r, i) => ({ r, i, k: sortVal(c, r, ctx) }));
      const empty = k => k === null || k === undefined || k === "";
      keyed.sort((a, b) => {
        // Blanks sink to the bottom whichever way round.
        if (empty(a.k) !== empty(b.k)) return empty(a.k) ? 1 : -1;
        let d = 0;
        if (typeof a.k === "number" && typeof b.k === "number") d = a.k - b.k;
        else if (typeof a.k === "boolean" || typeof b.k === "boolean") d = (a.k ? 1 : 0) - (b.k ? 1 : 0);
        else d = String(a.k ?? "").localeCompare(String(b.k ?? ""), undefined, { numeric: true });
        return d * dir || a.i - b.i;
      });
      out = keyed.map(x => x.r);
    }
    return out;
  }
  // Column filters that narrow anything, in column-catalogue order.
  const activeFilterIds = s => COLUMNS.map(c => c.id).filter(id => s.filters && filterActive(s.filters[id], COL[id]));
  const activeFilterCount = s => activeFilterIds(s).length;
  // Anything at all narrowing the rows besides the page search.
  const narrowed = s => (s.chips || []).length + (s.xchips || []).length + activeFilterCount(s) > 0;

  // ── Export / copy ─────────────────────────────────────────────────────────
  // One object per row keyed by column label, in column order: what exportCSV
  // (Papa.unparse) turns into a header line plus rows.
  function csvRows(rows, cols, ctx) {
    return rows.map(r => {
      const o = {};
      cols.forEach(c => { o[c.label] = textOf(c, r, ctx); });
      return o;
    });
  }
  function copyText(rows, cols, ctx, title) {
    const lines = rows.map((r, i) => `${i + 1}. ${cols.map(c => textOf(c, r, ctx)).filter(t => t !== "").join(" - ")}`);
    return `${title}\n${cols.map(c => c.label).join(" - ")}\n\n${lines.join("\n")}`;
  }

  return {
    LS_KEY, COLUMNS, COL, GROUPS, PRESETS, CHIPS, CHIP, SENSITIVE,
    makeCtx, getVal, textOf, cellOf, tdStyleOf, sortVal, enumVals,
    blank, load, save, sanitize, presetById, visibleCols, isModified,
    applyPreset, saveView, chipState, toggleChip, cycleSort, setSort,
    cleanFilter, filterActive, filterVals, passes, apply, activeFilterIds, activeFilterCount, narrowed,
    valueState, setValues, toggleValue, toggleValues, setMatchAll, setRange, clearFilter,
    valueLabel, describeFilter,
    csvRows, copyText,
  };
})();

// Node unit suite reaches in through module.exports; browsers ignore this.
if (typeof module !== "undefined" && module.exports) module.exports = NR;
