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
// the markup calls (openNRColumns, sortNR ...) are plain functions in
// js/render.js, beside renderRoster, so telemetry can wrap them by name.
//
// Column shape:
//   { id, label, group, type: "text"|"enum"|"bool"|"number"|"date",
//     get(r, ctx)   raw value: string | string[] (enum) | boolean | number|null | ISO
//     text(r, ctx)  plain text for CSV / copy / search (defaults from get)
//     cell(r, ctx)  inner HTML of the <td> (defaults to escaped text)
//     td            static style for the <td>, or tdStyle(r, ctx)
//     th            static style for the <th>
//     sort(r, ctx)  sort key when get() is not the right one }
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
    fit: "Fitness", duty: "Duty and attendance", personal: "Personal (sensitive)",
  };
  const COLUMNS = [
    // Identity
    { id: "d4", label: "4D", group: G.id, type: "text", td: "font-weight:700;color:var(--accent)", tdClass: "mono",
      get: r => displayId(r.id) },
    { id: "name", label: "Name", group: G.id, type: "text", th: "text-align:left", td: "text-align:left", sticky: true,
      get: r => isCmd(r) ? `${r.rank ? r.rank + " " : ""}${r.name || ""}` : (r.name || "") },
    // The Default "Role" column: Commander badge, or section role + mount tag.
    { id: "role", label: "Role", group: G.id, type: "enum",
      get: r => isCmd(r) ? ["Commander"] : roleParts(r),
      text: r => isCmd(r) ? "Commander" : (r.billet || ""), sort: r => isCmd(r) ? "Commander" : (r.billet || ""),
      cell: r => isCmd(r) ? `<span class="badge badge-purple">Commander</span>` : `${r.billet ? escapeHtml(r.billet) : `<span style="color:var(--muted)">—</span>`}<div style="margin-top:2px">${mountBadge(r)}</div>` },
    { id: "rank", label: "Rank", group: G.id, type: "enum", get: r => rosterRank(r) },
    { id: "kind", label: "Cmdr / Rec", group: G.id, type: "enum", get: r => r.role || "" },
    { id: "plt", label: "Platoon", group: G.id, type: "enum", get: r => getPlt(r), text: r => getPlt(r) ? "PL " + getPlt(r) : "COY HQ" },
    { id: "sect", label: "Section", group: G.id, type: "enum", get: r => getSect(r) },
    field("appt", "Appt", G.id, "enum"),
    { id: "billet", label: "Section role", group: G.id, type: "enum",
      get: r => roleParts(r), text: r => r.billet || "", sort: r => r.billet || "" },
    { id: "mount", label: "Mounted", group: G.id, type: "enum",
      get: r => mountOf(r) ? MOUNT_LABEL[mountOf(r)] : "", cell: r => mountBadge(r) || DASH },
    { id: "groups", label: "Groups", group: G.id, type: "enum", get: r => getGroups(r), text: r => getGroups(r).join(", ") },
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
    { id: "status", label: "Status", group: G.med, type: "enum",
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
    { id: "recovery", label: "On recovery (+1/+2)", group: G.med, type: "enum",
      get: (r, ctx) => statusesOf(r, ctx).filter(s => s.ghostDay > 0).map(s => s.tag) },
    { id: "rsis", label: "RSIs", group: G.med, type: "number",
      get: (r, ctx) => ctx.rsiCount[r.id] || 0,
      tdStyle: (r, ctx) => `color:${(ctx.rsiCount[r.id] || 0) > 1 ? "var(--red)" : "var(--muted)"}`,
      cell: (r, ctx) => String(ctx.rsiCount[r.id] || 0) },
    { id: "rs_7", label: "RSIs (7 days)", group: G.med, type: "number", get: rsWithin(7) },
    { id: "rs_30", label: "RSIs (30 days)", group: G.med, type: "number", get: rsWithin(30) },
    { id: "rs_last", label: "Last report sick", group: G.med, type: "date",
      get: (r, ctx) => medDates(r, ctx).reduce((a, b) => (b > a ? b : a), "") },
    { id: "msk_regions", label: "MSK regions", group: G.med, type: "enum", get: r => getMSKRegionsForRecruit(r.id), text: r => getMSKRegionsForRecruit(r.id).join(", ") },
    { id: "msk_open", label: "MSK case open", group: G.med, type: "bool",
      get: r => { const rows = (STATE.msk || []).filter(m => m.d4 === r.id); return rows.length > 0 && !rows.every(m => m.cleared); } },
    field("msk", "MSK history (profile)", G.med, "text", { td: "text-align:left;white-space:normal;max-width:220px;font-size:11px" }),

    // Leave and movement
    { id: "on_leave", label: "On leave today", group: G.leave, type: "bool", get: (r, ctx) => ctx.leaveToday.has(r.id) },
    { id: "leave_type", label: "Leave type today", group: G.leave, type: "enum",
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
    { id: "ippt_run", label: "2.4 km", group: G.fit, type: "number", tdClass: "mono",
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
    { id: "on_duty", label: "On duty today", group: G.duty, type: "enum", get: (r, ctx) => ctx.dutyToday.get(r.id) || [] },
    { id: "duty_count", label: "Duties done", group: G.duty, type: "number",
      get: (r, ctx) => isCmd(r) ? dutyTallyOf(ctx.dutyTally, r.id).total : null },
    { id: "missed", label: "Conducts missed", group: G.duty, type: "number", get: (r, ctx) => ctx.missed[r.id] || 0 },

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
    { id: "contacts", label: "Contacts / NOK", cols: ["d4", "name", "phone", "email", "nokName", "nokRelation", "nokPhone", "address", "dob", "bloodType", "allergies", "otherMedical"] },
  ];

  // ── Quick filter chips ────────────────────────────────────────────────────
  const CHIPS = [
    { id: "incamp", label: "In camp", test: (r, ctx) => !ctx.outMap.has(r.id), excludes: "out" },
    { id: "out", label: "Out of camp", test: (r, ctx) => ctx.outMap.has(r.id), excludes: "incamp" },
    { id: "status", label: "On status", test: (r, ctx) => statusesOf(r, ctx).length > 0 },
    // MC, Warded and Hospitalisation Leave rank 100, LD 80 (medSeverityRank),
    // and only while active - a +1/+2 recovery day is not on MC/LD.
    { id: "mcld", label: "On MC/LD", test: (r, ctx) => statusesOf(r, ctx).some(s => s.ghostDay === 0 && medSeverityRank(s.tag) >= 80) },
    { id: "leave", label: "On leave", test: (r, ctx) => ctx.leaveToday.has(r.id) },
    { id: "appt", label: "Appointment today", test: (r, ctx) => ctx.apptToday.has(r.id) },
  ];
  const CHIP = Object.fromEntries(CHIPS.map(c => [c.id, c]));

  // ── Per-device state (localStorage `cougar-nr-v1`) ─────────────────────────
  // Own key, not inside STORAGE_KEY, so clearing the data cache keeps a man's
  // views. Every access is guarded: a private window or a full quota must cost
  // the preference, never the roster.
  const blank = () => ({ v: 1, preset: "default", cols: null, chips: [], filters: {}, sort: null, custom: [] });
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
      .map(p => ({ id: p.id, label: String(p.label || "My view").slice(0, 40), cols: okCols(p.cols) || [] }))
      .filter(p => p.cols.length) : [];
    s.preset = presetById(raw.preset, s.custom) ? raw.preset : "default";
    const cols = okCols(raw.cols);
    s.cols = cols && cols.length ? cols : null;
    s.chips = Array.isArray(raw.chips) ? raw.chips.filter(id => CHIP[id]) : [];
    s.filters = {};
    if (raw.filters && typeof raw.filters === "object") {
      Object.keys(raw.filters).forEach(id => { if (COL[id] && raw.filters[id] && typeof raw.filters[id] === "object") s.filters[id] = raw.filters[id]; });
    }
    s.sort = raw.sort && COL[raw.sort.id] ? { id: raw.sort.id, dir: raw.sort.dir === "desc" ? "desc" : "asc" } : null;
    return s;
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
  function applyPreset(s, id) {
    const p = presetById(id, s.custom);
    if (!p) return s;
    return Object.assign({}, s, { preset: p.id, cols: null, chips: (p.chips || []).slice(), filters: {}, sort: null });
  }
  function toggleChip(s, id) {
    if (!CHIP[id]) return s;
    let chips = s.chips.includes(id) ? s.chips.filter(c => c !== id) : s.chips.concat(id);
    const ex = CHIP[id].excludes;
    if (ex && chips.includes(id)) chips = chips.filter(c => c !== ex);
    return Object.assign({}, s, { chips });
  }
  function cycleSort(s, id) {
    if (!COL[id]) return s;
    const cur = s.sort && s.sort.id === id ? s.sort.dir : "";
    const sort = cur === "" ? { id, dir: "asc" } : cur === "asc" ? { id, dir: "desc" } : null;
    return Object.assign({}, s, { sort });
  }

  // ── Row filtering + sorting ───────────────────────────────────────────────
  function filterActive(f) {
    if (!f) return false;
    if (Array.isArray(f.in)) return f.in.length > 0;
    return ["contains", "is", "min", "max", "op"].some(k => f[k] !== undefined && f[k] !== "" && f[k] !== null);
  }
  function passes(c, f, r, ctx) {
    if (!filterActive(f)) return true;
    if (c.type === "enum") {
      const vals = enumVals(c, r, ctx);
      if (Array.isArray(f.in) && f.in.length && !f.in.some(v => vals.includes(v))) return false;
      return true;
    }
    if (c.type === "bool") {
      if (f.is === "yes") return !!getVal(c, r, ctx);
      if (f.is === "no") return !getVal(c, r, ctx);
      return true;
    }
    if (c.type === "number") {
      const v = getVal(c, r, ctx);
      const has = x => x !== undefined && x !== null && x !== "" && !isNaN(+x);
      if (!has(f.min) && !has(f.max)) return true;
      if (v == null || isNaN(+v)) return false;
      if (has(f.min) && +v < +f.min) return false;
      if (has(f.max) && +v > +f.max) return false;
      return true;
    }
    if (c.type === "date") {
      const v = getVal(c, r, ctx);
      if (!f.op) return true;
      if (f.op === "today") return v === ctx.today;
      if (!f.v) return true;
      if (!v) return false;
      if (f.op === "before") return v < f.v;
      if (f.op === "after") return v > f.v;
      if (f.op === "on") return v === f.v;
      return true;
    }
    const needle = String(f.contains || "").trim().toLowerCase();
    return !needle || textOf(c, r, ctx).toLowerCase().includes(needle);
  }
  function matchesSearch(r, cols, ctx, q) {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return true;
    if (String(r.id || "").toLowerCase().includes(needle)) return true;
    if (String(r.name || "").toLowerCase().includes(needle)) return true;
    return cols.some(c => textOf(c, r, ctx).toLowerCase().includes(needle));
  }
  // rows arrive in sortByRank order (the Default); a header tap re-sorts.
  function apply(rows, s, ctx, q) {
    const cols = visibleCols(s);
    let out = rows.filter(r =>
      s.chips.every(id => CHIP[id].test(r, ctx)) &&
      Object.keys(s.filters).every(id => passes(COL[id], s.filters[id], r, ctx)) &&
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
  const activeFilterCount = s => Object.keys(s.filters).filter(id => filterActive(s.filters[id])).length;

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
    applyPreset, toggleChip, cycleSort, filterActive, passes, apply, activeFilterCount,
    csvRows, copyText,
  };
})();

// Node unit suite reaches in through module.exports; browsers ignore this.
if (typeof module !== "undefined" && module.exports) module.exports = NR;
