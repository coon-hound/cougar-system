// View layer. render() dispatches to a per-tab function which fills #content.
// Each tab function may also (re)create charts; old chart instances are
// destroyed at the top of render() to avoid Chart.js canvas reuse errors.

// Last "what am I looking at" key, used to decide whether a render should
// reset the scroll position (see render()).
let _lastRenderCtx = null;

function render() {
  Object.values(STATE.charts).forEach(c => c.destroy());
  STATE.charts = {};

  // Reset scroll when the CONTEXT changes — the tab, or the topbar scope
  // filter. Both mean "you are looking at something new", so a long previous
  // view must not leave the next one pre-scrolled (on mobile that also hides
  // the topbar). A same-context re-render (an inline action, a dashboard
  // section being expanded) keeps the scroll position: collapsing a section
  // under your thumb and being thrown back to the top is the single most
  // disorienting thing a phone UI can do.
  const renderCtx = `${STATE.nav}|${isFilterActive() ? filterLabel() : ""}`;
  if (renderCtx !== _lastRenderCtx) {
    document.getElementById("content")?.scrollTo(0, 0);
    _lastRenderCtx = renderCtx;
  }

  // Keep filter dropdown options in sync with the current roster — cheap to
  // rebuild a few <option>s and means we don't have to remember to call this
  // from every site that mutates STATE.roster (pull, import, edit).
  if (typeof refreshFilterUI === "function") refreshFilterUI();

  const el = document.getElementById("content");
  const scoped = filteredRoster();
  const active = scoped.filter(r => r.status === "Active").length;
  const scopeLabel = isFilterActive() ? ` [${filterLabel()}]` : "";
  document.getElementById("str-counter").textContent = `Str: ${scoped.length} | Active: ${active}${scopeLabel}`;

  switch (STATE.nav) {
    case "dashboard": renderDashboard(el); break;
    case "roster": renderRoster(el); break;
    case "attendance": renderAttendance(el); break;
    case "detail": renderConductDetail(el); break;
    case "medical": renderMedical(el); break;
    case "ippt": renderIPPT(el); break;
    case "leave": renderLeave(el); break;
    case "duty": renderDuty(el); break;
    case "mskAnalytics": renderMSKAnalytics(el); break;
    case "conducts": renderConducts(el); break;
    case "usage": renderUsage(el); break;
    case "sync": renderSync(el); break;
    case "access": renderAccess(el); break;
    default: el.innerHTML = "";
  }
}

// ── Dashboard sections ───────────────────────────────────
// Every block below the stat tiles is one collapsible card whose HEADER IS
// THE SUMMARY: title, a count pill, and a one-line note. Closed, a section
// still answers "is there anything here for me today?", which is the only
// question a commander asks while walking. Open, it is the full table.
//
// Every section now defaults OPEN: the dashboard's job is to show the day
// without being clicked, and collapsing is the exception rather than the
// resting state. Only an explicit tap is remembered, so a quiet Tuesday can
// never permanently collapse a section that matters on Wednesday.
const DASH_OPEN_KEY = "cougar-dash-open";
let _dashOpen = (() => {
  // Must be a plain object: a corrupt or primitive value here would make
  // every toggle a silent no-op (property writes on primitives don't stick).
  try {
    const v = JSON.parse(localStorage.getItem(DASH_OPEN_KEY));
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
})();
// Defaults recorded at render time so toggleDashSection knows what it is
// flipping away from on the very first tap.
const _dashDefaults = {};

function dashSectionOpen(key, def) {
  return Object.prototype.hasOwnProperty.call(_dashOpen, key) ? !!_dashOpen[key] : !!def;
}

function toggleDashSection(key) {
  _dashOpen[key] = !dashSectionOpen(key, _dashDefaults[key]);
  try { localStorage.setItem(DASH_OPEN_KEY, JSON.stringify(_dashOpen)); } catch (e) {}
  render();
}

// Compact, quiet empty state. The full-air .empty-state is an invitation and
// belongs on a whole blank screen; inside a section it is just a fact, so it
// gets one line at body text size and nothing more.
function dashEmpty(text) {
  return `<div style="padding:11px 14px;font-size:11.5px;color:var(--dim)">${text}</div>`;
}

// Count pill for a section header. `token` is a CSS custom property NAME so
// both the ink and its wash derive from one palette entry.
function dashPill(n, token) {
  const c = `var(${token})`;
  return `<span class="mono" style="font-size:11px;font-weight:700;line-height:1.5;padding:1px 8px;border-radius:var(--rp);background:color-mix(in srgb, ${c} 15%, transparent);color:${c}">${n}</span>`;
}

// One section card. `body` is a FUNCTION so a closed section never pays to
// build HTML nobody sees. `action` is a SIBLING of the toggle button, never
// nested inside it, so "+ Book Out" can't also expand the section.
// `flush` runs a table edge-to-edge instead of insetting it in body padding.
function dashSection(o) {
  const open = dashSectionOpen(o.key, o.defaultOpen);
  _dashDefaults[o.key] = !!o.defaultOpen;
  const pill = o.count == null ? "" : dashPill(o.count, o.count ? (o.token || "--accent") : "--dim");
  return `<div class="card dash-sec" id="dash-${o.key}">
    <div class="dash-sec-head${open ? " open" : ""}">
      <button class="btn btn-ghost dash-sec-toggle" type="button" aria-expanded="${open}" aria-controls="dash-${o.key}-body" onclick="toggleDashSection('${o.key}')">
        <span aria-hidden="true" style="flex:0 0 9px;color:var(--dim);font-size:9px">${open ? "▼" : "▶"}</span>
        <span style="font-size:13px;font-weight:600;color:var(--text)"><span style="color:var(--dim);margin-right:6px" aria-hidden="true">${o.icon}</span>${o.title}</span>
        ${pill}
        ${o.note ? `<span class="dash-sec-note">${o.note}</span>` : ""}
      </button>
      ${o.action || ""}
    </div>
    ${open ? `<div id="dash-${o.key}-body" class="dash-sec-body${o.flush ? " flush" : ""}">${o.body()}</div>` : ""}
  </div>`;
}

// A table that sits flush inside a section card: the card already draws the
// border and the surface, so the wrap only keeps its scrolling.
function dashTable(head, rows) {
  return `<div class="table-wrap flush">
    <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Small header action (+ Book Out / + Book / + Log). Sits outside the toggle
// button so it is never swallowed by it. Height is deliberately left to .btn
// so it picks up the 40px thumb target from the mobile media query.
function dashAction(label, onclick, title) {
  return `<button class="btn btn-primary" type="button" title="${title}" onclick="${onclick}" style="flex:0 0 auto;font-size:11px">${label}</button>`;
}

function renderDashboard(el) {
  // Empty-state guard. The dashboard has nothing meaningful to show until
  // the roster loads, but the message depends on WHY it's empty: an
  // authenticated user is mid-pull (or the pull failed); an unauthenticated
  // visitor needs an invite link. Either way, the user should never see a
  // "click Pull from Sheet" prompt — that's an auto-handled step now.
  if (!STATE.roster.length) {
    const body = STATE.authToken
      ? `<p style="margin-bottom:8px">Loading data from the sheet…</p>
         <p style="font-size:11px;color:var(--dim)">If this stays empty for more than a few seconds, the sync may have failed. <button class="btn" onclick="doPull()" style="margin-left:6px">Retry now</button></p>`
      : `<p style="margin-bottom:8px">No invite redeemed on this device yet.</p>
         <p>Ask your admin for an invite link, then open it on this device — the app will sync automatically.</p>`;
    el.innerHTML = `
      <h2 style="font-size:18px;font-weight:700;margin-bottom:16px">Company Strength Board</h2>
      <div class="card empty-state">${body}</div>`;
    return;
  }

  const scoped = filteredRoster();
  const visible = visibleD4Set();
  const today = todayISO();
  // Derive non-active personnel from today's effective medical layer. A
  // recruit can have multiple simultaneous statuses (e.g. MC + Excuse Heavy
  // Load), all of which we want to surface on the dashboard. The "all"
  // variant returns every active status; we partition into live vs recovering
  // based on the recruit's *most-severe* tag (statuses[0]) so a recruit with
  // an active MC plus a ghost-tagged LD still sits in the live (red) table.
  const effectiveAll = currentMedicalEffectiveAll(today).filter(e => passesFilter(e.d4, visible));
  const allByD4 = Object.fromEntries(effectiveAll.map(e => [e.d4, e]));
  const topTag = r => allByD4[r.id]?.statuses[0];
  const liveRows = scoped.filter(r => topTag(r) && topTag(r).ghostDay === 0)
    .sort((a, b) => medSeverityRank(topTag(b).tag) - medSeverityRank(topTag(a).tag));
  const recoveringRows = scoped.filter(r => topTag(r) && topTag(r).ghostDay > 0)
    .sort((a, b) => topTag(a).ghostDay - topTag(b).ghostDay);
  const active = scoped.length - liveRows.length;
  // Out of Camp / In Camp use the SHARED computation (outOfCampMap): active
  // MC/Hosp Leave/Warded + active leave + manual book-outs. This is the SAME source the
  // parade state uses, so the dashboard "In Camp" and the parade COMPANY
  // present/strength always agree. (Note: "Non-Active" above is medical-only — a recruit on LD/
  // Excuse is non-active/restricted but still IN camp; only away medical (see
  // MED_AWAY_STATUSES) / leave/
  // booked-out count as out of camp.)
  const outMap = outOfCampMap(today);
  const outScoped = scoped.filter(r => outMap.has(r.id));
  const awayFromCamp = outScoped.length;
  const inCamp = scoped.length - awayFromCamp;
  const avgPart = STATE.attendance.length ? Math.round(STATE.attendance.reduce((a, c) => a + (c.participating / c.total * 100), 0) / STATE.attendance.length) : 0;
  const scopeBanner = isFilterActive() ? `<div style="font-size:11px;color:var(--accent);margin-bottom:8px">Scope: <strong>${filterLabel()}</strong> — Attendance figures remain company-wide.</div>` : "";

  // R/C breakdown — only shown when scope is "All". Helps reproduce the
  // parade-state-style "PLATOON x: y/z … COMMANDERS: a/b" split in one
  // glance without forcing a separate Commanders card.
  const isAll = !STATE.filterRole;
  const recRows = scoped.filter(r => r.role !== "Commander");
  const cmdRows = scoped.filter(r => r.role === "Commander");
  const recLive = liveRows.filter(r => r.role !== "Commander");
  const cmdLive = liveRows.filter(r => r.role === "Commander");
  const recActive = recRows.length - recLive.length;
  const cmdActive = cmdRows.length - cmdLive.length;
  const recAway = outScoped.filter(r => r.role !== "Commander").length;
  const cmdAway = outScoped.filter(r => r.role === "Commander").length;
  const recInCamp = recRows.length - recAway;
  const cmdInCamp = cmdRows.length - cmdAway;
  // "R n · C n" under the headline number. The big number is what a commander
  // reads at a glance; the breakdown is a footnote, so it lives in .stat .sub
  // at footnote size. Rendered as a blank line when scope is already narrowed
  // to one role, so tiles in a row keep a common height.
  const rcSub = (rec, cmd) => isAll ? `R ${rec} · C ${cmd}` : "&nbsp;";
  // A tile's colour is a signal, and a zero has nothing to signal. "Non-Active
  // 0" in alarm red says a problem where there is none, and six saturated
  // numerals compete with each other so none of them reads first. A zero goes
  // quiet; the colour returns the moment there is something to look at.
  const statInk = (n, token) => `color:var(${n ? token : "--dim"})`;

  // Today's date in the header: a parade state is always "as at" a date, and
  // this screen is read standing up with no other clock in view.
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dObj = new Date(today + "T00:00:00");
  const dateLabel = `${DOW[dObj.getDay()] || ""} · ${isoToDisplayDate(today)}`;

  // Order is operational, not structural: who is not here, why they are not
  // here, what is coming, then context. The charts are context and sit below
  // the tables. MSK returns null when the scope has no MSK rows at all (the
  // old dashboard hid the whole section in that case, and still does).
  const sections = [
    dashSecOutOfCamp(scoped, outMap),
    dashSecMedical(liveRows, recoveringRows, allByD4, today),
    dashSecAppointments(visible, today),
    dashSecLeaveOut(visible, today),
    dashSecTrends(avgPart),
    dashSecProfile(scoped),
    dashSecMSK(visible),
  ].filter(Boolean).map(dashSection).join("");

  el.innerHTML = `
    <div style="margin-bottom:14px">
      <!-- Deliberately NOT flex-wrap: the report menu is anchored right:0 to
           its wrapper, so the moment this row wraps on a phone the wrapper
           lands at the left edge and a 210px menu opens half off-screen. The
           title wraps to two lines instead; the button stays at the right. -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="min-width:0">
          <h2 style="font-size:18px;font-weight:700">Company Strength Board</h2>
          <div style="font-size:11px;color:var(--dim);margin-top:2px">${dateLabel}${isFilterActive() ? ` · <span style="color:var(--accent);font-weight:600">${filterLabel()}</span>` : ""}</div>
        </div>
        <div class="dropdown-wrapper" style="flex:0 0 auto">
          <button class="btn btn-primary" onclick="toggleReportMenu(event)">Generate Report ▾</button>
          <div id="report-menu" class="dropdown-menu hidden">
            <button type="button" onclick="openReportModal('FP'); closeReportMenu()"><span style="color:var(--dim);margin-right:8px" aria-hidden="true">◱</span>First Parade State</button>
            <button type="button" onclick="openReportModal('LP'); closeReportMenu()"><span style="color:var(--dim);margin-right:8px" aria-hidden="true">◳</span>Last Parade State</button>
            <button type="button" onclick="openReportModal('MED'); closeReportMenu()"><span style="color:var(--dim);margin-right:8px" aria-hidden="true">✚</span>Medical Status List</button>
            <button type="button" onclick="openReportModal('MSK'); closeReportMenu()"><span style="color:var(--dim);margin-right:8px" aria-hidden="true">⊕</span>MSK Report</button>
            <button type="button" onclick="openReportModal('CONDUCT'); closeReportMenu()"><span style="color:var(--dim);margin-right:8px" aria-hidden="true">▤</span>Per-Conduct Chat Format</button>
            <button type="button" onclick="openCompareModal(); closeReportMenu()"><span style="color:var(--dim);margin-right:8px" aria-hidden="true">⇄</span>Compare Parade States</button>
          </div>
        </div>
      </div>
      ${scopeBanner}
    </div>
    <div class="stats-row">
      <div class="stat"><label>Total Str</label><div class="val">${scoped.length}</div><div class="sub">${rcSub(recRows.length, cmdRows.length)}</div></div>
      <div class="stat"><label>In Camp</label><div class="val" style="${statInk(inCamp, "--teal")}">${inCamp}</div><div class="sub">${rcSub(recInCamp, cmdInCamp)}</div></div>
      <div class="stat"><label>Out of Camp</label><div class="val" style="${statInk(awayFromCamp, "--orange")}">${awayFromCamp}</div><div class="sub">${rcSub(recAway, cmdAway)}</div></div>
      <div class="stat"><label>Active today</label><div class="val" style="${statInk(active, "--green")}">${active}</div><div class="sub">${rcSub(recActive, cmdActive)}</div></div>
      <div class="stat"><label>Non-Active</label><div class="val" style="${statInk(liveRows.length, "--red")}">${liveRows.length}</div><div class="sub">${rcSub(recLive.length, cmdLive.length)}</div></div>
      <div class="stat"><label>Avg Part.</label><div class="val" style="color:var(--accent)">${avgPart}%</div><div class="sub">${STATE.attendance.length ? `${STATE.attendance.length} conduct${STATE.attendance.length === 1 ? "" : "s"}` : "no conducts yet"}</div></div>
    </div>
    ${sections}`;

  // Charts exist only while the Trends section is open, and only when Chart.js
  // actually loaded (it comes off a CDN, so a phone with no signal — or an
  // offline test run — must not take an exception here).
  if (!dashSectionOpen("trends", true) || typeof Chart === "undefined") return;
  if (!document.getElementById("chart-status")) return;

  // Status Breakdown chart: tally every active status (a recruit on MC +
  // Excuse contributes once to each slice). The "Active" slice is per-recruit
  // so it adds up to roster size only when nobody has stacked statuses.
  const statusCounts = { Active: active };
  effectiveAll.forEach(e => e.statuses.forEach(s => { statusCounts[s.tag] = (statusCounts[s.tag] || 0) + 1; }));
  // Canvas needs real colour strings, so resolve the tokens once here rather
  // than once per slice.
  const CK = {
    green: cssColor("--green"), red: cssColor("--red"), orange: cssColor("--orange"),
    yellow: cssColor("--yellow"), accent: cssColor("--accent"), muted: cssColor("--muted"),
    border: cssColor("--border"), surface: cssColor("--surface")
  };
  const chartColor = label => {
    if (label === "Active") return CK.green;
    if (label === "MC" || label === "Warded" || label === MED_HOSP_LEAVE) return CK.red;
    if (label === "LD" || label === "MC+1") return CK.orange;
    if (label === "LD+1" || label === "MC+2") return CK.yellow;
    if (label === "RMJ" || (typeof label === "string" && label.startsWith("Excuse"))) return CK.accent;
    return CK.muted;
  };
  STATE.charts.status = new Chart(document.getElementById("chart-status"), {
    type: "doughnut",
    // borderColor must be set explicitly: Chart.js defaults a doughnut's
    // segment border to white, which draws a bright ring on a dark card.
    // Keys stay the full status (that is what chartColor matches on); the
    // legend shows the phone-width shorthand.
    data: { labels: Object.keys(statusCounts).map(medStatusShortLabel), datasets: [{ data: Object.values(statusCounts), backgroundColor: Object.keys(statusCounts).map(chartColor), borderColor: CK.surface, borderWidth: 3 }] },
    // maintainAspectRatio:false → fill the .chart-box wrapper's fixed height
    // instead of deriving a height from the canvas width, which is what used
    // to grow this doughnut to ~500px on a desktop card.
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "58%",
      plugins: { legend: { position: "right", labels: { color: CK.muted, font: { size: 10 }, boxWidth: 9, boxHeight: 9, padding: 7 } } }
    }
  });

  // Participation trend — a smooth line whose color ENCODES participation
  // health using the same thresholds as the attendance table: green ≥95%
  // (healthy), amber ≥70% (watch), red <70% (problem). Each point is colored
  // by its own rate; each segment takes the color of the rate it descends/rises
  // INTO, so the eye is drawn to where participation drops into a bad conduct.
  // Plot chronologically — oldest conduct on the left, newest on the right.
  const partRows = [...STATE.attendance].sort((a, b) => {
    const ai = displayDateToISO(a.date) || a.date || "";
    const bi = displayDateToISO(b.date) || b.date || "";
    if (ai !== bi) return ai < bi ? -1 : 1;
    return (a.time || "") < (b.time || "") ? -1 : 1;
  });
  const partData = partRows.map(a => pct(a.participating, a.total));
  const rateColorHex = r => r >= 95 ? CK.green : r >= 70 ? CK.orange : CK.red;
  const partColors = partData.map(rateColorHex);
  STATE.charts.participation = new Chart(document.getElementById("chart-participation"), {
    type: "line",
    data: { labels: partRows.map(a => conductName(a.conductId).slice(0, 12)), datasets: [{
      data: partData,
      borderColor: CK.muted,
      borderWidth: 2,
      tension: 0.35,
      fill: false,
      pointRadius: 4,
      pointHoverRadius: 7,
      pointBackgroundColor: partColors,
      pointBorderColor: partColors,
      // Color each segment by the rate it lands on (the later point), so a drop
      // into a weak conduct turns the descending line red/amber.
      segment: { borderColor: ctx => rateColorHex(partData[ctx.p1DataIndex]) }
    }] },
    // No fixed min/max — let the axis auto-scale around the data so dips below
    // 80% are visible instead of being clipped off the bottom.
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { grace: "10%", grid: { color: CK.border }, ticks: { color: CK.muted, font: { size: 9 }, maxTicksLimit: 5 } }, x: { grid: { display: false }, ticks: { color: CK.muted, font: { size: 9 }, maxRotation: 0, autoSkipPadding: 8 } } }
    }
  });
}

// "Non-Active" section — live medical statuses today, plus the post-status
// Recovering (ghost tag) list. The closed header already answers "how many,
// and of what", which is the whole reason a commander opens this screen.
function dashSecMedical(liveRows, recoveringRows, allByD4, today) {
  const tagCounts = {};
  liveRows.forEach(r => { const t = allByD4[r.id].statuses[0].tag; tagCounts[t] = (tagCounts[t] || 0) + 1; });
  const tagNote = Object.entries(tagCounts).map(([t, n]) => `${n} ${t}`).join(" · ");
  const note = liveRows.length
    ? tagNote + (recoveringRows.length ? ` · ${recoveringRows.length} recovering` : "")
    : (recoveringRows.length ? `all Active · ${recoveringRows.length} recovering` : "everyone Active today");

  const body = () => {
    const live = liveRows.length
      ? `<div style="padding:9px 14px 0;font-size:10px;color:var(--dim)">Live medical status on ${isoToDisplayDate(today)}</div>` + dashTable(
          `<th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Status today</th><th style="text-align:left">Reason</th><th style="text-align:left">Duration</th>`,
          liveRows.map(r => {
            const entry = allByD4[r.id];
            const multi = entry.statuses.length > 1;
            // Stack badges, reasons, and durations vertically so each cell aligns
            // row-by-row across the three columns when a recruit has 2+ statuses.
            const tagsCell = entry.statuses.map(s => `<div style="padding:2px 0">${medTagBadge(s.tag)}</div>`).join("");
            const reasonsCell = entry.statuses.map(s => `<div style="padding:2px 0">${s.record.reason || '<span style="color:var(--dim)">—</span>'}</div>`).join("");
            // Durations span the whole run (medStatusRun), so an MC extended by a
            // second record shows the date they're actually back — not the first
            // record's end, which reads as an earlier return.
            const durationsCell = entry.statuses.map(s => `<div style="padding:2px 0">${medDurationLabel(s.record, medStatusRun(s.record))}</div>`).join("");
            const multiHint = multi ? ` <span style="font-size:9px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.5px">×${entry.statuses.length}</span>` : "";
            return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer"><td class="mono" style="font-weight:700;color:var(--accent);vertical-align:top">${displayId(r.id)}</td><td style="text-align:left;vertical-align:top">${displayPersonLabel(r.id)}${multiHint}</td><td style="text-align:left;vertical-align:top">${tagsCell}</td><td style="text-align:left;font-size:11px;vertical-align:top">${reasonsCell}</td><td style="text-align:left;font-size:11px;color:var(--muted);vertical-align:top">${durationsCell}</td></tr>`;
          }).join(""))
      : dashEmpty("All scoped personnel are Active today.");

    const recovering = recoveringRows.length
      ? `<div style="padding:11px 14px 6px;border-top:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted)">Recovering <span style="color:var(--dim);font-weight:400">— post-MC/LD ghost tag, back to training but monitor</span></div>` + dashTable(
          `<th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Tag</th><th style="text-align:left">Original</th><th style="text-align:left">Cleared</th>`,
          recoveringRows.map(r => {
            const entry = allByD4[r.id];
            const tagsCell = entry.statuses.map(s => `<div style="padding:2px 0">${medTagBadge(s.tag)}</div>`).join("");
            const originalCell = entry.statuses.map(s => `<div style="padding:2px 0">${s.record.status} · ${s.record.reason || ''}</div>`).join("");
            const clearedCell = entry.statuses.map(s => `<div style="padding:2px 0">${s.record.endDate || ''}</div>`).join("");
            return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer"><td class="mono" style="font-weight:700;color:var(--accent);vertical-align:top">${displayId(r.id)}</td><td style="text-align:left;vertical-align:top">${displayPersonLabel(r.id)}</td><td style="text-align:left;vertical-align:top">${tagsCell}</td><td style="text-align:left;font-size:11px;color:var(--muted);vertical-align:top">${originalCell}</td><td style="text-align:left;font-size:11px;color:var(--muted);vertical-align:top">${clearedCell}</td></tr>`;
          }).join(""))
      : "";

    return live + recovering;
  };

  return {
    key: "medical", icon: "✚", title: "Non-Active",
    count: liveRows.length, token: "--red", note,
    defaultOpen: true,
    flush: true, body,
  };
}

// "Trends" — the two charts. They are context, not the answer, so they sit
// below every table and inside a fixed-height .chart-box: Chart.js's
// responsive default derives height from width, which is what used to grow
// the doughnut to half a desktop screen.
function dashSecTrends(avgPart) {
  const note = STATE.attendance.length
    ? `${avgPart}% average participation${isFilterActive() ? " · company-wide, not scoped" : ""}`
    : "no conducts logged yet";
  const body = () => `<div class="grid-2">
    <div>
      <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:7px">Status breakdown (today)</div>
      <div class="chart-box tall"><canvas id="chart-status"></canvas></div>
    </div>
    <div>
      <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:7px">Participation trend</div>
      <div class="chart-box tall"><canvas id="chart-participation"></canvas></div>
    </div>
  </div>`;
  return { key: "trends", icon: "◲", title: "Trends", note, defaultOpen: true, body };
}

// Ration + allergy profile. Reference data rather than a daily answer, so it
// sits low on the page — but it opens with everything else.
function dashSecProfile(scoped) {
  // Ration: count distinct values. Unknowns get grouped under "Unspecified"
  // so they show up but don't disappear silently.
  const rationCounts = {};
  scoped.forEach(r => { const k = (r.ration || "").trim() || "Unspecified"; rationCounts[k] = (rationCounts[k] || 0) + 1; });
  const rationRows = Object.entries(rationCounts).sort((a, b) => b[1] - a[1]);
  const rationColor = k => k === "Muslim" ? "var(--green)" : k === "Non-Muslim" ? "var(--accent)" : "var(--muted)";

  // Allergies: each recruit's `allergies` is free text — split on comma so a
  // single "Peanuts, Dairy" entry counts toward two distinct allergens.
  const allergenCounts = {};
  const allergic = [];
  scoped.forEach(r => {
    const raw = (r.allergies || "").trim();
    if (!raw) return;
    allergic.push(r);
    raw.split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(a => {
      const key = a.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      allergenCounts[key] = (allergenCounts[key] || 0) + 1;
    });
  });
  const allergenRows = Object.entries(allergenCounts).sort((a, b) => b[1] - a[1]);
  const muslim = rationCounts["Muslim"] || 0;

  const body = () => `<div class="grid-2">
    <div>
      <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:7px">Ration breakdown</div>
      ${rationRows.length ? `<div style="display:flex;flex-direction:column;gap:6px">
        ${rationRows.map(([k, n]) => `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px"><span style="color:${rationColor(k)};font-weight:600">${k}</span><span class="mono" style="color:var(--muted)">${n} (${pct(n, scoped.length)}%)</span></div>`).join("")}
      </div>` : dashEmpty("No ration data.")}
    </div>
    <div>
      <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:7px">Allergies <span style="color:var(--dim);font-weight:400">(${allergic.length} recruit${allergic.length === 1 ? '' : 's'})</span></div>
      ${allergic.length ? `
        ${allergenRows.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${allergenRows.map(([a, n]) => `<span class="badge badge-yellow">${a} · ${n}</span>`).join("")}</div>` : ""}
        <div style="display:flex;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto">
          ${allergic.map(r => `<div onclick="openPerson('${r.id}')" style="cursor:pointer;font-size:11px;padding:4px 6px;border-radius:var(--r1);background:var(--surface2);display:flex;justify-content:space-between;gap:8px"><span><span class="mono" style="color:var(--accent);font-weight:700">${displayId(r.id)}</span> ${r.name}</span><span style="color:var(--yellow);text-align:right">${r.allergies}</span></div>`).join("")}
        </div>
      ` : dashEmpty("No recruits with allergies recorded.")}
    </div>
  </div>`;

  return {
    key: "profile", icon: "◍", title: "Ration & allergies",
    note: `${muslim} Muslim ration · ${allergic.length} with allergies`,
    defaultOpen: true, body,
  };
}

// Active MSK Cases — recruits who self-reported an injury via the Google
// Form ("Cougar MSK / Physio Log"). One card per recruit, aggregating
// their initial injury text, any physio appointment we have on file, and
// the timeline of exercises they've logged. Cleared cases are hidden by
// default behind a toggle. Returns null — so the section vanishes entirely —
// when the scope has no MSK rows at all, exactly as the old dashboard did.
function dashSecMSK(visible) {
  const scoped = STATE.msk.filter(m => passesFilter(m.d4, visible));
  if (!scoped.length) return null;

  // Group by d4. Per-d4: active if ANY row is not cleared. Cleared if all
  // are cleared.
  const byD4 = {};
  scoped.forEach(m => { (byD4[m.d4] = byD4[m.d4] || []).push(m); });

  const cases = Object.entries(byD4).map(([d4, rows]) => {
    const allCleared = rows.every(r => r.cleared);
    const injuries = rows.filter(r => (r.type || "").toLowerCase().includes("report"));
    const exercises = rows.filter(r => (r.type || "").toLowerCase().includes("log") || (r.type || "").toLowerCase().includes("exercise"));
    // Latest injury report as the headline; sort by timestamp desc.
    const tsOf = r => String(r.timestamp || r.Timestamp || "");
    const latestInjury = [...injuries].sort((a, b) => tsOf(a) < tsOf(b) ? 1 : -1)[0];
    const orderedExercises = [...exercises].sort((a, b) => tsOf(a) < tsOf(b) ? 1 : -1);
    return { d4, rows, allCleared, latestInjury, orderedExercises };
  });

  const active = cases.filter(c => !c.allCleared);
  const cleared = cases.filter(c => c.allCleared);

  const renderCard = (c, faded) => {
    const upcomingAppts = STATE.appointments.filter(a =>
      a.d4 === c.d4 && !a.resolved && (displayDateToISO(a.date) || "") >= todayISO()
    );
    const apptLine = upcomingAppts.length
      ? upcomingAppts.map(a => `<div style="font-size:11px;color:var(--accent)">📅 ${a.date}${a.time ? ` @ ${fmtHrs(a.time)}` : ""} — ${a.reason || ""} <span style="color:var(--muted)">(${a.location || ""})</span></div>`).join("")
      : `<div style="font-size:11px;color:var(--dim)">No physio appointment scheduled yet.</div>`;

    const injuryLine = c.latestInjury
      ? `<div style="font-size:12px"><span style="color:var(--muted)">Injury:</span> ${c.latestInjury.description || ""}</div>`
      : `<div style="font-size:12px;color:var(--dim)">No injury description on file.</div>`;

    // Body region chips — auto-classified by default, sergeant can re-tag
    // by clicking the pencil. Stored on the latest Report Injury row.
    const regions = c.latestInjury ? getMSKRegionsForRecruit(c.d4) : [];
    const regionsLine = c.latestInjury ? `<div style="margin-top:4px;display:flex;align-items:center;gap:4px;flex-wrap:wrap">
      ${regions.map(reg => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${MSK_REGION_COLORS[reg] || MSK_REGION_COLORS.Other}22;color:${MSK_REGION_COLORS[reg] || MSK_REGION_COLORS.Other}">${reg}</span>`).join("")}
      <button class="btn btn-icon" onclick="event.stopPropagation(); openMSKRegionMenu('${c.d4}')" title="Re-tag body regions" style="font-size:10px">✎ tag</button>
    </div>` : "";

    const exercises = c.orderedExercises.length
      ? `<div style="margin-top:6px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Physio visits (${c.orderedExercises.length})</div>${c.orderedExercises.map(e => {
          const d = e.physioDate || e.timestamp || "";
          const exText = e.exercises ? ` — ${e.exercises}` : ` <span style="color:var(--dim)">(no new exercises)</span>`;
          return `<div style="font-size:11px;padding:4px 6px;background:var(--bg);border-left:2px solid var(--teal);margin-bottom:3px"><span class="mono" style="color:var(--muted);font-size:10px">${d}</span>${exText}</div>`;
        }).join("")}</div>`
      : `<div style="font-size:11px;color:var(--dim);margin-top:6px">No physio visits logged yet.</div>`;

    return `<div class="card" style="padding:12px;margin:0;background:var(--surface2);${faded ? 'opacity:.55;' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
        <div onclick="openPerson('${c.d4}')" style="cursor:pointer;font-weight:700">${displayId(c.d4) ? `<span class="mono" style="color:var(--accent);margin-right:6px">${displayId(c.d4)}</span>` : ""}${displayPersonLabel(c.d4)} <span class="badge badge-pink" style="font-size:9px;margin-left:4px">🦵 MSK</span></div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn" style="font-size:11px" onclick="openAppointmentForm(null, {d4:'${c.d4}', reason:'Physio review', location:'Physio Centre'})" title="Book a physio appointment for this recruit">📅 Book</button>
          <button class="btn ${c.allCleared ? 'btn-success' : ''}" style="font-size:11px" onclick="toggleMSKCleared('${c.d4}')" title="${c.allCleared ? 'Reopen this case' : 'Mark this case cleared (hides from active list)'}">${c.allCleared ? '↺ Reopen' : '✓ Mark Cleared'}</button>
        </div>
      </div>
      ${injuryLine}
      ${regionsLine}
      ${apptLine}
      ${exercises}
    </div>`;
  };

  // Scrollable container — caps height so the MSK section doesn't push
  // the rest of the dashboard off-screen as cases accumulate. About 3
  // cards visible at a time; scroll for more.
  // The list caps at roughly three cards and scrolls inside itself; on a phone
  // that scrollbar is invisible, so say so when there is more than fits.
  const scrollHint = active.length > 3
    ? `<div style="font-size:10px;color:var(--dim);margin-bottom:5px">${active.length} cases — the list scrolls</div>`
    : "";
  const activeCards = active.length
    ? `${scrollHint}<div style="max-height:520px;overflow-y:auto"><div style="display:flex;flex-direction:column;gap:10px">${active.map(c => renderCard(c, false)).join("")}</div></div>`
    : dashEmpty("No active MSK cases.");

  const clearedSection = cleared.length
    ? `<div style="margin-top:12px"><button class="btn" style="font-size:11px" onclick="toggleMSKShowCleared()">${_mskShowCleared ? "▾ Hide" : "▸ Show"} cleared (${cleared.length})</button>${_mskShowCleared ? `<div style="max-height:400px;overflow-y:auto;margin-top:10px"><div style="display:flex;flex-direction:column;gap:10px">${cleared.map(c => renderCard(c, true)).join("")}</div></div>` : ""}</div>`
    : "";

  return {
    key: "msk", icon: "⊕", title: "MSK cases",
    count: active.length, token: "--pink",
    note: cleared.length ? `${cleared.length} cleared` : (active.length ? "" : "nothing open"),
    defaultOpen: true,
    body: () => activeCards + clearedSection,
  };
}

// ── MSK ANALYTICS PAGE ───────────────────────────────────
// Full-page injury aggregation: daily impact, region breakdown, most-
// affected personnel. Answers the CO's "how many injured and what kind?"
// at a glance. Date range pickers default to last 14 days; topbar scope
// filter narrows the population.
let _mskAnalyticsStart = "";
let _mskAnalyticsEnd = "";
const _mskAnalyticsCharts = {};

function setMSKAnalyticsRange() {
  _mskAnalyticsStart = gv("msk-an-start");
  _mskAnalyticsEnd = gv("msk-an-end");
  render();
}

// Drill-in: show all recruits currently classified under a body region,
// with the underlying source text (Form report + conductDetail reasons)
// so the sergeant can see WHY each one landed there. Especially useful
// for the "Other" bucket — surfaces injuries the auto-classifier couldn't
// tag, with a one-click Re-tag button to fix manually.
function viewMSKRegion(region) {
  const startIso = _mskAnalyticsStart;
  const endIso = _mskAnalyticsEnd;
  const visible = visibleD4Set();

  const inWindowReport = m => {
    if ((m.type || "").toLowerCase().indexOf("report") < 0) return false;
    if (!passesFilter(m.d4, visible)) return false;
    const iso = displayDateToISO(m.timestamp) || String(m.timestamp || "").slice(0, 10);
    return iso && iso >= startIso && iso <= endIso;
  };
  const inWindowCD = c => {
    if (!passesFilter(c.d4, visible)) return false;
    const iso = displayDateToISO(c.date);
    return iso && iso >= startIso && iso <= endIso && isMSKReason(c.reason);
  };

  // All d4s ever affected in this window
  const affectedD4s = new Set([
    ...STATE.msk.filter(inWindowReport).map(m => m.d4),
    ...STATE.conductDetail.filter(inWindowCD).map(c => c.d4)
  ]);

  // Keep only those whose resolved regions include this one
  const matching = [...affectedD4s].filter(d4 => getMSKRegionsForRecruit(d4).includes(region));

  // Gather source text per recruit so sergeant can see WHY they were classified.
  const cards = matching.map(d4 => {
    const reports = STATE.msk.filter(m => m.d4 === d4 && (m.type || "").toLowerCase().includes("report"));
    const cdRows = STATE.conductDetail.filter(c => c.d4 === d4 && isMSKReason(c.reason));
    const hasManual = reports.some(r => r.manualRegions && String(r.manualRegions).trim());
    const sources = [
      ...reports.map(r => ({ kind: "Form report", text: r.description || "—", color: "var(--pink)" })),
      ...cdRows.map(c => ({ kind: c.type, text: c.reason || "—", color: c.type === "PX" ? "var(--accent)" : c.type === "Fallout" ? "var(--red)" : "var(--orange)" }))
    ];
    const allRegions = getMSKRegionsForRecruit(d4);
    return { d4, sources, allRegions, hasManual };
  });

  const regionChipsHtml = regs => regs.map(reg => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${MSK_REGION_COLORS[reg] || MSK_REGION_COLORS.Other}22;color:${MSK_REGION_COLORS[reg] || MSK_REGION_COLORS.Other}">${reg}</span>`).join(" ");

  const body = `
    <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px;line-height:1.55">
      <strong style="color:${MSK_REGION_COLORS[region]}">${region}</strong> — ${matching.length} recruit${matching.length === 1 ? "" : "s"} classified${region === "Other" ? ". 'Other' means the keyword classifier couldn't tag them automatically — click <strong>Re-tag</strong> to fix manually." : ". Sources below show why each recruit was tagged."}
    </div>
    ${cards.length ? `<div style="display:flex;flex-direction:column;gap:8px;max-height:480px;overflow-y:auto;padding-right:4px">
      ${cards.map(c => `<div style="padding:10px 12px;background:var(--surface2);border-radius:6px;border-left:3px solid ${MSK_REGION_COLORS[region]}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <div style="display:flex;gap:8px;align-items:center">
            <span class="mono" style="color:var(--accent);font-weight:700">${displayId(c.d4)}</span>
            <span style="font-weight:600">${displayPersonLabel(c.d4)}</span>
            ${c.hasManual ? '<span style="font-size:9px;color:var(--green);text-transform:uppercase;letter-spacing:.5px">Manual override</span>' : ""}
          </div>
          <button class="btn" style="font-size:10px;padding:3px 8px" onclick="openMSKRegionMenu('${c.d4}')">✎ Re-tag</button>
        </div>
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Source text</div>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${c.sources.length ? c.sources.map(s => `<div style="font-size:11px;padding:4px 8px;background:var(--bg);border-left:2px solid ${s.color};border-radius:3px"><span style="color:${s.color};font-weight:600;font-size:10px">[${s.kind}]</span> ${s.text}</div>`).join("") : `<div style="font-size:11px;color:var(--dim)">No source text on file.</div>`}
        </div>
        <div style="margin-top:6px;font-size:10px;color:var(--muted)">All regions: ${regionChipsHtml(c.allRegions)}</div>
      </div>`).join("")}
    </div>` : `<div class="empty-state" style="padding:12px;font-size:12px">No recruits classified under this region in the current window.</div>`}
  `;

  openModal(`Region drill-in — ${region}`, body);
  document.querySelector(".modal")?.classList.add("wide");
}

function renderMSKAnalytics(el) {
  const today = todayISO();
  if (!_mskAnalyticsStart) {
    const d = new Date(today); d.setDate(d.getDate() - 13);
    _mskAnalyticsStart = d.toISOString().slice(0, 10);
  }
  if (!_mskAnalyticsEnd) _mskAnalyticsEnd = today;
  const startIso = _mskAnalyticsStart;
  const endIso = _mskAnalyticsEnd;

  // Scope: respect topbar role/platoon filter for which d4s count.
  const visible = visibleD4Set();

  // Build the date axis (every day from start to end inclusive).
  const dates = [];
  {
    const d0 = new Date(startIso), d1 = new Date(endIso);
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  const dateLabels = dates.map(iso => {
    const d = new Date(iso);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });

  // Filter conductDetail to MSK-only rows in scope + window.
  const mskConductRows = STATE.conductDetail.filter(c => {
    if (!passesFilter(c.d4, visible)) return false;
    const iso = displayDateToISO(c.date);
    if (!iso || iso < startIso || iso > endIso) return false;
    return isMSKReason(c.reason);
  });

  // Daily aggregation — unique d4s per type per day.
  const daily = dates.map(iso => {
    const dayRows = mskConductRows.filter(c => displayDateToISO(c.date) === iso);
    const px = new Set(dayRows.filter(c => c.type === "PX").map(c => c.d4));
    const fo = new Set(dayRows.filter(c => c.type === "Fallout").map(c => c.d4));
    const rsi = new Set(dayRows.filter(c => c.type === "RSI").map(c => c.d4));
    const total = new Set([...px, ...fo, ...rsi]);
    return { iso, px: px.size, fo: fo.size, rsi: rsi.size, total: total.size };
  });

  // Injury reports (STATE.msk type=Report Injury) in scope + window.
  const reportRows = STATE.msk.filter(m => {
    if ((m.type || "").toLowerCase().indexOf("report") < 0) return false;
    if (!passesFilter(m.d4, visible)) return false;
    const iso = displayDateToISO(m.timestamp) || String(m.timestamp || "").slice(0, 10);
    return iso && iso >= startIso && iso <= endIso;
  });
  // Unique injured personnel — union of Form reporters AND recruits who
  // appeared in MSK-classified conductDetail rows in this window. Closes
  // the gap where someone who falls out due to MSK at PT but never fills
  // the Form would be missing from the region breakdown.
  const injuredD4s = new Set([
    ...reportRows.map(r => r.d4),
    ...mskConductRows.map(c => c.d4)
  ]);

  // Region counts — unique recruits per region. Manual override wins.
  // getMSKRegionsForRecruit now also unions in regions derived from
  // conductDetail reasons, so no recruit gets dropped silently.
  const regionToRecruits = {};
  injuredD4s.forEach(d4 => {
    const regions = getMSKRegionsForRecruit(d4);
    regions.forEach(reg => {
      (regionToRecruits[reg] = regionToRecruits[reg] || new Set()).add(d4);
    });
  });
  const regionCounts = Object.entries(regionToRecruits)
    .map(([region, set]) => ({ region, count: set.size }))
    .sort((a, b) => b.count - a.count);

  // Personnel frequency from conductDetail (entries, not unique conducts).
  const freq = {};
  mskConductRows.forEach(c => {
    if (!freq[c.d4]) freq[c.d4] = { d4: c.d4, count: 0, types: new Set() };
    freq[c.d4].count++;
    freq[c.d4].types.add(c.type);
  });
  const ranked = Object.values(freq).sort((a, b) => b.count - a.count).slice(0, 15);
  const maxRanked = ranked[0]?.count || 1;

  // Chronic = has Report Injury AND ≥3 MSK conductDetail entries.
  const chronic = [...injuredD4s]
    .filter(d4 => (freq[d4]?.count || 0) >= 3)
    .map(d4 => ({ d4, count: freq[d4].count, regions: getMSKRegionsForRecruit(d4) }))
    .sort((a, b) => b.count - a.count);

  const regionChip = reg => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${MSK_REGION_COLORS[reg] || MSK_REGION_COLORS.Other}22;color:${MSK_REGION_COLORS[reg] || MSK_REGION_COLORS.Other};margin-right:3px">${reg}</span>`;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      <div style="min-width:0;flex:1 1 200px">
        <h2 style="font-size:18px;font-weight:700">📊 MSK Analytics${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}]</span>` : ""}</h2>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">Musculoskeletal injuries — sourced from MSK form reports + conduct detail rows filtered by injury keywords.</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;font-size:11px;flex-wrap:wrap;flex:1 1 220px;justify-content:flex-end">
        <span style="color:var(--muted)">Window:</span>
        <input id="msk-an-start" type="date" value="${startIso}" onchange="setMSKAnalyticsRange()" class="topbar-select" style="min-width:130px;flex:1 1 130px">
        <span style="color:var(--muted)">→</span>
        <input id="msk-an-end" type="date" value="${endIso}" onchange="setMSKAnalyticsRange()" class="topbar-select" style="min-width:130px;flex:1 1 130px">
      </div>
    </div>

    <div class="stats-row">
      <div class="stat"><label>Injured personnel</label><div class="val" style="color:var(--red)">${injuredD4s.size}</div></div>
      <div class="stat"><label>MSK log entries</label><div class="val" style="color:var(--orange)">${mskConductRows.length}</div></div>
      <div class="stat"><label>Injury regions</label><div class="val" style="color:var(--accent)">${regionCounts.length}</div></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Daily MSK Impact</h3>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.55">
        Unique personnel affected per day, MSK cases only. Stacked by category:<br>
        <span style="color:var(--accent);font-weight:600">■ Status</span> = pre-existing medical/excuse status before the conduct ·
        <span style="color:var(--red);font-weight:600">■ Fallout</span> = dropped out during the conduct ·
        <span style="color:var(--orange);font-weight:600">■ RSI</span> = reported sick at first parade
      </div>
      <div class="chart-box tall"><canvas id="msk-daily-bar"></canvas></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Total Affected Trend</h3>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Unique MSK cases per day across all types.</div>
      <div class="chart-box"><canvas id="msk-trend-line"></canvas></div>
    </div>

    <div class="grid-2" style="margin-bottom:14px">
      <div class="card">
        <h3>Injuries by Region <span style="color:var(--dim);font-weight:400;font-size:10px">— click any slice to drill in</span></h3>
        <div class="chart-box"><canvas id="msk-region-donut"></canvas></div>
      </div>
      <div class="card">
        <h3>Personnel per Region <span style="color:var(--dim);font-weight:400;font-size:10px">— click any bar to drill in</span></h3>
        <div class="chart-box"><canvas id="msk-region-bar"></canvas></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Reported Injuries Detail <span style="color:var(--dim);font-weight:400;font-size:11px">(${reportRows.length})</span></h3>
      ${reportRows.length ? `<div style="display:flex;flex-direction:column;gap:4px">
        ${reportRows.sort((a, b) => (a.timestamp || "") < (b.timestamp || "") ? 1 : -1).map(r => {
          const regions = getMSKRegionsForRecruit(r.d4);
          return `<div onclick="openMSKRegionMenu('${r.d4}')" style="cursor:pointer;font-size:12px;padding:8px 10px;background:var(--surface2);border-radius:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="mono" style="color:var(--accent);font-weight:700">${displayId(r.d4)}</span>
            <span style="font-weight:600">${displayPersonLabel(r.d4)}</span>
            <span style="flex:1 1 200px;min-width:0;color:var(--muted)">${r.description || ""}</span>
            <span style="display:flex;flex-wrap:wrap;gap:3px">${regions.map(regionChip).join("")}</span>
          </div>`;
        }).join("")}
      </div>` : `<div style="color:var(--muted);font-size:12px">No injury reports in this window.</div>`}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Most Affected Personnel</h3>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Ranked by MSK-related conduct detail entries (Status / Fallout / RSI).</div>
      ${ranked.length ? `<div style="display:flex;flex-direction:column;gap:4px">
        ${ranked.map((p, i) => `<div onclick="openPerson('${p.d4}')" style="cursor:pointer;font-size:11px;padding:6px 8px;background:var(--surface2);border-radius:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="color:var(--orange);font-weight:700;min-width:22px;text-align:right">${i + 1}</span>
          <span class="mono" style="color:var(--accent);font-weight:700">${displayId(p.d4)}</span>
          <span style="flex:1 1 110px;min-width:0">${displayPersonLabel(p.d4)}</span>
          <div style="flex:2 1 140px;min-width:80px;height:14px;background:var(--bg);border-radius:3px;position:relative;overflow:hidden">
            <div style="position:absolute;inset:0 ${100 - (p.count / maxRanked) * 100}% 0 0;background:linear-gradient(90deg, var(--accent), var(--teal));opacity:.7"></div>
            <span style="position:absolute;left:6px;top:0;font-size:10px;font-weight:600;line-height:14px">${p.count}</span>
          </div>
          <span style="font-size:10px;color:var(--muted);text-align:right">${[...p.types].join(", ")}</span>
        </div>`).join("")}
      </div>` : `<div style="color:var(--muted);font-size:12px">No MSK log entries in this window.</div>`}
    </div>

    ${chronic.length ? `<div class="card">
      <h3>🚨 Chronic / Recurring Cases <span style="color:var(--dim);font-weight:400;font-size:11px">(${chronic.length})</span></h3>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Recruits with a reported injury AND ≥3 MSK conduct entries — needs ongoing attention.</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${chronic.map(c => `<div onclick="openPerson('${c.d4}')" style="cursor:pointer;font-size:12px;padding:8px 10px;background:var(--surface2);border-radius:6px;border-left:3px solid ${MSK_REGION_COLORS[c.regions[0]] || MSK_REGION_COLORS.Other};display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="mono" style="color:var(--accent);font-weight:700">${displayId(c.d4)}</span>
          <span style="flex:1 1 140px;min-width:0">${displayPersonLabel(c.d4)}</span>
          <span class="mono" style="color:var(--red);font-weight:700">${c.count}× missed</span>
          <span style="display:flex;flex-wrap:wrap;gap:3px">${c.regions.map(regionChip).join("")}</span>
        </div>`).join("")}
      </div>
    </div>` : ""}
  `;

  // Render the charts after the canvases are in the DOM.
  setTimeout(() => {
    Object.values(_mskAnalyticsCharts).forEach(c => { try { c.destroy(); } catch (e) {} });

    // Canvas cannot read `var(--x)`, so the palette is resolved once here and
    // shared by every chart in this block.
    const MK = {
      muted: cssColor("--muted"), text: cssColor("--text"), surface: cssColor("--surface"),
      border: cssColor("--border"), gridSoft: cssColorA("--border", ".33"),
      accent: cssColor("--accent"), red: cssColor("--red"), orange: cssColor("--orange"),
      teal: cssColor("--teal"), tealWash: cssColorA("--teal", ".2"), bg: cssColor("--bg")
    };

    // Shared axis styling — softer grid, no borders, integer ticks.
    const axisBase = {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 6, right: 4, bottom: 0, left: 0 } },
      plugins: {
        legend: { labels: { color: MK.muted, font: { size: 11 }, padding: 12, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: { backgroundColor: MK.surface, borderColor: MK.border, borderWidth: 1, padding: 10, titleColor: MK.text, bodyColor: MK.text, cornerRadius: 6, displayColors: true }
      },
      scales: {
        y: { beginAtZero: true, ticks: { color: MK.muted, font: { size: 10 }, precision: 0, padding: 6 }, grid: { color: MK.gridSoft, drawTicks: false }, border: { display: false } },
        x: { ticks: { color: MK.muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, padding: 4 }, grid: { display: false }, border: { display: false } }
      }
    };

    // Stacked bar — bigger rounded corners on the top of each stack, no
    // borders. Tooltip shows the per-day breakdown + total.
    _mskAnalyticsCharts.daily = new Chart(document.getElementById("msk-daily-bar"), {
      type: "bar",
      data: { labels: dateLabels, datasets: [
        { label: "Status",        data: daily.map(d => d.px),  backgroundColor: MK.accent, stack: "a", borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.85 },
        { label: "Fallout",       data: daily.map(d => d.fo),  backgroundColor: MK.red, stack: "a", borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.85 },
        { label: "RSI",           data: daily.map(d => d.rsi), backgroundColor: MK.orange, stack: "a", borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.85 }
      ] },
      options: {
        ...axisBase,
        plugins: {
          ...axisBase.plugins,
          legend: { ...axisBase.plugins.legend, position: "bottom" },
          tooltip: {
            ...axisBase.plugins.tooltip,
            callbacks: {
              footer: (items) => {
                const total = items.reduce((s, i) => s + (i.parsed.y || 0), 0);
                return total ? `Total: ${total}` : "";
              }
            }
          }
        },
        scales: { ...axisBase.scales, x: { ...axisBase.scales.x, stacked: true }, y: { ...axisBase.scales.y, stacked: true } }
      }
    });

    _mskAnalyticsCharts.trend = new Chart(document.getElementById("msk-trend-line"), {
      type: "line",
      data: { labels: dateLabels, datasets: [{ label: "Total affected", data: daily.map(d => d.total), borderColor: MK.teal, backgroundColor: MK.tealWash, tension: 0.35, fill: true, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: MK.teal, pointBorderColor: MK.bg, pointBorderWidth: 2, borderWidth: 2.5 }] },
      options: { ...axisBase, plugins: { ...axisBase.plugins, legend: { display: false } } }
    });

    if (regionCounts.length) {
      // Click handlers: drill into the region. Cursor changes on hover so
      // it's obvious slices/bars are interactive.
      const drillOnClick = (e, elements) => {
        if (elements.length) viewMSKRegion(regionCounts[elements[0].index].region);
      };
      const cursorOnHover = (e, elements) => {
        if (e.native) e.native.target.style.cursor = elements.length ? "pointer" : "default";
      };

      // Mobile: legend below the donut (right-side legend leaves no room
      // for the donut itself on narrow screens). Desktop: keep on right.
      const isMobile = window.innerWidth <= 768;
      _mskAnalyticsCharts.donut = new Chart(document.getElementById("msk-region-donut"), {
        type: "doughnut",
        data: { labels: regionCounts.map(r => r.region), datasets: [{ data: regionCounts.map(r => r.count), backgroundColor: regionCounts.map(r => mskRegionColor(r.region)), borderWidth: 3, borderColor: MK.surface, hoverOffset: 8 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: "62%",
          onClick: drillOnClick, onHover: cursorOnHover,
          plugins: {
            legend: { position: isMobile ? "bottom" : "right", labels: { color: MK.text, font: { size: 11 }, padding: 10, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
            tooltip: { backgroundColor: MK.surface, borderColor: MK.border, borderWidth: 1, padding: 10, cornerRadius: 6, callbacks: { label: c => `${c.label}: ${c.parsed} recruit${c.parsed === 1 ? "" : "s"} (click to drill in)` } }
          }
        }
      });

      // Horizontal bar — rounded right side, bigger bars, value labels via tooltip.
      _mskAnalyticsCharts.regionBar = new Chart(document.getElementById("msk-region-bar"), {
        type: "bar",
        data: { labels: regionCounts.map(r => r.region), datasets: [{ data: regionCounts.map(r => r.count), backgroundColor: regionCounts.map(r => mskRegionColor(r.region)), borderWidth: 0, borderRadius: 6, borderSkipped: false, barPercentage: 0.7 }] },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: "y",
          layout: { padding: { top: 4, right: 16, bottom: 0, left: 0 } },
          onClick: drillOnClick, onHover: cursorOnHover,
          plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: MK.surface, borderColor: MK.border, borderWidth: 1, padding: 10, cornerRadius: 6, displayColors: false, callbacks: { label: c => `${c.parsed.x} recruit${c.parsed.x === 1 ? "" : "s"} (click to drill in)` } }
          },
          scales: {
            x: { beginAtZero: true, ticks: { color: MK.muted, font: { size: 10 }, precision: 0, padding: 4 }, grid: { color: MK.gridSoft, drawTicks: false }, border: { display: false } },
            y: { ticks: { color: MK.text, font: { size: 11, weight: "600" }, padding: 6 }, grid: { display: false }, border: { display: false } }
          }
        }
      });
    }
  }, 50);
}

// Dashboard sub-widgets — kept separate from renderDashboard to keep the main
// function readable. Both respect the active scope filter via the `scoped`
// roster passed in.
// Upcoming appointments — anything dated today or later. Sheet retains the
// full history (past entries are not deleted, just filtered out of view here)
// so an admin can audit "did we make this appointment?" later. Sorted by
// date+time ascending so the next one is always at the top.
// Out today / This week widget — the dashboard equivalent of the WhatsApp
// parade-state OTHERS block. Anyone currently inside a leave/out date range
// shows up here; near-future entries are grouped under "This week".
function dashSecLeaveOut(visible, todayIso) {
  const sevenDaysOut = (() => {
    const d = new Date(todayIso); d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const scoped = STATE.leave
    .filter(l => passesFilter(l.d4, visible))
    .map(l => ({ ...l, startIso: displayDateToISO(l.startDate) || "", endIso: displayDateToISO(l.endDate) || "" }))
    .filter(l => l.startIso && l.endIso);

  const onToday = scoped.filter(l => l.startIso <= todayIso && todayIso <= l.endIso);
  // A block that continues today's absence with no gap is the SAME absence —
  // today's row already spans it (see `dates` below), so listing it again under
  // "upcoming" would show one person twice with identical dates.
  const continuing = new Set();
  onToday.forEach(l => leaveRun(l).records.forEach(r => continuing.add(r.id)));
  const upcoming = scoped.filter(l =>
    l.startIso > todayIso && l.startIso <= sevenDaysOut && !continuing.has(l.id));

  const typeColor = t => t === "Off-in-Lieu" ? "accent" : t === "Annual Leave" ? "teal" : t === "Compassionate" ? "red" : t === "Weekend" ? "green" : t === "Night's Out" ? "pink" : t === "Course" ? "purple" : t === "Guard Duty" ? "orange" : t === "NDP" ? "yellow" : "muted";

  const section = body => ({
    key: "leaveout", icon: "⊘", title: "Out today / this week",
    count: onToday.length, token: "--purple",
    note: upcoming.length ? `${upcoming.length} upcoming` : (onToday.length ? "" : "nobody this week"),
    defaultOpen: true,
    action: dashAction("+ Log", "openBookOutForm()", "Log leave or a book-out"),
    flush: true, body,
  });

  if (!onToday.length && !upcoming.length) {
    return section(() => dashEmpty("Nobody is out today or in the next 7 days."));
  }

  // Dates span the run, so two adjacent blocks of the same leave type read as
  // one absence ending on the real return date rather than the first block's.
  const dates = l => {
    const run = leaveRun(l);
    const s = run.chained ? run.startIso : l.startIso;
    const e = run.chained ? run.endIso : l.endIso;
    return `${isoToDisplayDate(s)}${s !== e ? ` → ${isoToDisplayDate(e)}` : ""}${run.chained ? ` <span style="color:var(--dim)">(extended)</span>` : ""}`;
  };
  const row = l => `<tr onclick="openPerson('${l.d4}')" style="cursor:pointer">
    <td style="text-align:left;font-weight:600">${displayPersonLabel(l.d4)}</td>
    <td>${badge(l.type, typeColor(l.type))}</td>
    <td style="white-space:nowrap;font-size:11px;color:var(--muted)">${dates(l)}</td>
    <td style="text-align:left;font-size:11px;color:var(--muted)">${l.reason || ""}</td>
    <td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openLeaveForm('${l.id}')" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('leave', '${l.id}', 'leave record')" title="Delete">✕</button></td>
  </tr>`;

  return section(() => dashTable(
    `<th style="text-align:left">Name</th><th>Type</th><th>Dates</th><th style="text-align:left">Reason</th><th></th>`,
    onToday.map(row).join("")
    + (upcoming.length ? `<tr><td colspan="5" style="padding:6px 8px;font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;background:var(--surface2)">Upcoming this week</td></tr>` : "")
    + upcoming.map(row).join("")));
}

// The unified absence view: everything "not in camp" in one place. Durable
// Leave records (timeline + entries table) PLUS today's ephemeral book-outs
// and present-overrides, which live on the Roster flags and auto-clear
// tomorrow - shown here so "who is not here and why" has a single answer.
function renderLeave(el) {
  const visible = visibleD4Set();
  const today = todayISO();
  const scoped = STATE.leave
    .filter(l => passesFilter(l.d4, visible))
    .map(l => ({ ...l, startIso: displayDateToISO(l.startDate) || "", endIso: displayDateToISO(l.endDate) || "" }));

  const rows = [...scoped].sort((a, b) => {
    if (a.startIso !== b.startIso) return a.startIso < b.startIso ? 1 : -1;
    return 0;
  });

  const onTodayCount = scoped.filter(l => l.startIso <= today && today <= l.endIso).length;
  const titleSuffix = isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.leave.length}]</span>` : ` (${STATE.leave.length})`;

  const typeColor = t => t === "Off-in-Lieu" ? "accent" : t === "Annual Leave" ? "teal" : t === "Compassionate" ? "red" : t === "Weekend" ? "green" : t === "Night's Out" ? "pink" : t === "Course" ? "purple" : t === "Guard Duty" ? "orange" : t === "NDP" ? "yellow" : "muted";

  // Today's ephemeral roster flags (same helpers the dashboard/parade read).
  const bookedOutToday = STATE.roster.filter(r => isBookedOut(r, today) && passesFilter(r.id, visible));
  const overridesToday = STATE.roster
    .filter(r => isForcedIn(r, today) && passesFilter(r.id, visible))
    .map(r => ({ r, why: derivedCampOut(r.id, today) }));
  const bookedOutSection = (bookedOutToday.length || overridesToday.length) ? `
    <div class="card" style="margin-bottom:12px">
      <h3>🚪 Booked out today <span style="color:var(--dim);font-weight:400;font-size:11px">(manual, auto-clears tomorrow)</span></h3>
      ${bookedOutToday.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th style="text-align:left">Name</th><th style="text-align:left">Reason</th><th></th></tr></thead><tbody>
        ${bookedOutToday.map(r => `<tr onclick="openPerson('${r.id}')" style="cursor:pointer">
          <td style="text-align:left;font-weight:600">${displayPersonLabel(r.id)}</td>
          <td style="text-align:left;font-size:11px;color:var(--muted)">${escapeAttr(r.outReason || "")}</td>
          <td style="white-space:nowrap"><button class="btn btn-icon btn-success" style="font-size:10px;padding:3px 8px" onclick="event.stopPropagation(); undoBookOut('${r.id}')" title="Removes today's book-out">↩ Book in</button></td>
        </tr>`).join("")}
      </tbody></table></div>` : ""}
      ${overridesToday.length ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
        ${overridesToday.map(({ r, why }) => `<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)">
          <span style="color:var(--teal);font-weight:600">${displayPersonLabel(r.id)}</span>
          <span>kept in camp today${why ? `, would be out: ${escapeAttr(why.reason || "")}` : ""}</span>
          <button class="btn btn-icon" style="font-size:10px;padding:2px 7px" onclick="clearPresentOverride('${r.id}')" title="Remove the manual book-in; they return to their out status">✕ Undo book-in</button>
        </div>`).join("")}
      </div>` : ""}
    </div>` : "";

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="font-size:18px;font-weight:700">📅 Out / Leave${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('Leave',STATE.leave)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openBookOutForm()">+ Log</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><label>Total entries</label><div class="val">${scoped.length}</div></div>
      <div class="stat"><label>On leave today</label><div class="val" style="color:var(--orange)">${onTodayCount}</div></div>
      <div class="stat"><label>Booked out today</label><div class="val" style="color:var(--yellow)">${bookedOutToday.length}</div></div>
    </div>
    ${bookedOutSection}
    ${renderLeaveTimeline(scoped, today)}
    ${rows.length ? `<h3 style="font-size:13px;color:var(--muted);margin:16px 0 8px">All entries</h3><div class="table-wrap"><table><thead><tr><th style="text-align:left">Name</th><th>Type</th><th>Start</th><th>End</th><th>Days</th><th style="text-align:left">Reason</th><th></th></tr></thead><tbody>
    ${rows.map(l => `<tr onclick="openPerson('${l.d4}')" style="cursor:pointer"><td style="text-align:left;font-weight:600">${displayPersonLabel(l.d4)}</td><td>${badge(l.type, typeColor(l.type))}</td><td>${l.startDate || ""}</td><td>${l.endDate || ""}</td><td class="mono" style="font-weight:700">${l.days || ""}</td><td style="text-align:left;font-size:11px;color:var(--muted);max-width:240px;white-space:normal">${l.reason || ""}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openLeaveForm('${l.id}')" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('leave', '${l.id}', 'leave record')" title="Delete">✕</button></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.leave.length ? `No leave records in ${filterLabel()}.` : "No leave records yet. Tap + Log to add one."}</div>`}`;
}

// Gantt-style 21-day timeline: each row a person with at least one leave
// overlapping the window, cells filled per-day with the leave type's color.
// Answers "who is taking off when" at a glance — much more useful than a
// running total of off-in-lieu days.
function renderLeaveTimeline(scoped, todayIso) {
  const TIMELINE_DAYS = 21;
  const start = new Date(todayIso);
  const days = Array.from({ length: TIMELINE_DAYS }, (_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i);
    return d;
  });
  const dayIso = days.map(d => d.toISOString().slice(0, 10));
  const windowEnd = dayIso[TIMELINE_DAYS - 1];

  const overlapping = scoped.filter(l => l.startIso && l.endIso && l.endIso >= todayIso && l.startIso <= windowEnd);
  if (!overlapping.length) {
    return `<div class="card" style="margin-bottom:12px"><h3>Leave Timeline <span style="color:var(--dim);font-weight:400;font-size:11px">(next ${TIMELINE_DAYS} days)</span></h3><div style="color:var(--muted);font-size:12px;padding:8px 0">No upcoming leave in the next ${TIMELINE_DAYS} days.</div></div>`;
  }

  // Group by person; sort people by earliest upcoming entry.
  const byPerson = {};
  overlapping.forEach(l => { (byPerson[l.d4] = byPerson[l.d4] || []).push(l); });
  const people = Object.keys(byPerson).sort((a, b) => {
    const aEarliest = byPerson[a].reduce((m, l) => l.startIso < m ? l.startIso : m, "9999");
    const bEarliest = byPerson[b].reduce((m, l) => l.startIso < m ? l.startIso : m, "9999");
    return aEarliest < bEarliest ? -1 : 1;
  });

  const typeBg = t => ({
    "Off-in-Lieu": "var(--accent)", "Annual Leave": "var(--teal)", "Compassionate": "var(--red)", "Weekend": "var(--green)", "Night's Out": "var(--pink)",
    "Course": "var(--purple)", "Guard Duty": "var(--orange)", "NDP": "var(--yellow)", "Other": "var(--muted)"
  })[t] || "var(--muted)";

  // Header: show the day-of-month for week boundaries + today marker.
  const headerCells = days.map((d, i) => {
    const isWeekStart = i === 0 || d.getDay() === 1;  // Monday
    const isToday = dayIso[i] === todayIso;
    const label = isWeekStart || i === 0 ? `${d.getDate()}/${d.getMonth() + 1}` : "";
    return `<th style="padding:2px 0;font-size:9px;color:${isToday ? 'var(--red)' : 'var(--muted)'};font-weight:${isToday ? 700 : 400};width:18px;text-align:center;border-left:${isWeekStart ? '1px solid var(--border)' : 'none'}">${label}</th>`;
  }).join("");

  const personRows = people.map(d4 => {
    const personLeave = byPerson[d4];
    const cells = dayIso.map((iso, i) => {
      const match = personLeave.find(l => l.startIso <= iso && iso <= l.endIso);
      const isToday = iso === todayIso;
      const isWeekStart = i === 0 || days[i].getDay() === 1;
      const borderLeft = isWeekStart ? '1px solid var(--border)' : 'none';
      if (match) {
        const isStart = iso === match.startIso;
        const isEnd = iso === match.endIso;
        const radius = `${isStart ? '3px' : '0'} ${isEnd ? '3px' : '0'} ${isEnd ? '3px' : '0'} ${isStart ? '3px' : '0'}`;
        return `<td style="padding:0;border-left:${borderLeft};height:18px" title="${match.type}${match.reason ? ': ' + match.reason : ''} (${match.startDate} → ${match.endDate})"><div style="background:${typeBg(match.type)};height:14px;margin:2px 0;border-radius:${radius};opacity:.85"></div></td>`;
      }
      const todayMark = isToday ? "background:rgba(var(--redRGB),.13);" : "";
      return `<td style="padding:0;border-left:${borderLeft};${todayMark}height:18px"></td>`;
    }).join("");
    return `<tr onclick="openPerson('${d4}')" style="cursor:pointer"><td style="padding:3px 8px;white-space:nowrap;font-size:11px;font-weight:600;background:var(--surface);border-right:2px solid var(--border);position:sticky;left:0;z-index:1">${displayPersonLabel(d4)}</td>${cells}</tr>`;
  }).join("");

  // Legend mirrors the type-color palette so users can decode the bars.
  const legend = ["Off-in-Lieu", "Annual Leave", "Compassionate", "Weekend", "Night's Out", "Course", "Guard Duty", "NDP", "Other"]
    .map(t => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><span style="width:10px;height:10px;background:${typeBg(t)};border-radius:2px;opacity:.85"></span>${t}</span>`)
    .join(" ");

  return `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">Leave Timeline <span style="color:var(--dim);font-weight:400;font-size:11px">(next ${TIMELINE_DAYS} days · ${people.length} ${people.length === 1 ? 'person' : 'people'})</span></h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${legend}</div>
    </div>
    <div style="overflow-x:auto"><table style="border-collapse:collapse"><thead><tr><th style="background:var(--surface);position:sticky;left:0;z-index:2"></th>${headerCells}</tr></thead><tbody>${personRows}</tbody></table></div>
  </div>`;
}

// "Back <date>" for an out-of-camp entry. outOfCampMap works the return date
// out across chained records, so a re-issued MC shows the date the recruit is
// REALLY due back — the number people were reading off the wrong record.
// Manual book-outs auto-clear overnight and carry no return date.
// Two shapes: `backLine` for a column with vertical room, `backNote` to trail a
// reason inline. Both keep the date on one line — a date broken across three
// lines in a narrow phone cell is exactly what makes it get misread.
const backDate = info => (info && info.back) ? isoToShortDate(info.back) : "";
function backLine(info) {
  const d = backDate(info);
  return d ? `<div style="font-size:10px;color:var(--dim);white-space:nowrap">Back ${d}</div>` : "";
}
function backNote(info) {
  const d = backDate(info);
  return d ? ` <span style="color:var(--dim);white-space:nowrap">· back ${d}</span>` : "";
}

// "Currently Out of Camp" panel — everyone counted out today (the same shared
// set that drives the strength tiles + parade). Booked-out rows get a one-tap
// Book in (plain undo); medical/leave rows get "Book in anyway" (override). A
// "+ Book Out" button opens the unified Book Out modal (today or a date range).
function dashSecOutOfCamp(scoped, outMap) {
  const rows = scoped.filter(r => outMap.has(r.id));
  // Token NAMES, not literals: the pill needs both the solid ink and a wash of
  // the same hue, and both are derived from one token.
  const color = { medical: "--red", leave: "--purple", bookedout: "--orange" };
  const label = { medical: "Medical", leave: "Leave", bookedout: "Booked out" };
  // Why they are out, in the closed header — the second question a commander
  // asks, answered without a tap.
  const kinds = {};
  rows.forEach(r => { const k = outMap.get(r.id).kind; kinds[k] = (kinds[k] || 0) + 1; });
  const section = body => ({
    key: "outofcamp", icon: "↗", title: "Out of camp",
    count: rows.length, token: "--orange",
    note: rows.length ? Object.entries(kinds).map(([k, n]) => `${n} ${(label[k] || k).toLowerCase()}`).join(" · ") : "everyone is in camp",
    defaultOpen: true,
    action: dashAction("+ Book Out", "openBookOutForm()", "Book someone out of camp"),
    flush: true, body,
  });
  if (!rows.length) return section(() => dashEmpty("Everyone in scope is in camp."));
  const body = rows.map(r => {
    const info = outMap.get(r.id);
    const tok = color[info.kind] || "--muted";
    const c = `var(${tok})`;
    return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer">
      <td class="mono" style="font-weight:700;color:var(--accent)">${displayId(r.id)}</td>
      <td style="text-align:left">${displayPersonLabel(r.id)}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:color-mix(in srgb, ${c} 13%, transparent);color:${c}">${label[info.kind] || info.kind}</span></td>
      <td style="text-align:left;font-size:11px;color:var(--muted)">${escapeAttr(info.reason || "")}${backNote(info)}</td>
      <td style="white-space:nowrap">${info.kind === "bookedout"
        ? `<button class="btn btn-icon btn-success" style="font-size:10px;padding:3px 8px" onclick="event.stopPropagation(); undoBookOut('${r.id}')" title="Removes today's book-out">↩ Book in</button>`
        : `<button class="btn btn-icon" style="font-size:10px;padding:3px 8px;color:var(--teal)" onclick="event.stopPropagation(); markPresentToday('${r.id}')" title="Count as present today despite the ${info.kind} record (resets tomorrow)">✓ Book in anyway</button> <span style="font-size:10px;color:var(--dim)">via ${info.kind}</span>`}</td>
    </tr>`;
  }).join("");
  return section(() => dashTable(
    `<th>4D</th><th style="text-align:left">Name</th><th>Why</th><th style="text-align:left">Detail</th><th></th>`,
    body));
}

function dashSecAppointments(visible, todayIso) {
  const upcoming = STATE.appointments
    .filter(a => !a.resolved)
    .filter(a => passesFilter(a.d4, visible))
    .filter(a => {
      const iso = displayDateToISO(a.date);
      return iso && iso >= todayIso;
    })
    .sort((a, b) => {
      const ai = displayDateToISO(a.date) || "";
      const bi = displayDateToISO(b.date) || "";
      if (ai !== bi) return ai < bi ? -1 : 1;
      return (a.time || "") < (b.time || "") ? -1 : 1;
    });

  // "2 today" is the part that changes what a commander does in the next hour;
  // otherwise name the next date so the header is still an answer.
  const todayCount = upcoming.filter(a => displayDateToISO(a.date) === todayIso).length;
  const note = !upcoming.length ? "nothing booked"
    : todayCount ? `${todayCount} today · next ${upcoming[0].date || ""}`
    : `next ${upcoming[0].date || ""}`;
  const section = body => ({
    key: "appointments", icon: "◷", title: "Appointments",
    count: upcoming.length, token: "--accent", note,
    defaultOpen: true,
    action: dashAction("+ Book", "openAppointmentForm()", "Book an appointment"),
    flush: true, body,
  });

  if (!upcoming.length) {
    return section(() => dashEmpty("No upcoming appointments."));
  }

  // Highlight today's appointments so they don't get lost in a long list.
  const rows = upcoming.map(a => {
    const iso = displayDateToISO(a.date);
    const isToday = iso === todayIso;
    const dayLabel = isToday ? `<span class="badge badge-red" style="font-size:9px">TODAY</span>` : "";
    // Out-of-camp appointments today get a one-tap Book Out / Book In that drives
    // the shared booked-out flag (so the strength board + parade update live).
    const r = STATE.roster.find(x => x.id === a.d4);
    const bookedOut = r && isBookedOut(r, todayIso);
    const bookBtn = (a.outOfCamp && isToday)
      ? (bookedOut
        ? `<button class="btn btn-icon btn-success" style="font-size:10px;padding:3px 7px" onclick="event.stopPropagation(); undoBookOut('${a.d4}')" title="Removes today's book-out">↩ Book in</button> `
        : `<button class="btn btn-icon btn-danger" style="font-size:10px;padding:3px 7px" onclick="event.stopPropagation(); bookOutToggle('${a.d4}', true, ${JSON.stringify('Appt: ' + (a.reason || 'appointment'))})" title="Book out of camp">🚪 Out</button> `)
      : "";
    return `<tr onclick="openPerson('${a.d4}')" style="cursor:pointer${isToday ? ';background:rgba(var(--redRGB),.07)' : ''}">
      <td class="mono" style="font-weight:700;color:var(--accent)">${displayId(a.d4)}</td>
      <td style="text-align:left">${displayPersonLabel(a.d4)}</td>
      <td style="text-align:left">${a.reason || ""}</td>
      <td style="white-space:nowrap">${a.date || ""} ${dayLabel}</td>
      <td class="mono" style="white-space:nowrap">${fmtHrs(a.time)}</td>
      <td style="text-align:left;font-size:11px;color:var(--muted)">${a.location || ""}${a.outOfCamp ? ` <span class="badge badge-pink" style="font-size:9px">${bookedOut ? "OUT NOW" : "OUTSIDE"}</span>` : ""}</td>
      <td style="white-space:nowrap">${bookBtn}<button class="btn btn-icon" style="color:var(--green)" onclick="event.stopPropagation(); toggleAppointmentResolved('${a.id}')" title="Mark as resolved (hides from dashboard + parade state)">✓</button> <button class="btn btn-icon" onclick="event.stopPropagation(); openAppointmentForm('${a.id}')" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('appointments', '${a.id}', 'appointment')" title="Delete">✕</button></td>
    </tr>`;
  }).join("");

  return section(() => dashTable(
    `<th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Reason</th><th>Date</th><th>Time</th><th style="text-align:left">Location</th><th></th>`,
    rows));
}


function renderRoster(el) {
  const rsiCount = {};
  STATE.medical.forEach(m => { rsiCount[m.d4] = (rsiCount[m.d4] || 0) + 1; });
  // Default order: highest rank first, lowest at the bottom, with the 4D (the
  // order the roster arrives in) as the tie-break so two 3SGs stay stable.
  // sortByRank copies, so STATE.roster itself is never reordered.
  const scoped = sortByRank(filteredRoster());
  const rosterToday = todayISO();
  // Camp column reads the SHARED out-of-camp definition (outOfCampMap) so it can
  // never disagree with the dashboard / parade strength — medical and leave count
  // as out here, not just manual book-outs. Colours/labels mirror the dashboard
  // "Currently Out of Camp" panel.
  const campOutMap = outOfCampMap(rosterToday);
  // Token names (see dashSecOutOfCamp) so the badge wash tracks the palette.
  const CAMP_COLOR = { medical: "--red", leave: "--purple", bookedout: "--orange" };
  const CAMP_WHY = { medical: "Medical", leave: "Leave", bookedout: "Booked out" };
  // Status column = the recruit's CURRENTLY-active medical status(es), derived
  // from the medical layer (same source as the dashboard) rather than the stale
  // roster `status` field. No active status → ACTIVE.
  const effByD4 = {};
  currentMedicalEffectiveAll(rosterToday).forEach(e => { effByD4[e.d4] = e.statuses; });
  // Push/Export operate on the FULL roster — scoping is a view concern; we
  // don't want the user to silently overwrite the sheet with only their slice.
  const titleSuffix = isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.roster.length}]</span>` : ` (${STATE.roster.length})`;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Master Roster${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="openCommanderForm()" title="Add a commander to the roster (recruits come from the nominal roll)">+ Commander</button>
        <button class="btn" onclick="openGroupsForm()" title="Create / edit ad-hoc recruit groups (e.g. Guard Duty)">⦿ Groups</button>
        <button class="btn" onclick="exportCSV(STATE.roster,'roster.csv')">Export CSV</button>
        <button class="btn btn-success" onclick="pushTab('Roster',STATE.roster)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
      </div>
    </div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th>Role</th><th>Status</th><th>Camp</th><th>BMI</th><th>RSIs</th></tr></thead><tbody>
    ${scoped.map(r => {
      const bmi = calcBMI(r);
      const isCmd = r.role === "Commander";
      const nameCell = isCmd ? `${r.rank ? r.rank + " " : ""}${r.name}` : r.name;
      const idCell = isCmd ? "" : r.id;
      const roleCell = isCmd ? `<span class="badge badge-purple">Commander</span>` : `<span style="color:var(--muted)">Recruit</span>`;
      // Book Out / Book In toggle reflecting the shared booked-out flag.
      const effStatuses = effByD4[r.id];
      const statusCell = (effStatuses && effStatuses.length)
        ? effStatuses.map(s => `<div style="padding:2px 0">${medTagBadge(s.tag)}</div>`).join("")
        : statusBadge("Active");
      // CAMP cell = effective status (why they're out, or "In camp") + a state-
      // specific lever: in camp → Book out (unified modal, today or a range);
      // booked out → Book in (plain undo); out via MC/leave record → Book in
      // anyway (campIn override, self-confirms); manual book-in active → Undo
      // book-in. The badge reads outOfCampMap, so it can never disagree with
      // the dashboard.
      const outInfo = campOutMap.get(r.id);
      const forcedIn = !outInfo && isForcedIn(r, rosterToday) && derivedCampOut(r.id, rosterToday);
      // The "back" date rides along with the badge — it spans chained records,
      // so an extended MC can't be read as ending at the first record.
      const campBadge = outInfo
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:color-mix(in srgb, var(${CAMP_COLOR[outInfo.kind] || "--muted"}) 13%, transparent);color:var(${CAMP_COLOR[outInfo.kind] || "--muted"})" title="Out of camp — ${escapeAttr(outInfo.reason || "")}${outInfo.back ? ` (back ${isoToDisplayDate(outInfo.back)})` : ""}">Out · ${CAMP_WHY[outInfo.kind] || outInfo.kind}</span>${backLine(outInfo)}`
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
      const campCell = `<div style="display:inline-flex;flex-direction:column;gap:3px;align-items:center">${campBadge}${campToggle}</div>`;
      return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer"><td class="mono" style="font-weight:700;color:var(--accent)">${idCell}</td><td style="text-align:left">${nameCell}</td><td>${roleCell}</td><td>${statusCell}</td><td style="white-space:nowrap">${campCell}</td><td style="font-weight:700;color:${bmiColor(bmi)}">${isCmd ? '—' : (bmi ?? '—')}</td><td style="color:${(rsiCount[r.id] || 0) > 1 ? 'var(--red)' : 'var(--muted)'}">${rsiCount[r.id] || 0}</td></tr>`;
    }).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.roster.length ? `No personnel in ${filterLabel()}.` : (STATE.authToken ? "Loading roster from sheet…" : "No invite redeemed on this device yet.")}</div>`}`;
}

function renderAttendance(el) {
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <h2 style="font-size:18px;font-weight:700">Conduct Attendance</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-success" onclick="pushTab('Attendance',STATE.attendance)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openLogConductWizard()" title="One-shot wizard: date + time + conduct + Status Personnel checklist + bulk Report Sick / Fallout / RSI rows + auto totals + chat-format copy">+ Log Conduct</button>
      </div>
    </div>
    ${STATE.attendance.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Conduct</th><th>Scope</th><th>Total</th><th>Part.</th><th>Status</th><th>Fallout</th><th>Rate</th><th style="text-align:left">Remarks</th><th></th></tr></thead><tbody>
    ${[...STATE.attendance].sort((a, b) => {
      // Newest first by date, then time (later in the day on top within a date).
      const ai = displayDateToISO(a.date) || a.date || "";
      const bi = displayDateToISO(b.date) || b.date || "";
      if (ai !== bi) return ai < bi ? 1 : -1;
      return (a.time || "") < (b.time || "") ? 1 : -1;
    }).map(a => {
      const r = pct(a.participating, a.total);
      const rateColor = r >= 95 ? 'var(--green)' : r >= 70 ? 'var(--orange)' : 'var(--red)';
      const time = fmtHrs(a.time) || '—';
      return `<tr><td>${a.date}</td><td class="mono" style="color:${a.time ? 'var(--text)' : 'var(--dim)'}">${time}</td><td style="text-align:left">${conductName(a.conductId)}</td><td>${conductScopeBadge(scopeKey(a))}</td><td>${a.total}</td><td>${a.participating}</td><td style="color:${a.px > 0 ? 'var(--orange)' : 'var(--muted)'}">${a.px}</td><td style="color:${a.fallout > 0 ? 'var(--red)' : 'var(--muted)'}">${a.fallout}</td><td style="font-weight:700;color:${rateColor}">${r}%</td><td style="text-align:left;color:${a.remarks ? 'var(--yellow)' : 'var(--muted)'};max-width:200px;white-space:normal;font-size:11px">${a.remarks || ''}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="copyConductChatFormat('${a.id}')" title="Copy WhatsApp-format parade state message">📋</button> <button class="btn btn-icon" onclick="openLogConductWizard('${a.id}')" title="Edit conduct (wizard)">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('attendance', '${a.id}', 'attendance entry')" title="Delete">✕</button></td></tr>`;
    }).join("")}
    </tbody></table></div>` : `<div class="empty-state">No attendance records yet.</div>`}`;
}

// ── Conduct Detail tab ────────────────────────────────────
// Filters are module-scope rather than persisted — they reset on reload so a
// returning user sees the whole picture instead of yesterday's filter state.
let _detailFilterConduct = "";
let _detailFilterType = "";
let _showParticipants = false;
function setDetailFilterConduct(v) { _detailFilterConduct = v; _showParticipants = false; render(); }
function setDetailFilterType(v) { _detailFilterType = v; render(); }
function clearDetailFilters() { _detailFilterConduct = ""; _detailFilterType = ""; _showParticipants = false; render(); }
function toggleParticipants() { _showParticipants = !_showParticipants; render(); }

// When a single conduct is selected, derive who participated from
// `roster - absent` (the user's insight: detail rows enumerate absentees, so
// the inverse gives us the participants for free, no extra data needed).
function renderDetailParticipantsSummary(scopedAll) {
  if (!_detailFilterConduct) return "";
  const conductRecords = scopedAll.filter(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${scopeKey(d)}` === _detailFilterConduct);
  const absentSet = new Set(conductRecords.map(d => d.d4));
  // Participants = the session's scoped roster minus absentees (the detail rows
  // enumerate absentees, so the inverse gives participants for free). Scope to
  // the session's own scope so a Platoon 7 conduct doesn't count Platoon 8.
  const sessionScope = _detailFilterConduct.split("|")[3] || SCOPE_COMPANY;
  const visible = visibleD4Set();
  const inScope = conductScopeRoster(sessionScope).filter(r => passesFilter(r.id, visible));
  const participants = inScope.filter(r => !absentSet.has(r.id));
  const ct = t => conductRecords.filter(d => d.type === t).length;
  return `
    <div class="card" style="padding:10px 14px;margin-bottom:12px;background:var(--surface2)">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;flex-wrap:wrap;gap:8px">
        <div>
          <span style="color:var(--muted)">This conduct →</span>
          <strong style="color:var(--green)">Participated: ${participants.length}</strong>
          <span style="color:var(--muted)"> · </span>
          <strong style="color:var(--red)">Absent: ${conductRecords.length}</strong>
          <span style="color:var(--muted)"> (Status ${ct("PX")} · RSI ${ct("RSI")} · Fallout ${ct("Fallout")} · ReportSick ${ct("ReportSick")})</span>
        </div>
        <button class="btn" onclick="toggleParticipants()">${_showParticipants ? "▾ Hide" : "▸ Show"} participants (${participants.length})</button>
      </div>
      ${_showParticipants ? `<div style="margin-top:10px;display:flex;gap:4px;flex-wrap:wrap">
        ${participants.length ? participants.map(r => `<button onclick="openPerson('${r.id}')" style="cursor:pointer;font-size:10px;padding:3px 7px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--accent);font-family:'JetBrains Mono',monospace;font-weight:700" title="${escapeAttr(r.name)}">${r.id}</button>`).join("") : `<span style="color:var(--muted);font-size:11px">No participants in current scope</span>`}
      </div>` : ""}
    </div>`;
}

function renderConductDetail(el) {
  const visible = visibleD4Set();
  const scopedAll = STATE.conductDetail.filter(d => passesFilter(d.d4, visible));
  let scoped = scopedAll;
  if (_detailFilterConduct) scoped = scoped.filter(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${scopeKey(d)}` === _detailFilterConduct);
  if (_detailFilterType) scoped = scoped.filter(d => d.type === _detailFilterType);

  // Unique conduct keys for the dropdown — newest first by parsed date. Scope
  // is part of the key so a Plt 7 and a Plt 8 run of the same conduct list separately.
  const conductKeys = [...new Set(scopedAll.map(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${scopeKey(d)}`))]
    .filter(Boolean)
    .sort((a, b) => {
      const [ad, at] = a.split("|"), [bd, bt] = b.split("|");
      const ai = displayDateToISO(ad) || ad;
      const bi = displayDateToISO(bd) || bd;
      if (ai !== bi) return ai < bi ? 1 : -1;
      return (at || "") < (bt || "") ? 1 : -1;
    });

  // Sort the visible records the same way — newest-first feels right when
  // scanning for "what happened today / yesterday."
  const rows = [...scoped].sort((a, b) => {
    const ai = displayDateToISO(a.date) || a.date || "";
    const bi = displayDateToISO(b.date) || b.date || "";
    if (ai !== bi) return ai < bi ? 1 : -1;
    return (a.time || "") < (b.time || "") ? 1 : -1;
  });

  // ReportSick dedupes per (d4, date) — a single recruit who fell out of
  // multiple conducts on the same day only went to MO once. The other
  // types remain as row counts (each row = a distinct conduct event).
  const cnt = t => {
    const rows = scoped.filter(d => d.type === t);
    if (t === "ReportSick") return new Set(rows.map(d => `${d.d4}|${d.date}`)).size;
    return rows.length;
  };

  // "Most conducts missed" ignores the conduct/type sub-filter so the ranking
  // remains a stable view of overall absence within the platoon scope.
  const missed = {};
  scopedAll.forEach(d => {
    const k = `${d.date}|${d.time || ""}|${d.conductId || ""}|${scopeKey(d)}`;
    (missed[d.d4] = missed[d.d4] || new Set()).add(k);
  });
  const topMissed = Object.entries(missed)
    .map(([d4, set]) => ({ d4, count: set.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const typeBadgeColor = t => t === "PX" ? "orange" : t === "RSI" ? "red" : t === "Fallout" ? "purple" : "yellow";
  const totalConducts = [...new Set(scopedAll.map(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${scopeKey(d)}`))].length;
  const titleSuffix = isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scopedAll.length}/${STATE.conductDetail.length}]</span>` : ` (${STATE.conductDetail.length})`;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="font-size:18px;font-weight:700">Conduct Detail${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('ConductDetail',STATE.conductDetail)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openConductDetailForm()">+ Log</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><label>Status (pre-existing)</label><div class="val" style="color:var(--orange)">${cnt("PX")}</div></div>
      <div class="stat"><label>RSI (1st parade)</label><div class="val" style="color:var(--red)">${cnt("RSI")}</div></div>
      <div class="stat"><label>Fallout (mid-conduct)</label><div class="val" style="color:var(--purple)">${cnt("Fallout")}</div></div>
      <div class="stat"><label>Reported Sick (mid-day)</label><div class="val" style="color:var(--yellow)">${cnt("ReportSick")}</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">Filter:</span>
      <select onchange="setDetailFilterConduct(this.value)" class="topbar-select" style="min-width:260px">
        <option value="">All conducts (${totalConducts})</option>
        ${conductKeys.map(k => { const [dt, tm, cid, prog] = k.split("|"); return `<option value="${escapeAttr(k)}" ${k === _detailFilterConduct ? "selected" : ""}>${dt}${tm ? " " + fmtHrs(tm) : ""} — ${conductName(cid) || "(unknown)"} (${conductScopeLabel(prog)})</option>`; }).join("")}
      </select>
      <select onchange="setDetailFilterType(this.value)" class="topbar-select">
        <option value="">All types</option>
        ${[["PX","Status"],["RSI","RSI"],["Fallout","Fallout"],["ReportSick","Report Sick"]].map(([val,lab]) => `<option value="${val}" ${val === _detailFilterType ? "selected" : ""}>${lab}</option>`).join("")}
      </select>
      ${(_detailFilterConduct || _detailFilterType) ? `<button class="btn" onclick="clearDetailFilters()">Reset</button>` : ""}
    </div>
    ${renderDetailParticipantsSummary(scopedAll)}
    <div class="grid-2" style="grid-template-columns:2fr 1fr;align-items:start">
      <div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th style="text-align:left">Conduct</th><th>Program</th><th>4D</th><th style="text-align:left">Name</th><th>Type</th><th style="text-align:left">Reason</th><th></th></tr></thead><tbody>
        ${rows.map(d => `<tr onclick="openPerson('${d.d4}')" style="cursor:pointer"><td>${d.date || ""}</td><td class="mono">${fmtHrs(d.time) || "—"}</td><td style="text-align:left">${conductName(d.conductId)}</td><td>${conductScopeBadge(scopeKey(d))}</td><td class="mono" style="font-weight:700;color:var(--accent)">${d.d4}</td><td style="text-align:left">${getName(d.d4)}</td><td>${badge(d.type, typeBadgeColor(d.type))}</td><td style="text-align:left;max-width:280px;white-space:normal;font-size:11px">${d.reason || ""}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openConductDetailForm('${d.id}')" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('conductDetail', '${d.id}', 'conduct detail record')" title="Delete">✕</button></td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty-state">${STATE.conductDetail.length ? "No records match current filter." : "No conduct detail records yet. Tap + Log to add one."}</div>`}
      </div>
      <div class="card">
        <h3>Most Conducts Missed${isFilterActive() ? ` <span style="color:var(--accent);font-weight:400;font-size:10px">in ${filterLabel()}</span>` : ""}</h3>
        ${topMissed.length ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto">
          ${topMissed.map(m => `<div onclick="openPerson('${m.d4}')" style="cursor:pointer;font-size:11px;padding:6px 8px;border-radius:4px;background:var(--surface2);display:flex;justify-content:space-between;gap:8px">
            <span><span class="mono" style="color:var(--accent);font-weight:700">${m.d4}</span> ${getName(m.d4)}</span>
            <span class="mono" style="font-weight:700;color:${m.count >= 5 ? "var(--red)" : m.count >= 3 ? "var(--orange)" : "var(--muted)"}">${m.count}</span>
          </div>`).join("")}
        </div>` : `<div style="color:var(--muted);font-size:12px">No data yet</div>`}
      </div>
    </div>`;
}

function renderMedical(el) {
  const visible = visibleD4Set();
  const scoped = STATE.medical.filter(m => passesFilter(m.d4, visible));
  const today = todayISO();
  // Per-row "tag today" reflects whether the status is currently active, in
  // its +1/+2 ghost window, or fully cleared.
  const rowsWithTag = scoped.map(m => ({ m, tagInfo: medStatusTag(m, today) }));
  // Sort newest first by startDate (fallback to date logged).
  rowsWithTag.sort((a, b) => {
    const ai = displayDateToISO(a.m.startDate || a.m.date) || "";
    const bi = displayDateToISO(b.m.startDate || b.m.date) || "";
    return ai < bi ? 1 : ai > bi ? -1 : 0;
  });
  const activeCount = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay === 0).length;
  const ghostCount = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay > 0).length;
  const pendingCount = scoped.filter(m => m.status === "Pending").length;

  // R/C breakdown — same logic as the dashboard: only shown when "All" is
  // the active role scope, so the stat is double-clickable for "is this a
  // recruit-side problem or a commander problem?"
  const isAll = !STATE.filterRole;
  const splitC = pred => ({
    rec: scoped.filter(m => pred(m) && !isCommander(m.d4)).length,
    cmd: scoped.filter(m => pred(m) && isCommander(m.d4)).length
  });
  const totalSplit = splitC(() => true);
  const activeSplit = (() => {
    const rec = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay === 0 && !isCommander(r.m.d4)).length;
    const cmd = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay === 0 && isCommander(r.m.d4)).length;
    return { rec, cmd };
  })();
  const recoveringSplit = (() => {
    const rec = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay > 0 && !isCommander(r.m.d4)).length;
    const cmd = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay > 0 && isCommander(r.m.d4)).length;
    return { rec, cmd };
  })();
  const pendingSplit = splitC(m => m.status === "Pending");
  const inlineBreakdown = ({ rec, cmd }) => isAll
    ? `<span style="font-size:55%;color:var(--muted);font-weight:400;margin-left:1px">/${rec}/${cmd}</span>`
    : "";

  // Leaderboard: count UNIQUE report-sick days per recruit within the scope.
  // A recruit can have several medical rows on the same date (one auto-created
  // by the wizard's Report Sick, another manually entered for the same illness,
  // or multiple statuses received for the same incident — e.g. "1D MC + 2D LD").
  // The leaderboard cares about "how often does this person go to MO", so
  // collapse those to one event per (d4, date).
  const rsDaySets = {};
  scoped.forEach(m => { (rsDaySets[m.d4] = rsDaySets[m.d4] || new Set()).add(m.date); });
  const topReporters = Object.entries(rsDaySets)
    .map(([d4, days]) => ({ d4, count: days.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  // Total unique (d4, date) pairs across the whole scope — drives the
  // "Total report sicks" tile so it matches the leaderboard semantics.
  const totalReportSickDays = new Set(scoped.map(m => `${m.d4}|${m.date}`)).size;
  const totalReportSickDaysSplit = {
    rec: new Set(scoped.filter(m => !isCommander(m.d4)).map(m => `${m.d4}|${m.date}`)).size,
    cmd: new Set(scoped.filter(m => isCommander(m.d4)).map(m => `${m.d4}|${m.date}`)).size
  };

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Report Sick Log${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.medical.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('Medical',STATE.medical)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openMedicalForm()">+ Log Report Sick</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><label>Total report sicks</label><div class="val" title="Unique (recruit, date) — multiple medical rows on the same day count as one event">${totalReportSickDays}${inlineBreakdown(totalReportSickDaysSplit)}</div></div>
      <div class="stat"><label>Active today</label><div class="val" style="color:var(--red)">${activeCount}${inlineBreakdown(activeSplit)}</div></div>
      <div class="stat"><label>Recovering</label><div class="val" style="color:var(--orange)">${ghostCount}${inlineBreakdown(recoveringSplit)}</div></div>
      <div class="stat"><label>Pending</label><div class="val" style="color:var(--muted)">${pendingCount}${inlineBreakdown(pendingSplit)}</div></div>
    </div>
    <div class="grid-2" style="grid-template-columns:2fr 1fr;align-items:start">
      <div>
        ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>Reported</th><th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Reason</th><th>Status</th><th>Start</th><th>End</th><th>Today</th><th></th></tr></thead><tbody>
        ${rowsWithTag.map(({ m, tagInfo }) => { const noDur = m.status === "Pending" || m.status === "NIL"; return `<tr onclick="openPerson('${m.d4}')" style="cursor:pointer"><td>${m.date || ""}</td><td class="mono" style="font-weight:700;color:var(--accent)">${displayId(m.d4)}</td><td style="text-align:left">${displayPersonLabel(m.d4)}</td><td style="text-align:left">${m.reason || ""}${m.location ? `<div style="font-size:10px;color:var(--muted)">📍 ${escapeAttr(m.location)}</div>` : ""}</td><td>${m.status ? medTagBadge(m.status) : '<span style="color:var(--muted)">—</span>'}</td><td>${m.startDate || (noDur ? '<span style="color:var(--muted)">—</span>' : "")}</td><td>${m.endDate || (noDur ? '<span style="color:var(--muted)">—</span>' : "")}</td><td>${tagInfo ? medTagBadge(tagInfo.tag) : '<span style="color:var(--dim)">cleared</span>'}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openMedicalForm('${m.id}')" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('medical', '${m.id}', 'medical record')" title="Delete">✕</button></td></tr>`; }).join("")}
        </tbody></table></div>` : `<div class="empty-state">${STATE.medical.length ? `No report sick records in ${filterLabel()}.` : "No report sick records yet."}</div>`}
      </div>
      <div class="card">
        <h3>Most Reports Sick${isFilterActive() ? ` <span style="color:var(--accent);font-weight:400;font-size:10px">in ${filterLabel()}</span>` : ""}</h3>
        ${topReporters.length ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto">
          ${topReporters.map(r => `<div onclick="openPerson('${r.d4}')" style="cursor:pointer;font-size:11px;padding:6px 8px;border-radius:4px;background:var(--surface2);display:flex;justify-content:space-between;gap:8px">
            <span>${displayId(r.d4) ? `<span class="mono" style="color:var(--accent);font-weight:700">${displayId(r.d4)}</span> ` : ""}${displayPersonLabel(r.d4)}</span>
            <span class="mono" style="font-weight:700;color:${r.count >= 5 ? "var(--red)" : r.count >= 3 ? "var(--orange)" : "var(--muted)"}">${r.count}</span>
          </div>`).join("")}
        </div>` : `<div style="color:var(--muted);font-size:12px">No data yet</div>`}
      </div>
    </div>`;
}

// Which IPPT conduct the stats are scoped to. "" = all attempts, else an
// attempt number (1 = IPPT 1, 2 = IPPT 2, …). View-only state, not persisted.
let _ipptAttemptFilter = "";
function setIpptAttemptFilter(v) { _ipptAttemptFilter = v; render(); }

// Which two conducts the comparison scatter + movers list put side by side.
// Defaults to first vs latest conduct with data (set in renderIPPT when the
// stored pair is invalid — e.g. after new data arrives). View-only state.
let _ipptCmpA = "", _ipptCmpB = "";
function setIpptCompare(a, b) { _ipptCmpA = a; _ipptCmpB = b; render(); }

function renderIPPT(el) {
  const visible = visibleD4Set();
  const scoped = STATE.ippt.filter(i => passesFilter(i.d4, visible));

  // Attempt filter — narrows the stats/charts/lists/table to a single IPPT
  // conduct (IPPT 1, IPPT 2, …). "" means all attempts.
  const attempts = [...new Set(STATE.ippt.map(e => +e.attempt).filter(n => n > 0))].sort((a, b) => a - b);
  const attemptFilter = _ipptAttemptFilter && attempts.includes(+_ipptAttemptFilter) ? +_ipptAttemptFilter : "";
  const attemptScoped = attemptFilter ? scoped.filter(e => +e.attempt === attemptFilter) : scoped;

  // Aggregate one entry per recruit (latest or best) for the stats/charts/
  // leaderboard. The underlying table below still shows every row.
  const aggMode = STATE.ipptAggMode || "latest";
  const aggregated = aggregateIPPT(attemptScoped, aggMode);
  const stats = computeIPPTStats(aggregated);

  // YTT chase: recruits in the filtered scope who either have an all-zero
  // IPPT row OR have no IPPT row at all — both are "haven't taken yet". When an
  // attempt is selected, YTT = hasn't taken THAT IPPT.
  const rosterInScope = filteredRoster();
  const takenD4s = new Set(attemptScoped.filter(e => !isYTT(e)).map(e => e.d4));
  const yttRecruits = rosterInScope.filter(r => !takenD4s.has(r.id));

  // Company-wide performance trend across the IPPT conducts: average push-ups,
  // sit-ups and 2.4km time per attempt, over everyone in scope who took that
  // attempt (non-YTT). Independent of the attempt filter — it spans all IPPTs.
  const ipptTrend = attempts.map(n => {
    // Exclude recruits with a 0 run time (incomplete run) — they'd skew the
    // station averages and aren't shown on the growth charts.
    const es = scoped.filter(e => +e.attempt === n && !isYTT(e) && parseRunTimeToSeconds(e.runTime) > 0);
    const avg = f => es.length ? Math.round(es.reduce((s, x) => s + f(x), 0) / es.length) : null;
    const runSecs = es.map(x => parseRunTimeToSeconds(x.runTime)).filter(s => s > 0);
    return {
      n, count: es.length,
      pushups: avg(x => +x.pushups || 0),
      situps: avg(x => +x.situps || 0),
      runSec: runSecs.length ? Math.round(runSecs.reduce((a, b) => a + b, 0) / runSecs.length) : null
    };
  }).filter(r => r.count > 0);

  // Per-recruit score series across every conduct — the shared cohort model
  // for all the cross-attempt visualizations below (progression lines,
  // comparison scatter, movers, award mix). Independent of the attempt filter.
  const series = ipptSeriesByRecruit(scoped);
  const progression = series.filter(r => Object.keys(r.byAttempt).length >= 2);

  // Comparison pair: any two conducts, defaulting to first vs latest so the
  // full journey shows by default (the old fixed IPPT 1 vs 2 stopped meaning
  // anything once IPPT 3 landed). Falls back when the stored pair is stale.
  let cmpA = attempts.includes(+_ipptCmpA) ? +_ipptCmpA : attempts[0];
  let cmpB = attempts.includes(+_ipptCmpB) ? +_ipptCmpB : attempts[attempts.length - 1];
  if (cmpA >= cmpB) { cmpA = attempts[0]; cmpB = attempts[attempts.length - 1]; }
  const cmpPairs = [];
  for (let i = 0; i < attempts.length; i++)
    for (let j = i + 1; j < attempts.length; j++) cmpPairs.push([attempts[i], attempts[j]]);
  const paired = attempts.length >= 2 ? ipptPairedCohort(series, cmpA, cmpB) : [];
  const movers = paired.slice().sort((x, y) => y.delta - x.delta);
  const improvedN = paired.filter(p => p.delta > 0).length;
  const declinedN = paired.filter(p => p.delta < 0).length;

  // Award mix per conduct: tier tally over everyone with a valid score in that
  // conduct. Rendered as 100% stacked bars so a different taker count per
  // conduct can't masquerade as a tier shift.
  const awardMix = attempts.map(n => {
    const scores = series.filter(r => r.byAttempt[n] != null).map(r => r.byAttempt[n]);
    const tally = { "Fail": 0, "Pass": 0, "Silver": 0, "Gold": 0, "Gold★": 0 };
    scores.forEach(s => { tally[getAward(s)] = (tally[getAward(s)] || 0) + 1; });
    return { n, count: scores.length, tally };
  }).filter(r => r.count > 0);

  // Top performers: aggregated, sorted by score desc, YTT excluded.
  const topPerformers = aggregated
    .filter(e => !isYTT(e))
    .slice()
    .sort((a, b) => (+b.score || 0) - (+a.score || 0))
    .slice(0, 10);

  // Score-distribution buckets aligned to award thresholds:
  // [YTT, Fail 0–60, Pass 61–74, Silver 75–84, Gold 85–89, Gold★ 90+]
  const buckets = [0, 0, 0, 0, 0, 0];
  for (const e of aggregated) {
    if (isYTT(e)) { buckets[0]++; continue; }
    const s = +e.score || 0;
    if (s <= 60) buckets[1]++;
    else if (s <= 74) buckets[2]++;
    else if (s <= 84) buckets[3]++;
    else if (s <= 89) buckets[4]++;
    else buckets[5]++;
  }

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <h2 style="font-size:18px;font-weight:700">IPPT Tracker${attemptFilter ? ` <span style="color:var(--accent);font-size:13px">· IPPT ${attemptFilter}</span>` : ""}${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.ippt.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="btn" style="cursor:pointer">Import CSV<input type="file" accept=".csv" onchange="importIPPT(this)" style="display:none"></label>
        <button class="btn btn-success" onclick="pushTab('IPPT',STATE.ippt)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openIPPTForm()">+ Add</button>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Stats use</span>
      <div class="filter-role-group">
        <button class="role-btn ${aggMode === "latest" ? "active" : ""}" onclick="setIpptAggMode('latest'); render()">Latest</button>
        <button class="role-btn ${aggMode === "best" ? "active" : ""}" onclick="setIpptAggMode('best'); render()">Best</button>
      </div>
      <span style="font-size:11px;color:var(--muted)">attempt per recruit</span>
      ${attempts.length > 1 ? `
        <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-left:6px">Conduct</span>
        <div class="filter-role-group">
          <button class="role-btn ${!attemptFilter ? "active" : ""}" onclick="setIpptAttemptFilter('')">All</button>
          ${attempts.map(n => `<button class="role-btn ${attemptFilter === n ? "active" : ""}" onclick="setIpptAttemptFilter('${n}')">IPPT ${n}</button>`).join("")}
        </div>` : ""}
    </div>

    <div class="stats-row">
      <div class="stat"><label>Taken</label><div class="val">${stats.taken}<span style="font-size:12px;color:var(--muted);font-weight:400">/${stats.total}</span></div><div class="sub">${pct(stats.taken, stats.total)}% recorded</div></div>
      <div class="stat"><label>Passed (61+)</label><div class="val" style="color:var(--green)">${stats.passed}</div><div class="sub">${pct(stats.passed, stats.taken)}% of taken</div></div>
      <div class="stat"><label>Failed</label><div class="val" style="color:var(--red)">${stats.fail}</div><div class="sub">${pct(stats.fail, stats.taken)}% of taken</div></div>
      <div class="stat"><label>YTT</label><div class="val" style="color:var(--accent)">${stats.ytt}</div><div class="sub">yet to take${attemptFilter ? ` IPPT ${attemptFilter}` : ""}</div></div>
      <div class="stat"><label>Avg Score</label><div class="val" style="color:var(--accent)">${stats.avgScore || "—"}</div><div class="sub">${stats.scoreN} results</div></div>
      <div class="stat"><label>Avg 2.4km</label><div class="val" style="color:var(--accent)">${formatSeconds(stats.avgRunSec)}</div><div class="sub">${stats.runSecN} results</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>Award Breakdown${isFilterActive() ? ` <span style="color:var(--accent);font-weight:400;font-size:10px">in ${filterLabel()}</span>` : ""}</h3>
        <div class="chart-box tall"><canvas id="chart-ippt-awards"></canvas></div>
      </div>
      <div class="card">
        <h3>Score Distribution</h3>
        <div class="chart-box tall"><canvas id="chart-ippt-distribution"></canvas></div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>YTT Chase List <span style="color:var(--accent);font-weight:400;font-size:10px">${yttRecruits.length} to chase</span></h3>
        ${yttRecruits.length ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto">
          ${yttRecruits.map(r => `<div onclick="openPerson('${r.id}')" style="cursor:pointer;font-size:11px;padding:6px 8px;border-radius:4px;background:var(--surface2);display:flex;justify-content:space-between;gap:8px;align-items:center">
            <span>${displayId(r.id) ? `<span class="mono" style="color:var(--accent);font-weight:700">${displayId(r.id)}</span> ` : ""}${displayPersonLabel(r.id)}</span>
            <span class="badge badge-accent" style="font-size:9px">YTT</span>
          </div>`).join("")}
        </div>` : `<div style="color:var(--muted);font-size:12px;padding:8px">Everyone in scope has taken IPPT 🎉</div>`}
      </div>
      <div class="card">
        <h3>Top Performers <span style="color:var(--muted);font-weight:400;font-size:10px">by ${aggMode === "best" ? "best" : "latest"} attempt</span></h3>
        ${topPerformers.length ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto">
          ${topPerformers.map((e, idx) => `<div onclick="openPerson('${e.d4}')" style="cursor:pointer;font-size:11px;padding:6px 8px;border-radius:4px;background:var(--surface2);display:flex;align-items:center;gap:8px">
            <span class="mono" style="font-weight:700;color:var(--muted);min-width:18px">#${idx + 1}</span>
            <span style="flex:1">${displayId(e.d4) ? `<span class="mono" style="color:var(--accent);font-weight:700">${displayId(e.d4)}</span> ` : ""}${displayPersonLabel(e.d4)}</span>
            <span class="mono" style="font-weight:700">${e.score}</span>
            ${awardBadge(e.score)}
          </div>`).join("")}
        </div>` : `<div style="color:var(--muted);font-size:12px;padding:8px">No taken results yet.</div>`}
      </div>
    </div>

    ${ipptTrend.length >= 2 ? `<div class="card" style="margin-bottom:16px">
      <h3>IPPT Performance Trend <span style="color:var(--muted);font-weight:400;font-size:10px">company avg per station across IPPTs${isFilterActive() ? ` · ${filterLabel()}` : ""}</span></h3>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin:6px 0 10px">
        ${ipptTrend.map(r => `<span>IPPT ${r.n}: <strong style="color:var(--text)">${r.count}</strong> took</span>`).join("")}
        <span>· all lines up = improvement (2.4km axis inverted)</span>
      </div>
      <div class="chart-box" style="height:380px"><canvas id="chart-ippt-trend"></canvas></div>
    </div>` : ""}

    ${attempts.length >= 2 && progression.length >= 2 ? `<div class="card" style="margin-bottom:16px" data-ippt-card="progression">
      <h3 style="font-size:15px">Score Progression <span style="color:var(--muted);font-weight:400;font-size:11px">one line per recruit across all IPPTs · <span style="color:var(--green)">green</span> up / <span style="color:var(--red)">red</span> down vs their first · bold line = company avg</span></h3>
      <div class="chart-box" style="height:420px"><canvas id="chart-ippt-progress"></canvas></div>
    </div>` : ""}

    ${attempts.length >= 2 ? `<div class="card" style="margin-bottom:16px" data-ippt-card="compare">
      <h3 style="font-size:15px">Compare Conducts: IPPT ${cmpA} → IPPT ${cmpB} <span style="color:var(--muted);font-weight:400;font-size:11px">${paired.length} took both · <span style="color:var(--green)">${improvedN} up</span> · <span style="color:var(--red)">${declinedN} down</span></span></h3>
      <div class="filter-role-group" style="margin:8px 0 10px">
        ${cmpPairs.map(([a, b]) => `<button class="role-btn ${a === cmpA && b === cmpB ? "active" : ""}" onclick="setIpptCompare(${a}, ${b})">IPPT ${a} → ${b}</button>`).join("")}
      </div>
      ${paired.length >= 2 ? `
      <div class="chart-box" style="height:460px"><canvas id="chart-ippt-scatter"></canvas></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:14px">
        <div style="flex:1;min-width:220px">
          <h3 style="font-size:12px;color:var(--green)">▲ Most improved</h3>
          ${movers.filter(p => p.delta > 0).slice(0, 5).map(p => `<div onclick="openPerson('${p.d4}')" style="cursor:pointer;font-size:11px;padding:5px 8px;border-radius:4px;background:var(--surface2);display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
            <span>${displayId(p.d4) ? `<span class="mono" style="color:var(--accent);font-weight:700">${displayId(p.d4)}</span> ` : ""}${displayPersonLabel(p.d4)}</span>
            <span class="mono" style="white-space:nowrap">${p.s1} → ${p.s2} <strong style="color:var(--green)">+${p.delta}</strong></span>
          </div>`).join("") || `<div style="color:var(--muted);font-size:11px;padding:4px">No one improved</div>`}
        </div>
        <div style="flex:1;min-width:220px">
          <h3 style="font-size:12px;color:var(--red)">▼ Biggest drops</h3>
          ${movers.filter(p => p.delta < 0).slice(-5).reverse().map(p => `<div onclick="openPerson('${p.d4}')" style="cursor:pointer;font-size:11px;padding:5px 8px;border-radius:4px;background:var(--surface2);display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
            <span>${displayId(p.d4) ? `<span class="mono" style="color:var(--accent);font-weight:700">${displayId(p.d4)}</span> ` : ""}${displayPersonLabel(p.d4)}</span>
            <span class="mono" style="white-space:nowrap">${p.s1} → ${p.s2} <strong style="color:var(--red)">${p.delta}</strong></span>
          </div>`).join("") || `<div style="color:var(--muted);font-size:11px;padding:4px">No one dropped 🎉</div>`}
        </div>
      </div>` : `<div style="color:var(--muted);font-size:12px;padding:8px">Fewer than 2 recruits took both IPPT ${cmpA} and IPPT ${cmpB}.</div>`}
    </div>` : ""}

    ${awardMix.length >= 2 ? `<div class="card" style="margin-bottom:16px" data-ippt-card="awardmix">
      <h3 style="font-size:15px">Award Mix by Conduct <span style="color:var(--muted);font-weight:400;font-size:11px">% of takers per tier · ${awardMix.map(r => `IPPT ${r.n}: ${r.count}`).join(" · ")}</span></h3>
      <div class="chart-box" style="height:360px"><canvas id="chart-ippt-awardmix"></canvas></div>
    </div>` : ""}

    ${attemptScoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th>Name</th><th>#</th><th>Date</th><th>PU</th><th>SU</th><th>2.4km</th><th>Score</th><th>Award</th><th></th></tr></thead><tbody>
    ${attemptScoped.map(i => `<tr><td class="mono" style="font-weight:700">${displayId(i.d4)}</td><td style="text-align:left">${displayPersonLabel(i.d4)}</td><td>${i.attempt}</td><td>${i.date}</td><td>${i.pushups}</td><td>${i.situps}</td><td>${i.runTime}</td><td style="font-weight:700;font-size:15px">${isYTT(i) ? '<span style="color:var(--muted)">—</span>' : i.score}</td><td>${ipptAwardBadge(i)}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="openIPPTForm('${i.id}')" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="deleteEntry('ippt', '${i.id}', 'IPPT entry')" title="Delete">✕</button></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.ippt.length ? `No IPPT entries${attemptFilter ? ` for IPPT ${attemptFilter}` : ""}${isFilterActive() ? ` in ${filterLabel()}` : ""}.` : "No IPPT data yet. Add results or import CSV."}</div>`}`;

  // Charts attached after DOM is in place. Old instances were already wiped
  // by the destroy loop at the top of render().
  buildIPPTAwardsChart(stats);
  buildIPPTDistributionChart(buckets);
  buildIPPTTrendChart(ipptTrend);
  buildIPPTProgressChart(progression, attempts);
  buildIPPTScatterChart(paired, cmpA, cmpB);
  buildIPPTAwardMixChart(awardMix);
}

// Award mix per conduct — 100% stacked bars, one bar per IPPT, segmented by
// tier. Percent-of-takers (not raw counts) so a smaller IPPT 3 cohort still
// compares honestly against IPPT 1/2; tooltips carry the raw counts.
function buildIPPTAwardMixChart(awardMix) {
  const canvas = document.getElementById("chart-ippt-awardmix");
  if (!canvas || typeof Chart === "undefined" || !awardMix || awardMix.length < 2) return;
  // Canvas takes real colour strings, so the tokens are resolved once per build.
  const IK = {
    red: cssColor("--red"), green: cssColor("--green"), accent: cssColor("--accent"),
    yellow: cssColor("--yellow"), purple: cssColor("--purple"), muted: cssColor("--muted"),
    surface: cssColor("--surface"), border: cssColor("--border")
  };
  const tiers = [
    { key: "Fail",   color: IK.red },
    { key: "Pass",   color: IK.green },
    { key: "Silver", color: IK.accent },
    { key: "Gold",   color: IK.yellow },
    { key: "Gold★",  color: IK.purple }
  ];
  STATE.charts.ipptAwardMix = new Chart(canvas, {
    type: "bar",
    data: {
      labels: awardMix.map(r => "IPPT " + r.n),
      datasets: tiers.map(t => ({
        label: t.key,
        data: awardMix.map(r => r.count ? +(r.tally[t.key] / r.count * 100).toFixed(1) : 0),
        counts: awardMix.map(r => r.tally[t.key]),
        backgroundColor: t.color,
        borderColor: IK.surface,
        borderWidth: 1
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: IK.muted, font: { size: 12 }, usePointStyle: true } },
        tooltip: { titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10, callbacks: {
          label: ctx => `${ctx.dataset.label}: ${ctx.dataset.counts[ctx.dataIndex]} (${ctx.parsed.y}%)`
        } }
      },
      scales: {
        y: { stacked: true, min: 0, max: 100, title: { display: true, text: "% of takers", color: IK.muted }, grid: { color: IK.border }, ticks: { color: IK.muted, font: { size: 12 }, callback: v => v + "%" } },
        x: { stacked: true, grid: { display: false }, ticks: { color: IK.muted, font: { size: 14 } } }
      }
    }
  });
}

// Per-recruit score progression — one thin line per recruit across every IPPT
// conduct, coloured by their net journey (latest taken vs first taken): green
// improved, red declined, grey flat. A bold accent line carries the company
// average so the individual spread reads against the trend. Gaps (missed a
// conduct) are bridged by spanGaps.
function buildIPPTProgressChart(progression, attempts) {
  const canvas = document.getElementById("chart-ippt-progress");
  if (!canvas || typeof Chart === "undefined" || !progression || progression.length < 2 || attempts.length < 2) return;
  const PK = {
    up: cssColorA("--green", ".4"), down: cssColorA("--red", ".4"),
    flat: cssColorA("--muted", ".33"), accent: cssColor("--accent"),
    muted: cssColor("--muted"), border: cssColor("--border")
  };
  const lineColor = r => { const d = ipptNetDelta(r); return d > 0 ? PK.up : d < 0 ? PK.down : PK.flat; };
  const avg = attempts.map(n => {
    const xs = progression.filter(r => r.byAttempt[n] != null).map(r => r.byAttempt[n]);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  });
  STATE.charts.ipptProgress = new Chart(canvas, {
    type: "line",
    data: {
      labels: attempts.map(n => "IPPT " + n),
      datasets: [
        ...progression.map(r => ({
          label: r.d4,
          data: attempts.map(n => r.byAttempt[n] != null ? r.byAttempt[n] : null),
          borderColor: lineColor(r),
          backgroundColor: lineColor(r),
          borderWidth: 1.5,
          tension: 0.25,
          pointRadius: 2.5,
          pointHoverRadius: 6,
          spanGaps: true
        })),
        {
          label: "Company avg",
          data: avg,
          borderColor: PK.accent,
          backgroundColor: PK.accent,
          borderWidth: 3.5,
          tension: 0.25,
          pointRadius: 5,
          pointHoverRadius: 8,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10, callbacks: {
          label: ctx => ctx.dataset.label === "Company avg"
            ? `Company avg: ${ctx.parsed.y}`
            : `${displayId(ctx.dataset.label) || ctx.dataset.label} ${getName(ctx.dataset.label)}: ${ctx.parsed.y}`
        } }
      },
      scales: {
        y: { title: { display: true, text: "Score", color: PK.muted, font: { size: 13 } }, grid: { color: PK.border }, ticks: { color: PK.muted, font: { size: 12 } } },
        x: { grid: { display: false }, ticks: { color: PK.muted, font: { size: 14 } } }
      }
    }
  });
}

// Scatter of IPPT a (x) vs IPPT b (y) with a y=x reference line — the pair is
// user-selectable (defaults to first vs latest). Dots above the line improved
// (green), below declined (red). Reveals whether weak or strong recruits grew
// most between the two conducts.
function buildIPPTScatterChart(paired, cmpA, cmpB) {
  const canvas = document.getElementById("chart-ippt-scatter");
  if (!canvas || typeof Chart === "undefined" || !paired || paired.length < 2) return;
  const SK = {
    green: cssColor("--green"), red: cssColor("--red"), muted: cssColor("--muted"),
    border: cssColor("--border")
  };
  const all = paired.flatMap(p => [p.s1, p.s2]);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 5) * 5);
  const hi = Math.min(100, Math.ceil((Math.max(...all) + 5) / 5) * 5);
  STATE.charts.ipptScatter = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Recruits",
          data: paired.map(p => ({ x: p.s1, y: p.s2, d4: p.d4 })),
          pointBackgroundColor: paired.map(p => p.delta > 0 ? SK.green : p.delta < 0 ? SK.red : SK.muted),
          pointBorderColor: "transparent",
          pointRadius: 6,
          pointHoverRadius: 9
        },
        {
          label: "No change (y=x)",
          type: "line",
          data: [{ x: lo, y: lo }, { x: hi, y: hi }],
          borderColor: SK.muted,
          borderDash: [6, 6],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10, callbacks: { label: ctx => ctx.raw.d4 ? `${displayId(ctx.raw.d4) || ctx.raw.d4}: ${ctx.raw.x} → ${ctx.raw.y}` : "" } }
      },
      scales: {
        x: { min: lo, max: hi, title: { display: true, text: `IPPT ${cmpA} score`, color: SK.muted, font: { size: 13 } }, grid: { color: SK.border }, ticks: { color: SK.muted, font: { size: 12 } } },
        y: { min: lo, max: hi, title: { display: true, text: `IPPT ${cmpB} score`, color: SK.muted, font: { size: 13 } }, grid: { color: SK.border }, ticks: { color: SK.muted, font: { size: 12 } } }
      }
    }
  });
}

// Company-wide IPPT trend — one line per station across the IPPT conducts.
// Push-ups and sit-ups (reps) share the left axis; 2.4km time uses a right axis
// in seconds (rendered mm:ss) since its scale and direction differ — lower is
// better there, so a falling run line means improvement.
function buildIPPTTrendChart(trend) {
  const canvas = document.getElementById("chart-ippt-trend");
  if (!canvas || typeof Chart === "undefined" || !trend || trend.length < 2) return;
  const TK = {
    accent: cssColor("--accent"), green: cssColor("--green"), orange: cssColor("--orange"),
    muted: cssColor("--muted"), border: cssColor("--border")
  };
  STATE.charts.ipptTrend = new Chart(canvas, {
    type: "line",
    data: {
      labels: trend.map(r => "IPPT " + r.n),
      datasets: [
        { label: "Avg Push-ups", data: trend.map(r => r.pushups), borderColor: TK.accent, backgroundColor: TK.accent, yAxisID: "reps", borderWidth: 3, tension: 0.3, pointRadius: 6, pointHoverRadius: 8, spanGaps: true },
        { label: "Avg Sit-ups", data: trend.map(r => r.situps), borderColor: TK.green, backgroundColor: TK.green, yAxisID: "reps", borderWidth: 3, tension: 0.3, pointRadius: 6, pointHoverRadius: 8, spanGaps: true },
        { label: "Avg 2.4km", data: trend.map(r => r.runSec), borderColor: TK.orange, backgroundColor: TK.orange, yAxisID: "run", borderWidth: 3, tension: 0.3, pointRadius: 6, pointHoverRadius: 8, spanGaps: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { color: TK.muted, font: { size: 13 }, padding: 16, usePointStyle: true } },
        tooltip: { titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10, callbacks: { label: ctx => ctx.dataset.yAxisID === "run"
          ? `${ctx.dataset.label}: ${formatSeconds(ctx.parsed.y)}`
          : `${ctx.dataset.label}: ${ctx.parsed.y}` } }
      },
      scales: {
        reps: { type: "linear", position: "left", beginAtZero: false, title: { display: true, text: "Reps", color: TK.muted, font: { size: 13 } }, grid: { color: TK.border }, ticks: { color: TK.muted, font: { size: 12 } } },
        // Reversed so a FASTER time (fewer seconds) sits HIGHER — now an upward
        // run line means improvement, matching the rep lines.
        run: { type: "linear", position: "right", reverse: true, title: { display: true, text: "2.4km (faster ↑)", color: TK.muted, font: { size: 13 } }, grid: { drawOnChartArea: false }, ticks: { color: TK.muted, font: { size: 12 }, callback: v => formatSeconds(v) } },
        x: { grid: { display: false }, ticks: { color: TK.muted, font: { size: 14 } } }
      }
    }
  });
}

function buildIPPTAwardsChart(stats) {
  const canvas = document.getElementById("chart-ippt-awards");
  if (!canvas || typeof Chart === "undefined") return;
  // Order high → low so the legend reads top-to-bottom intuitively.
  // Only include non-zero slices so the chart isn't cluttered with empty tiers.
  const AK = {
    purple: cssColor("--purple"), yellow: cssColor("--yellow"), accent: cssColor("--accent"),
    green: cssColor("--green"), red: cssColor("--red"), dim: cssColor("--dim"),
    muted: cssColor("--muted"), surface: cssColor("--surface")
  };
  const labels = [], data = [], colors = [];
  if (stats.goldStar) { labels.push("Gold★"); data.push(stats.goldStar); colors.push(AK.purple); }
  if (stats.gold)     { labels.push("Gold");   data.push(stats.gold);     colors.push(AK.yellow); }
  if (stats.silver)   { labels.push("Silver"); data.push(stats.silver);   colors.push(AK.accent); }
  if (stats.pass)     { labels.push("Pass");   data.push(stats.pass);     colors.push(AK.green); }
  if (stats.fail)     { labels.push("Fail");   data.push(stats.fail);     colors.push(AK.red); }
  if (stats.ytt)      { labels.push("YTT");    data.push(stats.ytt);      colors.push(AK.dim); }
  if (!data.length) return;

  STATE.charts.ipptAwards = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: AK.surface, borderWidth: 2 }] },
    options: { plugins: { legend: { position: "right", labels: { color: AK.muted, font: { size: 11 } } } } }
  });
}

function buildIPPTDistributionChart(buckets) {
  const canvas = document.getElementById("chart-ippt-distribution");
  if (!canvas || typeof Chart === "undefined") return;
  // buckets: [YTT, Fail 0–60, Pass 61–74, Silver 75–84, Gold 85–89, Gold★ 90+]
  const DK = { muted: cssColor("--muted"), border: cssColor("--border") };
  STATE.charts.ipptDistribution = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["YTT", "Fail", "Pass", "Silver", "Gold", "Gold★"],
      datasets: [{
        data: buckets,
        backgroundColor: [cssColor("--dim"), cssColor("--red"), cssColor("--green"), cssColor("--accent"), cssColor("--yellow"), cssColor("--purple")],
        borderWidth: 0,
        borderRadius: 4
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: DK.border }, ticks: { color: DK.muted, stepSize: 1 } },
        x: { grid: { display: false }, ticks: { color: DK.muted, font: { size: 10 } } }
      }
    }
  });
}

// Conducts registry admin tab. Lists every entry in STATE.conducts with usage
// counts across attendance / conductDetail, and offers rename / merge / delete
// actions. New conducts created here become available immediately in every
// form's conduct picker (the picker reads from STATE.conducts).
function renderConducts(el) {
  const rows = [...STATE.conducts].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const totalUsage = rows.reduce((s, c) => s + countConductUsage(c.id).total, 0);
  const orphanedCount = (arr) => arr.filter(r => r.conductId !== undefined && !STATE.conducts.find(c => c.id === r.conductId)).length;
  const orphans = orphanedCount(STATE.attendance) + orphanedCount(STATE.conductDetail);
  const anyRecordsWithConductId = STATE.attendance.some(r => r.conductId) || STATE.conductDetail.some(r => r.conductId);
  const emptyRegistryWithUsage = rows.length === 0 && anyRecordsWithConductId;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <h2 style="font-size:18px;font-weight:700">Conducts Registry <span style="color:var(--muted);font-weight:400;font-size:13px">${rows.length} entries · ${totalUsage} record${totalUsage === 1 ? "" : "s"}</span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${needsConductMigration() ? `<button class="btn" onclick="maybeRunConductMigration()" title="Open the legacy-data migration modal">🔧 Migrate legacy data</button>` : ""}
        ${duplicateConductIdGroups().length ? `<button class="btn" style="background:rgba(var(--redRGB),.13);border-color:rgba(var(--redRGB),.27);color:var(--red)" onclick="openFixConductIdsModal()" title="Multiple conducts share the same id — records resolve to the wrong name. Fix it.">⚠️ Fix duplicate ids (${duplicateConductIdGroups().length})</button>` : ""}
        <button class="btn btn-success" onclick="pushTab('Conducts',STATE.conducts)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="promptCreateConduct()">+ New conduct</button>
      </div>
    </div>
    ${emptyRegistryWithUsage ? `<div class="card" style="padding:12px 14px;margin-bottom:12px;background:rgba(var(--redRGB),.13);border:1px solid rgba(var(--redRGB),.27);font-size:12px;color:var(--red);line-height:1.6">
      <strong>⚠️ Registry is empty but records reference conductIds.</strong> This usually means the Apps Script backend wasn't redeployed with the new <code>Conducts</code> tab in its <code>readAllTabs</code> map. Until that's fixed, conduct names will show as <code>[c001?]</code> placeholders across the app.
      <div style="margin-top:6px;color:var(--muted)">Fix: open Apps Script editor → confirm <code>"Conducts": "conducts"</code> is in <code>tabMap</code> → Deploy → Manage deployments → New version. Then pull again.</div>
    </div>` : ""}
    <div class="card" style="padding:10px 14px;margin-bottom:12px;background:var(--surface2);font-size:11px;color:var(--muted);line-height:1.6">
      Conduct names are renames-safe — every record references the conduct by ID, so renaming here updates every display site without touching record data.
      Use <strong>Merge</strong> to fix near-duplicates that slipped through; use <strong>Delete</strong> only when usage is 0.
      ${orphans > 0 ? `<div style="color:var(--red);margin-top:6px"><strong>Warning:</strong> ${orphans} record${orphans === 1 ? " references" : "s reference"} a conductId not in the registry. Edit those records to repoint them.</div>` : ""}
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th style="text-align:left">Name</th><th>Attendance</th><th>Detail</th><th>Total</th><th></th></tr></thead><tbody>
      ${rows.map(c => {
        const u = countConductUsage(c.id);
        const mergeOpts = rows.filter(o => o.id !== c.id).map(o => `<option value="${o.id}">→ ${escapeAttr(o.name)}</option>`).join("");
        return `<tr>
          <td class="mono" style="color:var(--muted);font-size:11px">${c.id}</td>
          <td style="text-align:left;font-weight:600">${escapeAttr(c.name)}</td>
          <td>${u.attendance}</td>
          <td>${u.detail}</td>
          <td style="font-weight:700;color:${u.total > 0 ? 'var(--accent)' : 'var(--muted)'}">${u.total}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-icon" onclick="promptRenameConduct('${c.id}')" title="Rename">✎</button>
            <select onchange="if (this.value) { mergeConductInto('${c.id}', this.value); this.value=''; }" style="font-size:10px;padding:2px 4px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:3px" title="Merge into another conduct">
              <option value="">Merge →</option>
              ${mergeOpts}
            </select>
            <button class="btn btn-icon btn-danger" onclick="deleteConduct('${c.id}')" title="${u.total > 0 ? `Cannot delete — used by ${u.total} record(s)` : 'Delete'}" ${u.total > 0 ? "disabled" : ""}>✕</button>
          </td>
        </tr>`;
      }).join("")}
    </tbody></table></div>` : `<div class="empty-state">No conducts yet. Add one with "+ New conduct" or run the legacy-data migration if you have existing records.</div>`}
  `;
}

function promptCreateConduct() {
  const name = (prompt("New conduct name:") || "").trim();
  if (!name) return;
  const existingId = conductIdByName(name);
  if (existingId) {
    alert(`"${name}" already exists (id ${existingId}).`);
    return;
  }
  createConduct(name);
  render();
}

function promptRenameConduct(id) {
  const c = STATE.conducts.find(x => x.id === id);
  if (!c) return;
  const newName = prompt("New name:", c.name);
  if (newName == null) return;
  renameConduct(id, newName);
}

// ── Access (owner only) ─────────────────────────────────────────────────────
//
// One page: hand someone a link, see everything that can get in, take any of it
// away. Grouped by person, because a person is the unit you think in — their
// phone and their tablet belong side by side.
//
// The nav button is hidden unless the backend says this token may do it
// (refreshIdentity, js/main.js), and this view refuses to draw its controls
// without it. Neither is the control: js/* is public code served to every
// phone, so anyone can unhide the button or call the action directly. The Edge
// Function refuses every one of these actions without `can_invite`.
let _accessRows = null;
let _accessBusy = false;
let _accessNote = null;

function renderAccess(el) {
  if (!STATE.me?.canInvite) {
    el.innerHTML = `<div class="card"><h2>Access</h2>
      <p style="color:var(--muted)">This device cannot manage access.</p></div>`;
    return;
  }

  // Senior-first, 4D inside a rank: access is handed out to the command body
  // far more often than to a recruit, so they belong at the top of the list.
  const people = sortByRank((STATE.roster || []).filter(r => r.id));
  const rows = _accessRows || [];

  // Group by person so someone's devices sit together, and drop the dead rows:
  // a revoked credential is not something you can act on, and a list of them is
  // just noise on a phone screen.
  const live = rows.filter(r =>
    (r.kind === "token" && r.status === "active") ||
    (r.kind === "invite" && r.status === "open"));
  const groups = new Map();
  for (const r of live) {
    const k = r.d4 || r.person || "?";
    if (!groups.has(k)) groups.set(k, { person: r.person, d4: r.d4, rows: [] });
    groups.get(k).rows.push(r);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => String(a.d4 || "").localeCompare(String(b.d4 || "")));

  el.innerHTML = `
    <h2>Access</h2>
    <p style="color:var(--muted);margin-top:-6px">
      Signed in as <strong>${escapeAttr(STATE.me.person || "unnamed")}</strong>.
      Only this device can hand out access.</p>

    ${_accessNote ? `
      <div class="card" style="border-color:var(--green)">
        <h3 style="margin-top:0">${escapeAttr(_accessNote.title)}</h3>
        <input readonly id="acc-link" value="${escapeAttr(_accessNote.url)}"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--border);
                      background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box">
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" style="flex:1;padding:12px" onclick="copyInviteLink()">Copy link</button>
          <button class="btn" style="padding:12px" onclick="_accessNote=null;render()">Done</button>
        </div>
        <p style="font-size:11px;color:var(--muted);margin:8px 0 0">
          Send it to them directly. Whoever opens it becomes them, in the app and
          in the change history.</p>
      </div>` : ""}

    <div class="card">
      <h3 style="margin-top:0">Give someone access</h3>
      <select id="acc-who" style="width:100%;padding:11px;border-radius:6px;
              border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:14px">
        <option value="">Choose a person…</option>
        ${people.map(r => `<option value="${escapeAttr(r.id)}">${
          escapeAttr(r.id)} ${escapeAttr(r.name || "")}</option>`).join("")}
      </select>
      <input id="acc-device" placeholder="Device name, e.g. phone" value="phone"
             style="width:100%;margin-top:8px;padding:11px;border-radius:6px;
                    border:1px solid var(--border);background:var(--surface);
                    color:var(--text);font-size:14px;box-sizing:border-box">
      <p style="font-size:11px;color:var(--muted);margin:6px 0 0">
        One link per device. Naming them is what lets you remove a lost tablet
        without signing them out of their phone.</p>
      <button class="btn" style="width:100%;margin-top:10px;padding:13px;font-size:15px"
              onclick="createAccessLink()" ${_accessBusy ? "disabled" : ""}>
        ${_accessBusy ? "Working…" : "Create link"}</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Who can get in
        <span style="color:var(--muted);font-weight:400">(${live.length})</span></h3>
      ${_accessRows === null
        ? `<p style="color:var(--muted)">Loading…</p>`
        : ordered.length
          ? ordered.map(accessGroup).join("")
          : `<p style="color:var(--muted)">Nobody yet.</p>`}
    </div>`;

  if (_accessRows === null) loadAccess();
}

function accessGroup(g) {
  return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
    <div style="font-weight:600;font-size:13px">${escapeAttr(g.person || "(unnamed)")}
      <span class="mono" style="color:var(--muted);font-weight:400">${escapeAttr(g.d4 || "")}</span></div>
    ${g.rows.map(accessRow).join("")}
  </div>`;
}

function accessRow(r) {
  const dev = escapeAttr(r.device_label || "device");
  const d4 = escapeAttr(r.d4 || "");
  const mine = r.can_invite;

  if (r.kind === "invite") {
    const exp = r.expires_at ? new Date(r.expires_at).toLocaleDateString() : "—";
    // A multi-use link stays usable AFTER the first redemption — that is the
    // whole point of it, since it lets someone re-open it on a second device or
    // after clearing their browser. So "not opened yet" is only true while
    // used_count is 0; past that it is a live link with uses remaining, and
    // saying otherwise would have the page lying about the credential it is
    // holding.
    const used = Number(r.used_count || 0);
    const left = Math.max(Number(r.max_uses || 1) - used, 0);
    const state = used === 0
      ? `<span style="color:var(--yellow)">● not opened yet</span>`
      : `<span style="color:var(--yellow)">● link still usable</span>`;
    const uses = used === 0 ? "" : ` · ${left} use${left === 1 ? "" : "s"} left`;
    return `<div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
      <span style="flex:1;min-width:120px;font-size:12px">
        ${state} · ${dev}${uses}
        <span style="color:var(--muted)"> · expires ${exp}</span></span>
      ${r.token ? `<button class="btn" style="padding:7px 11px;font-size:12px"
        onclick="copyRowLink('${escapeAttr(r.token)}')">Copy link</button>` : ""}
      <button class="btn btn-danger" style="padding:7px 11px;font-size:12px"
        onclick="revokeAccessFor('${d4}','invite','${escapeAttr(r.person || "")}','${dev}')">Cancel</button>
    </div>`;
  }

  // An active token that nobody has used for a long time is the signature of a
  // cleared browser: the row looks fine, the person cannot get in. Surface it
  // rather than waiting for them to complain.
  const seen = r.last_seen_at ? new Date(r.last_seen_at) : null;
  const days = seen ? Math.floor((Date.now() - seen) / 86400000) : null;
  const stale = days === null || days >= 14;
  const when = seen ? (days === 0 ? "today" : `${days}d ago`) : "never used";

  return `<div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
    <span style="flex:1;min-width:120px;font-size:12px">
      <span style="color:var(--green)">● active</span> · ${dev}
      <span style="color:${stale ? "var(--orange)" : "var(--muted)"}"> · ${when}</span>
      ${mine ? '<span style="color:var(--accent);font-size:10px"> · you</span>' : ""}</span>
    ${mine ? "" : `
      <button class="btn" style="padding:7px 11px;font-size:12px"
        onclick="reissueAccessFor('${d4}','${dev}','${escapeAttr(r.person || "")}')">Re-issue</button>
      <button class="btn btn-danger" style="padding:7px 11px;font-size:12px"
        onclick="revokeAccessFor('${d4}','token','${escapeAttr(r.person || "")}','${dev}')">Remove</button>`}
  </div>`;
}

function inviteUrl(token) {
  // Built here so the link points at wherever this app is actually served from,
  // which is what the recipient opens and differs between the live site and a
  // local preview.
  return location.origin + location.pathname.replace(/[^/]*$/, "") + "?token=" + token;
}

async function loadAccess() {
  try {
    const res = await API.listAccess();
    _accessRows = (res && res.access) || [];
  } catch (e) {
    _accessRows = [];
    if (typeof syncLog === "function") syncLog(`Could not load access: ${e.message}`, "var(--red)");
  }
  if (STATE.nav === "access") render();
}

async function createAccessLink() {
  const d4 = document.getElementById("acc-who")?.value;
  const device = (document.getElementById("acc-device")?.value || "device").trim();
  if (!d4) { alert("Choose a person first."); return; }
  _accessBusy = true; render();
  try {
    // Three uses over 90 days: the same link covers a second device AND lets
    // them re-open it after a browser wipe, without needing you at all.
    const res = await API.createInvite(d4, device, 90, 3);
    if (res.error) { alert(res.error); return; }
    _accessNote = { title: `Link for ${res.person} (${device})`, url: inviteUrl(res.token) };
    _accessRows = null;
  } catch (e) {
    alert(`Could not create the link: ${e.message}`);
  } finally {
    _accessBusy = false; render();
  }
}

// The cleared-browser fix: kill the token they can no longer reach, mint a
// fresh link for the same person and device, hand it straight back.
async function reissueAccessFor(d4, device, person) {
  if (!confirm(`${person || d4} lost access on "${device}"?\n\nThis signs that device out and creates a new link to send them.`)) return;
  _accessBusy = true; render();
  try {
    const res = await API.reissueAccess(d4, device, 90, 3);
    if (res.error) { alert(res.error); return; }
    _accessNote = { title: `New link for ${res.person} (${device})`, url: inviteUrl(res.token) };
    _accessRows = null;
  } catch (e) {
    alert(`Could not re-issue: ${e.message}`);
  } finally {
    _accessBusy = false; render();
  }
}

async function revokeAccessFor(d4, what, person, device) {
  const verb = what === "token" ? "Remove" : "Cancel the link for";
  if (!confirm(`${verb} ${person || d4}${device ? ` (${device})` : ""}?`)) return;
  try {
    const res = await API.revokeAccess(d4, what, device || null);
    if (res.error) { alert(res.error); return; }
    _accessRows = null; render();
  } catch (e) {
    alert(`Could not do that: ${e.message}`);
  }
}

function copyRowLink(token) {
  const url = inviteUrl(token);
  navigator.clipboard?.writeText(url).catch(() => {});
  _accessNote = { title: "Link", url };
  render();
}

function copyInviteLink() {
  const input = document.getElementById("acc-link");
  if (!input) return;
  // Clipboard access is refused in some mobile contexts; selecting the text is
  // a working fallback rather than a dead end.
  navigator.clipboard?.writeText(input.value).catch(() => {});
  input.focus(); input.select();
}

// ═══════════════════════════════════════════════════════════════════════════
// Duty schedule
//
// TWO DIFFERENT SCREENS, not one screen with the buttons taken out.
//
// Almost everybody who opens this is a commander asking one question: when am
// I next on, and how many offs have I got left. Handing him the planner - a
// month of coverage pips, a fairness spread, an issues list - buries that
// answer under work that is not his. So a non-admin gets a short read-only
// screen that leads with his own next duty, and the admin gets the planner.
//
// canEditDuty() is presentation only. The Edge Function refuses a write to
// Duty / Calendar / OilRules from a non-admin token whatever this renders.
// ═══════════════════════════════════════════════════════════════════════════

// Name order as the tie-break inside a rank, matching the parade-state picker.
const dutyByName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));

const DUTY_ROLE_COLOR = { PDS: "accent", CDS: "accent2", COS: "teal",
                          SENTRY: "pink", GD: "orange", CDO: "accentLift" };
const dutyRoleTint = role => `var(--${DUTY_ROLE_COLOR[role] || "muted"})`;

// "TUE 6 OCT". Short enough for a row, unambiguous enough for a roster.
function dutyDayLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso || "";
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MONS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONS[d.getMonth()]}`;
}
function dutyShiftISO(iso, n) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const dutyIsWeekend = iso => {
  const d = new Date(iso + "T00:00:00");
  return !isNaN(d) && (d.getDay() === 0 || d.getDay() === 6);
};
// How far away a date is, in the words a person would use.
function dutyWhen(iso, today) {
  if (iso === today) return "today";
  if (iso === dutyShiftISO(today, 1)) return "tomorrow";
  const a = new Date(today + "T00:00:00"), b = new Date(iso + "T00:00:00");
  const n = Math.round((b - a) / 86400000);
  return n > 0 ? `in ${n} days` : `${Math.abs(n)} days ago`;
}

// Who is holding this phone.
//
// The invite issues one token per person and auth_tokens carries their 4D, so
// whoami ALREADY knows who this is - 34 of the 35 live tokens name a
// commander. There is deliberately no "which of these are you?" picker: it
// would be a self-declaration, and a self-declaration on this screen means
// reading somebody else's duties and off balances by choosing their name.
//
// The cache exists because whoami needs the network and this app is expected
// to work without it. It stores what the SERVER said, not what a user picked,
// and is written only by identityCached() on a successful whoami.
function dutyMeD4() {
  const live = STATE.me && STATE.me.d4;
  if (live) return padD4(live);
  const c = cachedIdentity();
  return c && c.d4 ? padD4(c.d4) : "";
}

let _dutyMode = "today";      // admin only: today | month | people
let _dutyCursor = "";         // the date the day view is showing
let _dutyMonth = "";          // YYYY-MM the month view is showing

function renderDuty(el) {
  const today = todayISO();
  if (!_dutyCursor) _dutyCursor = today;
  if (!_dutyMonth) _dutyMonth = today.slice(0, 7);
  el.innerHTML = canEditDuty() ? dutyAdminHtml(today) : dutyReaderHtml(today);
}

// ── The reader's screen ────────────────────────────────────────────────────
// One scroll, four things, in the order he needs them.
function dutyReaderHtml(today) {
  const me = dutyMeD4();
  const r = me ? STATE.roster.find(x => x.id === me) : null;
  return `
    <div class="dty-head"><h2>Duty</h2>
      <span class="dty-sub">${dutyDayLabel(today)}</span></div>
    ${r && r.role === "Commander" ? dutyMineHtml(me, today) : dutyNoIdentityHtml()}
    ${dutyTodayCardHtml(today, false)}
    <div class="dty-foot">Built by the company admin. Ask them for a change.</div>`;
}

// Shown when the access code on this device does not resolve to a commander
// on the roster. There is nothing to pick here on purpose - see dutyMeD4.
function dutyNoIdentityHtml() {
  return `<div class="card"><div class="pad">
      <div class="dty-ask">We cannot tell who you are on this device</div>
      <div class="dty-asksub">Your duties are looked up from your own access code, so
        nobody can read someone else's by mistake. Today's team is below.
        If this is wrong, ask the company admin to reissue your access.</div>
    </div></div>`;
}

// The answer to "when am I next on", given the space it deserves.
function dutyMineHtml(d4, today) {
  const next = dutyNextFor(d4, today, 2);
  const bal = commanderBalances(d4);
  const n0 = next[0];

  const strip = Array.from({ length: 7 }, (_, i) => {
    const iso = dutyShiftISO(today, i);
    const mine = (STATE.duty || []).find(x =>
      x && x.d4 === d4 && x.date === iso && (!x.status || x.status === "published"));
    const out = outOfCampMap(iso).get(d4);
    const code = mine ? mine.role + (mine.slot || "")
      : out ? (out.kind === "medical" ? "MC" : "OFF")
      : dutyIsWeekend(iso) ? "" : "-";
    const tint = mine ? dutyRoleTint(mine.role)
      : out ? (out.kind === "medical" ? "var(--red)" : "var(--purple)") : "var(--dim)";
    const d = new Date(iso + "T00:00:00");
    return `<div class="dty-strip-day${iso === today ? " is-today" : ""}${dutyIsWeekend(iso) ? " is-week" : ""}">
        <span class="dty-strip-dow">${["S","M","T","W","T","F","S"][d.getDay()]}</span>
        <span class="dty-strip-num mono">${d.getDate()}</span>
        <span class="dty-strip-code mono" style="color:${tint}">${escapeHtml(code)}</span>
      </div>`;
  }).join("");

  return `
    <div class="card dty-mine">
      <div class="dty-mine-top">
        <div class="dty-mine-who">${escapeHtml(displayPersonLabel(d4))}</div>
      </div>
      ${n0 ? `
        <div class="dty-mine-next">
          <span class="dty-mine-role mono" style="color:${dutyRoleTint(n0.role)}">${escapeHtml(n0.role + (n0.slot || ""))}</span>
          <span class="dty-mine-when">${escapeHtml(dutyDayLabel(n0.date))}
            <small>${escapeHtml(dutyWhen(n0.date, today))}</small></span>
        </div>
        ${next[1] ? `<div class="dty-mine-then">then ${escapeHtml(next[1].role + (next[1].slot || ""))} on ${escapeHtml(dutyDayLabel(next[1].date))}</div>` : ""}
      ` : `<div class="dty-mine-none">No duty scheduled.</div>`}
      <div class="dty-strip">${strip}</div>
      ${bal ? `
        <div class="dty-mine-bal">
          <span class="oil">Off in lieu <b class="mono">${dutyNum(bal.oil.remaining)}</b> left<small> of ${dutyNum(bal.oil.entitled)}</small></span>
          <span class="al">Annual leave <b class="mono">${dutyNum(bal.al.remaining)}</b> left<small> of ${dutyNum(bal.al.entitled)}</small></span>
        </div>` : ""}
    </div>`;
}
const dutyNum = n => Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);

// Today's team. The reader gets it flat and unclickable; the admin gets the
// same card with every row a control.
function dutyTodayCardHtml(iso, editable) {
  const cov = dutyCoverage(iso, editable);
  const out = outOfCampMap(iso);
  const cal = dutyCalendarFor(iso);

  if (!cov.demanded) {
    return `<div class="card"><header class="dty-cardhead"><h3>ON DUTY</h3></header>
      <div class="pad dty-quiet">${dutyIsWeekend(iso) ? "Weekend - no duties." :
        cal.some(c => c.code === "PH") ? "Public holiday - no duties." : "No duties today."}</div></div>`;
  }

  const rows = cov.slots.map(s => {
    const d4 = cov.held[s.key];
    const o = d4 ? out.get(d4) : null;
    const cls = !d4 ? "gap" : o ? "clash" : "";
    const body = `
      <span class="dty-slot-role mono" style="color:${d4 && !o ? dutyRoleTint(s.role) : ""}">${escapeHtml(s.key)}</span>
      <span class="dty-slot-who">${d4 ? escapeHtml(displayPersonLabel(d4)) : "not assigned"}
        ${o ? `<small>${escapeHtml(o.reason || o.kind)}</small>` : ""}</span>
      ${editable ? '<span class="dty-chev">&rsaquo;</span>' : ""}`;
    return editable
      ? `<button class="dty-slot ${cls}" onclick="openDutySlot('${escapeAttr(iso)}','${escapeAttr(s.key)}')">${body}</button>`
      : `<div class="dty-slot ${cls}">${body}</div>`;
  }).join("");

  return `
    <div class="card">
      <header class="dty-cardhead"><h3>ON DUTY</h3>
        <span class="right mono" style="color:${cov.gaps.length ? "var(--red)" : "var(--dim)"}">
          ${cov.filled}/${cov.demanded}</span></header>
      ${rows}
      ${cal.length ? `<div class="pad dty-calline">${cal.map(c =>
        `<span class="mono">${escapeHtml(c.code)}</span> ${escapeHtml(c.label || "")}`).join(" &middot; ")}</div>` : ""}
    </div>`;
}

// ── The admin's screen ─────────────────────────────────────────────────────
function dutyAdminHtml(today) {
  return `
    <div class="dty-head"><h2>Duty</h2>
      <span class="dty-sub">${escapeHtml(dutyMonthLabel(_dutyMonth))}</span></div>
    <div class="dty-seg" role="tablist">
      ${[["today", "TODAY"], ["month", "MONTH"], ["people", "PEOPLE"]].map(([k, t]) =>
        `<button role="tab" aria-selected="${_dutyMode === k}" onclick="setDutyMode('${k}')">${t}</button>`).join("")}
    </div>
    ${_dutyMode === "today" ? dutyAdminToday(today)
      : _dutyMode === "month" ? dutyAdminMonth(today) : dutyAdminPeople()}`;
}
function setDutyMode(m) {
  _dutyMode = m;
  const el = document.getElementById("content");
  if (el) el.scrollTop = 0;
  render();
}
function dutyMonthLabel(ym) {
  const MONS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
                "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
  const [y, m] = String(ym || "").split("-");
  return m ? `${MONS[+m - 1]} ${y}` : "";
}
function dutyMonthDays(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return [];
  const last = new Date(y, m, 0).getDate();
  const p = x => String(x).padStart(2, "0");
  return Array.from({ length: last }, (_, i) => `${y}-${p(m)}-${p(i + 1)}`);
}
function dutyStepDay(n) { _dutyCursor = dutyShiftISO(_dutyCursor, n); render(); }
function dutyStepMonth(n) {
  const [y, m] = _dutyMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  _dutyMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  render();
}
function dutyOpenDay(iso) { _dutyCursor = iso; _dutyMode = "today"; render(); }

function dutyAdminToday(today) {
  const iso = _dutyCursor;
  const cov = dutyCoverage(iso, true);
  const out = outOfCampMap(iso);
  const cmdrs = STATE.roster.filter(r => r.role === "Commander");
  const away = cmdrs.filter(c => out.has(c.id));

  return `
    <div class="dty-daynav">
      <button onclick="dutyStepDay(-1)" aria-label="Previous day">&lsaquo;</button>
      <span class="dty-daylabel">${dutyDayLabel(iso)}${iso === today ? '<span class="dty-now mono">TODAY</span>' : ""}</span>
      <button onclick="dutyStepDay(1)" aria-label="Next day">&rsaquo;</button>
    </div>
    <div class="stats-row dty-tiles">
      <div class="stat"><label>IN CAMP</label>
        <div class="val mono">${cmdrs.length - away.length}<small>/${cmdrs.length}</small></div></div>
      <div class="stat"><label>ON DUTY</label>
        <div class="val mono" style="color:${cov.gaps.length ? "var(--red)" : ""}">${cov.filled}<small>/${cov.demanded}</small></div></div>
      <div class="stat"><label>AWAY</label>
        <div class="val mono" style="color:${away.length ? "var(--orange)" : ""}">${away.length}</div></div>
    </div>
    ${dutyTodayCardHtml(iso, true)}
    <div class="card">
      <header class="dty-cardhead"><h3>OUT OF CAMP</h3><span class="right mono" style="color:var(--dim)">${away.length}</span></header>
      ${away.length ? away.map(c => {
        const o = out.get(c.id);
        return `<div class="dty-slot">
          <span class="dty-slot-role mono" style="color:${o.kind === "medical" ? "var(--red)" : "var(--purple)"}">${o.kind === "medical" ? "MC" : "AWAY"}</span>
          <span class="dty-slot-who">${escapeHtml(displayPersonLabel(c.id))}
            <small>${escapeHtml(o.reason || o.kind)}</small></span></div>`;
      }).join("") : '<div class="pad dty-quiet">Everyone is in camp.</div>'}
    </div>
    <div class="dty-foot">Who is out is read from the medical and leave records, so this
      can never disagree with the strength board.</div>`;
}

// The month. A 24 x 31 grid does not fit a phone, so it is never drawn: the
// month is a vertical list of days, and coverage rides on pips. One hollow
// red pip is one unfilled duty, which is the whole month readable in a scroll.
function dutyAdminMonth(today) {
  const days = dutyMonthDays(_dutyMonth);
  const problems = [];
  let demanded = 0, filled = 0;
  // A month with no rows at all has not been planned; it is not 110 problems.
  const planned = days.some(iso => dutyRowsOn(iso).length);

  const rows = days.map(iso => {
    const cov = dutyCoverage(iso, true);
    // Only a day that has not happened yet can be acted on. Counting the ones
    // behind us buried the handful that matter under eighty that do not, and
    // nobody is going back to fill last Tuesday's COS.
    //
    // The headline counts the same window as the list, deliberately: showing
    // coverage for the whole month beside a forward-looking problem count gave
    // two figures that did not reconcile, and a reader has to trust the sum.
    if (iso >= today) {
      demanded += cov.demanded; filled += cov.filled;
      cov.gaps.forEach(g => problems.push({ kind: "gap", iso, slot: g }));
      cov.clashes.forEach(c => problems.push({ kind: "clash", iso, slot: c }));
    }

    const cal = dutyCalendarFor(iso);
    const pips = cov.slots.map(s => {
      const d4 = cov.held[s.key];
      if (!d4) return '<span class="dty-pip is-gap"></span>';
      if (outOfCampMap(iso).has(d4)) return '<span class="dty-pip is-clash"></span>';
      return `<span class="dty-pip" style="background:${dutyRoleTint(s.role)}"></span>`;
    }).join("");

    const lead = cov.slots.find(s => cov.held[s.key]);
    const summary = !cov.demanded
      ? (dutyIsWeekend(iso) ? "weekend" : cal.some(c => c.code === "PH") ? "public holiday" : "no duties")
      : lead ? `${lead.key} ${escapeHtml(displayPersonLabel(cov.held[lead.key]))}${cov.filled > 1 ? ` +${cov.filled - 1}` : ""}`
             : "nothing assigned";
    const d = new Date(iso + "T00:00:00");
    return `<button class="dty-dayrow${dutyIsWeekend(iso) || cal.some(c => c.code === "PH") ? " is-week" : ""}${iso === today ? " is-today" : ""}"
        onclick="dutyOpenDay('${escapeAttr(iso)}')">
      <span class="dty-dnum mono">${["SUN","MON","TUE","WED","THU","FRI","SAT"][d.getDay()]}<b>${d.getDate()}</b></span>
      <span class="dty-pips">${pips || '<span class="dty-quiet">&mdash;</span>'}</span>
      <span class="dty-daysum">${summary}${cal.length ? ` <span class="dty-ctx mono">${escapeHtml(cal[0].code)}</span>` : ""}</span>
      <span class="dty-chev">&rsaquo;</span></button>`;
  }).join("");

  const gaps = problems.filter(p => p.kind === "gap");
  const clashes = problems.filter(p => p.kind === "clash");

  return `
    <div class="dty-daynav">
      <button onclick="dutyStepMonth(-1)" aria-label="Previous month">&lsaquo;</button>
      <span class="dty-daylabel">${escapeHtml(dutyMonthLabel(_dutyMonth))}</span>
      <button onclick="dutyStepMonth(1)" aria-label="Next month">&rsaquo;</button>
    </div>
    ${!demanded ? "" : !planned ? `
      <div class="dty-cover">
        <b class="mono">${demanded}</b> duties to fill
        <span>this month has not been planned yet</span>
      </div>` : `
      <div class="dty-cover ${gaps.length || clashes.length ? "is-bad" : "is-ok"}">
        <b class="mono">${filled}/${demanded}</b> covered from today
        ${gaps.length || clashes.length
          ? `<span>${gaps.length ? `${gaps.length} still to fill` : ""}${gaps.length && clashes.length ? " &middot; " : ""}${clashes.length ? `${clashes.length} on someone away` : ""}</span>`
          : "<span>nothing outstanding</span>"}
      </div>`}
    ${problems.length ? `
      <div class="card">
        <header class="dty-cardhead"><h3>NEEDS A LOOK</h3><span class="right mono" style="color:var(--orange)">${problems.length}</span></header>
        ${problems.slice(0, 5).map(p => `
          <button class="dty-issue ${p.kind}" onclick="dutyOpenDay('${escapeAttr(p.iso)}')">
            <span class="dty-issue-kind mono">${p.kind === "gap" ? "GAP" : "CLASH"}</span>
            <span class="dty-issue-txt">${p.kind === "gap"
              ? `${escapeHtml(p.slot.key)} unassigned`
              : `${escapeHtml(displayPersonLabel(p.slot.d4))} is away`}
              <small>${escapeHtml(dutyDayLabel(p.iso))}${p.kind === "clash" ? ` &middot; holds ${escapeHtml(p.slot.key)}` : ""}</small></span>
            <span class="dty-chev">&rsaquo;</span></button>`).join("")}
        ${problems.length > 5 ? `<div class="pad dty-quiet">and ${problems.length - 5} more</div>` : ""}
        <div class="pad dty-quiet">From ${escapeHtml(dutyDayLabel(today))} onwards. Days already
          past are left alone.</div>
      </div>` : ""}
    <div class="card"><div class="dty-monthlist">${rows}</div></div>`;
}

// Fairness and the two off ledgers. The four commanders who are in the
// schedule but not in the OFF system get one line saying so - a row of zeros
// would read as "he has taken everything".
function dutyAdminPeople() {
  const t = dutyTallies(true);
  const cmdrs = STATE.roster.filter(r => r.role === "Commander");
  const max = Math.max(1, ...cmdrs.map(c => dutyTallyOf(t, c.id).total));
  const spread = (() => {
    const v = cmdrs.filter(c => dutyEligibleRoles(c).includes("PDS")).map(c => dutyTallyOf(t, c.id).PDS);
    return v.length ? Math.max(...v) - Math.min(...v) : 0;
  })();
  const tracked = cmdrs.filter(c => commanderBalances(c.id));

  const byPlt = {};
  sortByRank(cmdrs, dutyByName).forEach(c => {
    const k = getPlt(c) || "HQ";
    (byPlt[k] = byPlt[k] || []).push(c);
  });

  const groups = Object.keys(byPlt).sort().map(k => `
    <div class="dty-grp">${k === "HQ" ? "COY HQ" : "PLATOON " + k}</div>
    <div class="card">${byPlt[k].map(c => {
      const x = dutyTallyOf(t, c.id), bal = commanderBalances(c.id);
      const seg = (n, col) => n ? `<span style="flex:${n};background:${col}"></span>` : "";
      return `<button class="dty-bal" onclick="openDutyPerson('${escapeAttr(c.id)}')">
        <span class="dty-bal-top">
          <span class="dty-bal-nm">${escapeHtml(displayPersonLabel(c.id))}</span>
          ${c.appt ? `<span class="dty-bal-appt mono">${escapeHtml(c.appt)}</span>` : ""}</span>
        <span class="dty-bar" style="width:${Math.max(12, (x.total / max) * 100)}%">
          ${seg(x.PDS, "var(--accent)")}${seg(x.CDS, "var(--accent2)")}${seg(x.COS, "var(--teal)")}${seg(x.GD, "var(--orange)")}${seg(x.CDO, "var(--accentLift)")}</span>
        <span class="dty-bal-nums mono">PDS <b>${x.PDS}</b> &middot; CDS <b>${x.CDS}</b> &middot; COS <b>${x.COS}</b> &middot; total <b>${x.total}</b></span>
        ${bal ? `<span class="dty-bal-led">
            <span class="oil">OIL <b class="mono">${dutyNum(bal.oil.remaining)}</b>/${dutyNum(bal.oil.entitled)}</span>
            <span class="al">AL <b class="mono">${dutyNum(bal.al.remaining)}</b>/${dutyNum(bal.al.entitled)}</span></span>`
          : `<span class="dty-bal-untracked">not in the off system</span>`}
      </button>`;
    }).join("")}</div>`).join("");

  return `
    <div class="stats-row dty-tiles">
      <div class="stat"><label>PDS SPREAD</label><div class="val mono"
        style="color:${spread <= 2 ? "var(--teal)" : spread <= 4 ? "var(--orange)" : "var(--red)"}">&plusmn;${spread}</div></div>
      <div class="stat"><label>TRACKED</label><div class="val mono">${tracked.length}<small>/${cmdrs.length}</small></div></div>
      <div class="stat"><label>COMMANDERS</label><div class="val mono">${cmdrs.length}</div></div>
    </div>
    ${groups || '<div class="card"><div class="pad dty-quiet">No commanders in the roster yet.</div></div>'}
    <div class="dty-foot">Balances are worked out from the entitlement rules and the leave
      records. Nothing here is typed in, so nothing can drift.</div>`;
}
