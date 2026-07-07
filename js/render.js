// View layer. render() dispatches to a per-tab function which fills #content.
// Each tab function may also (re)create charts; old chart instances are
// destroyed at the top of render() to avoid Chart.js canvas reuse errors.

function render() {
  Object.values(STATE.charts).forEach(c => c.destroy());
  STATE.charts = {};

  // Reset scroll on tab switches so a long previous tab doesn't leave the
  // next one looking pre-scrolled (and on mobile hiding the topbar).
  document.getElementById("content")?.scrollTo(0, 0);

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
    case "rm": renderRM(el); break;
    case "soc": renderSOC(el); break;
    case "polar": renderPolar(el); break;
    case "leave": renderLeave(el); break;
    case "mskAnalytics": renderMSKAnalytics(el); break;
    case "conducts": renderConducts(el); break;
    case "sync": renderSync(el); break;
    default: el.innerHTML = "";
  }
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
  // MC/Warded + active leave + manual book-outs. This is the SAME source the
  // parade state uses, so the dashboard "In Camp" and parade CURRENT STRENGTH
  // always agree. (Note: "Non-Active" above is medical-only — a recruit on LD/
  // Excuse is non-active/restricted but still IN camp; only MC/Warded/leave/
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
  // Inline "total/recruits/commanders" — the /R/C portion renders smaller
  // and dimmer so the headline number stays pronounced. Hidden when scope
  // is already narrowed to one role.
  const inlineBreakdown = (rec, cmd) => isAll
    ? `<span style="font-size:55%;color:var(--muted);font-weight:400;margin-left:1px">/${rec}/${cmd}</span>`
    : "";

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;flex-wrap:wrap">
      <h2 style="font-size:18px;font-weight:700">Company Strength Board</h2>
      <div class="dropdown-wrapper">
        <button class="btn btn-primary" onclick="toggleReportMenu(event)">📋 Generate Report ▾</button>
        <div id="report-menu" class="dropdown-menu hidden">
          <button type="button" onclick="openReportModal('FP'); closeReportMenu()">📋 First Parade State</button>
          <button type="button" onclick="openReportModal('LP'); closeReportMenu()">📋 Last Parade State</button>
          <button type="button" onclick="openReportModal('MED'); closeReportMenu()">🏥 Medical Status List</button>
          <button type="button" onclick="openReportModal('MSK'); closeReportMenu()">🦵 MSK Report</button>
          <button type="button" onclick="openReportModal('CONDUCT'); closeReportMenu()">📊 Per-Conduct Chat Format</button>
        </div>
      </div>
    </div>
    ${scopeBanner}
    <div class="stats-row" style="margin-top:12px">
      <div class="stat"><label>Total Str</label><div class="val">${scoped.length}${inlineBreakdown(recRows.length, cmdRows.length)}</div></div>
      <div class="stat"><label>Active today</label><div class="val" style="color:var(--green)">${active}${inlineBreakdown(recActive, cmdActive)}</div></div>
      <div class="stat"><label>Non-Active</label><div class="val" style="color:var(--red)">${liveRows.length}${inlineBreakdown(recLive.length, cmdLive.length)}</div></div>
      <div class="stat"><label>In Camp</label><div class="val" style="color:var(--teal)">${inCamp}${inlineBreakdown(recInCamp, cmdInCamp)}</div></div>
      <div class="stat"><label>Out of Camp</label><div class="val" style="color:var(--orange)">${awayFromCamp}${inlineBreakdown(recAway, cmdAway)}</div></div>
      <div class="stat"><label>Avg Part.</label><div class="val" style="color:var(--accent)">${avgPart}%</div></div>
    </div>
    ${renderDashOutOfCamp(scoped, outMap)}
    ${renderDashAppointments(visible, today)}
    <div class="grid-2">
      <div class="card"><h3>Status Breakdown (today)</h3><canvas id="chart-status" height="200"></canvas></div>
      <div class="card"><h3>Participation Trend</h3><canvas id="chart-participation" height="200"></canvas></div>
    </div>
    ${renderDashProfileCards(scoped)}
    <h3 style="font-size:13px;color:var(--muted);margin-bottom:8px">Non-Active Personnel <span style="color:var(--dim);font-weight:400">(live medical status on ${today})</span></h3>
    ${liveRows.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Status today</th><th style="text-align:left">Reason</th><th style="text-align:left">Duration</th></tr></thead><tbody>
    ${liveRows.map(r => {
      const entry = allByD4[r.id];
      const multi = entry.statuses.length > 1;
      // Stack badges, reasons, and durations vertically so each cell aligns
      // row-by-row across the three columns when a recruit has 2+ statuses.
      const tagsCell = entry.statuses.map(s => `<div style="padding:2px 0">${medTagBadge(s.tag)}</div>`).join("");
      const reasonsCell = entry.statuses.map(s => `<div style="padding:2px 0">${s.record.reason || '<span style="color:var(--dim)">—</span>'}</div>`).join("");
      const durationsCell = entry.statuses.map(s => `<div style="padding:2px 0">${medDurationLabel(s.record)}</div>`).join("");
      const multiHint = multi ? ` <span style="font-size:9px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.5px">×${entry.statuses.length}</span>` : "";
      return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer"><td class="mono" style="font-weight:700;color:var(--accent);vertical-align:top">${displayId(r.id)}</td><td style="text-align:left;vertical-align:top">${displayPersonLabel(r.id)}${multiHint}</td><td style="text-align:left;vertical-align:top">${tagsCell}</td><td style="text-align:left;font-size:11px;vertical-align:top">${reasonsCell}</td><td style="text-align:left;font-size:11px;color:var(--muted);vertical-align:top">${durationsCell}</td></tr>`;
    }).join("")}
    </tbody></table></div>` : `<div class="empty-state" style="padding:16px;font-size:12px">All scoped personnel are Active today.</div>`}
    ${recoveringRows.length ? `<h3 style="font-size:13px;color:var(--muted);margin:16px 0 8px">Recovering <span style="color:var(--dim);font-weight:400">(post-MC/LD ghost tag — back to training but monitor)</span></h3>
    <div class="table-wrap"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Tag</th><th style="text-align:left">Original</th><th style="text-align:left">Cleared</th></tr></thead><tbody>
    ${recoveringRows.map(r => {
      const entry = allByD4[r.id];
      const tagsCell = entry.statuses.map(s => `<div style="padding:2px 0">${medTagBadge(s.tag)}</div>`).join("");
      const originalCell = entry.statuses.map(s => `<div style="padding:2px 0">${s.record.status} · ${s.record.reason || ''}</div>`).join("");
      const clearedCell = entry.statuses.map(s => `<div style="padding:2px 0">${s.record.endDate || ''}</div>`).join("");
      return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer"><td class="mono" style="font-weight:700;color:var(--accent);vertical-align:top">${displayId(r.id)}</td><td style="text-align:left;vertical-align:top">${displayPersonLabel(r.id)}</td><td style="text-align:left;vertical-align:top">${tagsCell}</td><td style="text-align:left;font-size:11px;color:var(--muted);vertical-align:top">${originalCell}</td><td style="text-align:left;font-size:11px;color:var(--muted);vertical-align:top">${clearedCell}</td></tr>`;
    }).join("")}
    </tbody></table></div>` : ""}
    ${renderDashMSKCases(visible)}
    ${renderDashLeaveOut(visible, today)}`;

  // Status Breakdown chart: tally every active status (a recruit on MC +
  // Excuse contributes once to each slice). The "Active" slice is per-recruit
  // so it adds up to roster size only when nobody has stacked statuses.
  const statusCounts = { Active: active };
  effectiveAll.forEach(e => e.statuses.forEach(s => { statusCounts[s.tag] = (statusCounts[s.tag] || 0) + 1; }));
  const chartColor = label => {
    if (label === "Active") return "#3FB950";
    if (label === "MC" || label === "Warded") return "#F85149";
    if (label === "LD" || label === "MC+1") return "#D29922";
    if (label === "LD+1" || label === "MC+2") return "#E3B341";
    if (label === "RMJ" || (typeof label === "string" && label.startsWith("Excuse"))) return "#58A6FF";
    return "#8B949E";
  };
  STATE.charts.status = new Chart(document.getElementById("chart-status"), {
    type: "doughnut",
    data: { labels: Object.keys(statusCounts), datasets: [{ data: Object.values(statusCounts), backgroundColor: Object.keys(statusCounts).map(chartColor) }] },
    options: { plugins: { legend: { position: "right", labels: { color: "#8B949E", font: { size: 11 } } } } }
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
  const rateColorHex = r => r >= 95 ? "#3FB950" : r >= 70 ? "#D29922" : "#F85149";
  const partColors = partData.map(rateColorHex);
  STATE.charts.participation = new Chart(document.getElementById("chart-participation"), {
    type: "line",
    data: { labels: partRows.map(a => conductName(a.conductId).slice(0, 12)), datasets: [{
      data: partData,
      borderColor: "#8B949E",
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
    options: { plugins: { legend: { display: false } }, scales: { y: { grace: "10%", grid: { color: "#30363D" }, ticks: { color: "#8B949E" } }, x: { grid: { display: false }, ticks: { color: "#8B949E", font: { size: 9 } } } } }
  });
}

// Active MSK Cases — recruits who self-reported an injury via the Google
// Form ("Cougar MSK / Physio Log"). One card per recruit, aggregating
// their initial injury text, any physio appointment we have on file, and
// the timeline of exercises they've logged. Cleared cases are hidden by
// default behind a toggle.
function renderDashMSKCases(visible) {
  const scoped = STATE.msk.filter(m => passesFilter(m.d4, visible));
  if (!scoped.length) return "";

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
      <button class="btn btn-icon" onclick="event.stopPropagation(); openMSKRegionMenu('${c.d4}')" title="Re-tag body regions" style="font-size:9px;padding:1px 6px">✎ tag</button>
    </div>` : "";

    const exercises = c.orderedExercises.length
      ? `<div style="margin-top:6px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Physio visits (${c.orderedExercises.length})</div>${c.orderedExercises.map(e => {
          const d = e.physioDate || e.timestamp || "";
          const exText = e.exercises ? ` — ${e.exercises}` : ` <span style="color:var(--dim)">(no new exercises)</span>`;
          return `<div style="font-size:11px;padding:4px 6px;background:var(--bg);border-left:2px solid var(--teal);margin-bottom:3px"><span class="mono" style="color:var(--muted);font-size:10px">${d}</span>${exText}</div>`;
        }).join("")}</div>`
      : `<div style="font-size:11px;color:var(--dim);margin-top:6px">No physio visits logged yet.</div>`;

    return `<div class="card" style="padding:12px;${faded ? 'opacity:.55;' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px">
        <div onclick="openPerson('${c.d4}')" style="cursor:pointer;font-weight:700">${displayId(c.d4) ? `<span class="mono" style="color:var(--accent);margin-right:6px">${displayId(c.d4)}</span>` : ""}${displayPersonLabel(c.d4)} <span class="badge badge-pink" style="font-size:9px;margin-left:4px">🦵 MSK</span></div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn" style="font-size:10px;padding:3px 8px" onclick="openAppointmentForm(null, {d4:'${c.d4}', reason:'Physio review', location:'Physio Centre'})" title="Book a physio appointment for this recruit">📅 Book</button>
          <button class="btn ${c.allCleared ? 'btn-success' : ''}" style="font-size:10px;padding:3px 8px" onclick="toggleMSKCleared('${c.d4}')" title="${c.allCleared ? 'Reopen this case' : 'Mark this case cleared (hides from active list)'}">${c.allCleared ? '↺ Reopen' : '✓ Mark Cleared'}</button>
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
  const activeCards = active.length
    ? `<div style="max-height:560px;overflow-y:auto;padding-right:6px;border:1px solid var(--border);border-radius:8px;background:var(--surface)"><div style="display:flex;flex-direction:column;gap:10px;padding:10px">${active.map(c => renderCard(c, false)).join("")}</div></div>`
    : `<div class="empty-state" style="padding:12px;font-size:11px">No active MSK cases.</div>`;

  const clearedSection = cleared.length
    ? `<div style="margin-top:12px"><button class="btn" style="font-size:11px" onclick="toggleMSKShowCleared()">${_mskShowCleared ? "▾ Hide" : "▸ Show"} cleared (${cleared.length})</button>${_mskShowCleared ? `<div style="max-height:400px;overflow-y:auto;padding-right:6px;margin-top:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface)"><div style="display:flex;flex-direction:column;gap:10px;padding:10px">${cleared.map(c => renderCard(c, true)).join("")}</div></div>` : ""}</div>`
    : "";

  return `<h3 style="font-size:13px;color:var(--muted);margin:16px 0 8px">🦵 Active MSK Cases <span style="color:var(--dim);font-weight:400">(${active.length}${cleared.length ? ` active · ${cleared.length} cleared` : ""}) <span style="font-size:10px;font-style:italic;color:var(--dim)">— scroll to see all</span></span></h3>
    ${activeCards}
    ${clearedSection}`;
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
      ...reports.map(r => ({ kind: "Form report", text: r.description || "—", color: "#E97BC2" })),
      ...cdRows.map(c => ({ kind: c.type, text: c.reason || "—", color: c.type === "PX" ? "#5B8DEF" : c.type === "Fallout" ? "#E8573A" : "#F2A93B" }))
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
        <span style="color:#5B8DEF;font-weight:600">■ Status</span> = pre-existing medical/excuse status before the conduct ·
        <span style="color:#E8573A;font-weight:600">■ Fallout</span> = dropped out during the conduct ·
        <span style="color:#F2A93B;font-weight:600">■ RSI</span> = reported sick at first parade
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

    // Shared axis styling — softer grid, no borders, integer ticks.
    const axisBase = {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 6, right: 4, bottom: 0, left: 0 } },
      plugins: {
        legend: { labels: { color: "#8B949E", font: { size: 11 }, padding: 12, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: { backgroundColor: "#161B22", borderColor: "#30363D", borderWidth: 1, padding: 10, titleColor: "#E6EDF3", bodyColor: "#E6EDF3", cornerRadius: 6, displayColors: true }
      },
      scales: {
        y: { beginAtZero: true, ticks: { color: "#8B949E", font: { size: 10 }, precision: 0, padding: 6 }, grid: { color: "#30363D55", drawTicks: false }, border: { display: false } },
        x: { ticks: { color: "#8B949E", font: { size: 10 }, maxRotation: 0, autoSkip: true, padding: 4 }, grid: { display: false }, border: { display: false } }
      }
    };

    // Stacked bar — bigger rounded corners on the top of each stack, no
    // borders. Tooltip shows the per-day breakdown + total.
    _mskAnalyticsCharts.daily = new Chart(document.getElementById("msk-daily-bar"), {
      type: "bar",
      data: { labels: dateLabels, datasets: [
        { label: "Status",        data: daily.map(d => d.px),  backgroundColor: "#5B8DEF", stack: "a", borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.85 },
        { label: "Fallout",       data: daily.map(d => d.fo),  backgroundColor: "#E8573A", stack: "a", borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.85 },
        { label: "RSI",           data: daily.map(d => d.rsi), backgroundColor: "#F2A93B", stack: "a", borderWidth: 0, borderRadius: 4, borderSkipped: false, categoryPercentage: 0.7, barPercentage: 0.85 }
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
      data: { labels: dateLabels, datasets: [{ label: "Total affected", data: daily.map(d => d.total), borderColor: "#43C59E", backgroundColor: "#43C59E33", tension: 0.35, fill: true, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: "#43C59E", pointBorderColor: "#0D1117", pointBorderWidth: 2, borderWidth: 2.5 }] },
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
        data: { labels: regionCounts.map(r => r.region), datasets: [{ data: regionCounts.map(r => r.count), backgroundColor: regionCounts.map(r => MSK_REGION_COLORS[r.region] || MSK_REGION_COLORS.Other), borderWidth: 3, borderColor: "#161B22", hoverOffset: 8 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: "62%",
          onClick: drillOnClick, onHover: cursorOnHover,
          plugins: {
            legend: { position: isMobile ? "bottom" : "right", labels: { color: "#E6EDF3", font: { size: 11 }, padding: 10, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
            tooltip: { backgroundColor: "#161B22", borderColor: "#30363D", borderWidth: 1, padding: 10, cornerRadius: 6, callbacks: { label: c => `${c.label}: ${c.parsed} recruit${c.parsed === 1 ? "" : "s"} (click to drill in)` } }
          }
        }
      });

      // Horizontal bar — rounded right side, bigger bars, value labels via tooltip.
      _mskAnalyticsCharts.regionBar = new Chart(document.getElementById("msk-region-bar"), {
        type: "bar",
        data: { labels: regionCounts.map(r => r.region), datasets: [{ data: regionCounts.map(r => r.count), backgroundColor: regionCounts.map(r => MSK_REGION_COLORS[r.region] || MSK_REGION_COLORS.Other), borderWidth: 0, borderRadius: 6, borderSkipped: false, barPercentage: 0.7 }] },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: "y",
          layout: { padding: { top: 4, right: 16, bottom: 0, left: 0 } },
          onClick: drillOnClick, onHover: cursorOnHover,
          plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: "#161B22", borderColor: "#30363D", borderWidth: 1, padding: 10, cornerRadius: 6, displayColors: false, callbacks: { label: c => `${c.parsed.x} recruit${c.parsed.x === 1 ? "" : "s"} (click to drill in)` } }
          },
          scales: {
            x: { beginAtZero: true, ticks: { color: "#8B949E", font: { size: 10 }, precision: 0, padding: 4 }, grid: { color: "#30363D55", drawTicks: false }, border: { display: false } },
            y: { ticks: { color: "#E6EDF3", font: { size: 11, weight: "600" }, padding: 6 }, grid: { display: false }, border: { display: false } }
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
function renderDashLeaveOut(visible, todayIso) {
  const sevenDaysOut = (() => {
    const d = new Date(todayIso); d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const scoped = STATE.leave
    .filter(l => passesFilter(l.d4, visible))
    .map(l => ({ ...l, startIso: displayDateToISO(l.startDate) || "", endIso: displayDateToISO(l.endDate) || "" }))
    .filter(l => l.startIso && l.endIso);

  const onToday = scoped.filter(l => l.startIso <= todayIso && todayIso <= l.endIso);
  const upcoming = scoped.filter(l => l.startIso > todayIso && l.startIso <= sevenDaysOut);

  const typeColor = t => t === "Off-in-Lieu" ? "accent" : t === "Annual Leave" ? "teal" : t === "Compassionate" ? "red" : t === "Weekend" ? "green" : t === "Night's Out" ? "pink" : t === "Course" ? "purple" : t === "Guard Duty" ? "orange" : t === "NDP" ? "yellow" : "muted";

  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 8px">
    <h3 style="font-size:13px;color:var(--muted);margin:0">🪖 Out today / This week <span style="color:var(--dim);font-weight:400">(${onToday.length} now · ${upcoming.length} upcoming)</span></h3>
    <button class="btn btn-primary" style="font-size:11px;padding:4px 10px" onclick="openLeaveForm()">+ Log</button>
  </div>`;

  if (!onToday.length && !upcoming.length) {
    return header + `<div class="empty-state" style="padding:12px;font-size:11px;margin-bottom:12px">No commanders out today or in the next 7 days.</div>`;
  }

  const row = l => `<tr onclick="openPerson('${l.d4}')" style="cursor:pointer">
    <td style="text-align:left;font-weight:600">${displayPersonLabel(l.d4)}</td>
    <td>${badge(l.type, typeColor(l.type))}</td>
    <td style="white-space:nowrap;font-size:11px;color:var(--muted)">${l.startDate}${l.startIso !== l.endIso ? ` → ${l.endDate}` : ""}</td>
    <td style="text-align:left;font-size:11px;color:var(--muted)">${l.reason || ""}</td>
    <td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openLeaveForm(${l.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('leave', ${l.id}, 'leave record')" title="Delete">✕</button></td>
  </tr>`;

  return header + `<div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th style="text-align:left">Name</th><th>Type</th><th>Dates</th><th style="text-align:left">Reason</th><th></th></tr></thead><tbody>
    ${onToday.map(row).join("")}
    ${upcoming.length ? `<tr><td colspan="5" style="padding:6px 8px;font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;background:var(--surface2)">Upcoming this week</td></tr>` : ""}
    ${upcoming.map(row).join("")}
  </tbody></table></div>`;
}

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

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="font-size:18px;font-weight:700">📅 Leave / Out${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('Leave',STATE.leave)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openLeaveForm()">+ Log</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><label>Total entries</label><div class="val">${scoped.length}</div></div>
      <div class="stat"><label>Out today</label><div class="val" style="color:var(--orange)">${onTodayCount}</div></div>
    </div>
    ${renderLeaveTimeline(scoped, today)}
    ${rows.length ? `<h3 style="font-size:13px;color:var(--muted);margin:16px 0 8px">All entries</h3><div class="table-wrap"><table><thead><tr><th style="text-align:left">Name</th><th>Type</th><th>Start</th><th>End</th><th>Days</th><th style="text-align:left">Reason</th><th></th></tr></thead><tbody>
    ${rows.map(l => `<tr onclick="openPerson('${l.d4}')" style="cursor:pointer"><td style="text-align:left;font-weight:600">${displayPersonLabel(l.d4)}</td><td>${badge(l.type, typeColor(l.type))}</td><td>${l.startDate || ""}</td><td>${l.endDate || ""}</td><td class="mono" style="font-weight:700">${l.days || ""}</td><td style="text-align:left;font-size:11px;color:var(--muted);max-width:240px;white-space:normal">${l.reason || ""}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openLeaveForm(${l.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('leave', ${l.id}, 'leave record')" title="Delete">✕</button></td></tr>`).join("")}
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
    "Off-in-Lieu": "#58A6FF", "Annual Leave": "#39D2C0", "Compassionate": "#F85149", "Weekend": "#3FB950", "Night's Out": "#F778BA",
    "Course": "#BC8CFF", "Guard Duty": "#D29922", "NDP": "#E3B341", "Other": "#8B949E"
  })[t] || "#8B949E";

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
      const todayMark = isToday ? "background:#F8514922;" : "";
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

// "Currently Out of Camp" panel — everyone counted out today (the same shared
// set that drives the strength tiles + parade). Booked-out rows get a one-tap
// Book In; medical/leave rows are managed by their own records. A "+ Book Out"
// button opens the ad-hoc picker.
function renderDashOutOfCamp(scoped, outMap) {
  const rows = scoped.filter(r => outMap.has(r.id));
  const color = { medical: "#F85149", leave: "#BC8CFF", bookedout: "#D29922" };
  const label = { medical: "Medical", leave: "Leave", bookedout: "Booked out" };
  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 8px">
    <h3 style="font-size:13px;color:var(--muted);margin:0">🚪 Currently Out of Camp <span style="color:var(--dim);font-weight:400">(${rows.length})</span></h3>
    <button class="btn btn-primary" style="font-size:11px;padding:4px 10px" onclick="openBookOutPicker()">+ Book Out</button>
  </div>`;
  if (!rows.length) return header + `<div class="empty-state" style="padding:12px;font-size:11px;margin-bottom:12px">Everyone in scope is in camp.</div>`;
  const body = rows.map(r => {
    const info = outMap.get(r.id);
    const c = color[info.kind] || "#8B949E";
    return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer">
      <td class="mono" style="font-weight:700;color:var(--accent)">${displayId(r.id)}</td>
      <td style="text-align:left">${displayPersonLabel(r.id)}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${c}22;color:${c}">${label[info.kind] || info.kind}</span></td>
      <td style="text-align:left;font-size:11px;color:var(--muted)">${escapeAttr(info.reason || "")}</td>
      <td style="white-space:nowrap">${info.kind === "bookedout"
        ? `<button class="btn btn-icon btn-success" style="font-size:10px;padding:3px 8px" onclick="event.stopPropagation(); bookOutToggle('${r.id}', false)" title="Book back in">↩ Book In</button>`
        : `<span style="font-size:10px;color:var(--dim)">via ${info.kind}</span>`}</td>
    </tr>`;
  }).join("");
  return header + `<div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th>Why</th><th style="text-align:left">Detail</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDashAppointments(visible, todayIso) {
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

  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 8px">
    <h3 style="font-size:13px;color:var(--muted);margin:0">📅 Upcoming Appointments <span style="color:var(--dim);font-weight:400">(${upcoming.length})</span></h3>
    <button class="btn btn-primary" style="font-size:11px;padding:4px 10px" onclick="openAppointmentForm()">+ Book</button>
  </div>`;

  if (!upcoming.length) {
    return header + `<div class="empty-state" style="padding:12px;font-size:11px;margin-bottom:12px">No upcoming appointments.</div>`;
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
        ? `<button class="btn btn-icon btn-success" style="font-size:10px;padding:3px 7px" onclick="event.stopPropagation(); bookOutToggle('${a.d4}', false)" title="Book back in">↩ In</button> `
        : `<button class="btn btn-icon btn-danger" style="font-size:10px;padding:3px 7px" onclick="event.stopPropagation(); bookOutToggle('${a.d4}', true, ${JSON.stringify('Appt: ' + (a.reason || 'appointment'))})" title="Book out of camp">🚪 Out</button> `)
      : "";
    return `<tr onclick="openPerson('${a.d4}')" style="cursor:pointer${isToday ? ';background:#F8514911' : ''}">
      <td class="mono" style="font-weight:700;color:var(--accent)">${displayId(a.d4)}</td>
      <td style="text-align:left">${displayPersonLabel(a.d4)}</td>
      <td style="text-align:left">${a.reason || ""}</td>
      <td style="white-space:nowrap">${a.date || ""} ${dayLabel}</td>
      <td class="mono" style="white-space:nowrap">${fmtHrs(a.time)}</td>
      <td style="text-align:left;font-size:11px;color:var(--muted)">${a.location || ""}${a.outOfCamp ? ` <span class="badge badge-pink" style="font-size:9px">${bookedOut ? "OUT NOW" : "OUTSIDE"}</span>` : ""}</td>
      <td style="white-space:nowrap">${bookBtn}<button class="btn btn-icon" style="color:var(--green)" onclick="event.stopPropagation(); toggleAppointmentResolved(${a.id})" title="Mark as resolved (hides from dashboard + parade state)">✓</button> <button class="btn btn-icon" onclick="event.stopPropagation(); openAppointmentForm(${a.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('appointments', ${a.id}, 'appointment')" title="Delete">✕</button></td>
    </tr>`;
  }).join("");

  return header + `<div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Reason</th><th>Date</th><th>Time</th><th style="text-align:left">Location</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDashProfileCards(scoped) {
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

  return `<div class="grid-2">
    <div class="card"><h3>Ration Breakdown</h3>
      ${rationRows.length ? `<div style="display:flex;flex-direction:column;gap:6px">
        ${rationRows.map(([k, n]) => `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px"><span style="color:${rationColor(k)};font-weight:600">${k}</span><span class="mono" style="color:var(--muted)">${n} (${pct(n, scoped.length)}%)</span></div>`).join("")}
      </div>` : `<div style="color:var(--muted);font-size:12px">No ration data</div>`}
    </div>
    <div class="card"><h3>Allergies <span style="color:var(--muted);font-weight:400;font-size:11px">(${allergic.length} recruit${allergic.length === 1 ? '' : 's'})</span></h3>
      ${allergic.length ? `
        ${allergenRows.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${allergenRows.map(([a, n]) => `<span class="badge badge-yellow">${a} · ${n}</span>`).join("")}</div>` : ""}
        <div style="display:flex;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto">
          ${allergic.map(r => `<div onclick="openPerson('${r.id}')" style="cursor:pointer;font-size:11px;padding:4px 6px;border-radius:4px;background:var(--surface2);display:flex;justify-content:space-between;gap:8px"><span><span class="mono" style="color:var(--accent);font-weight:700">${r.id}</span> ${r.name}</span><span style="color:var(--yellow);text-align:right">${r.allergies}</span></div>`).join("")}
        </div>
      ` : `<div style="color:var(--muted);font-size:12px">No recruits with allergies recorded</div>`}
    </div>
  </div>`;
}

function renderRoster(el) {
  const rsiCount = {};
  STATE.medical.forEach(m => { rsiCount[m.d4] = (rsiCount[m.d4] || 0) + 1; });
  const scoped = filteredRoster();
  const rosterToday = todayISO();
  // Camp column reads the SHARED out-of-camp definition (outOfCampMap) so it can
  // never disagree with the dashboard / parade strength — medical and leave count
  // as out here, not just manual book-outs. Colours/labels mirror the dashboard
  // "Currently Out of Camp" panel.
  const campOutMap = outOfCampMap(rosterToday);
  const CAMP_COLOR = { medical: "#F85149", leave: "#BC8CFF", bookedout: "#D29922" };
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
      // CAMP cell = effective status (why they're out, or "In camp") + a book
      // out/in lever that ALWAYS offers the opposite of their current state.
      // Out (any reason) → Book in, which counts them present for today (an MC/
      // leave recruit becomes a manual "In camp"); in camp → Book out. The badge
      // reads outOfCampMap, so it can never disagree with the dashboard.
      const outInfo = campOutMap.get(r.id);
      const forcedIn = !outInfo && isForcedIn(r, rosterToday) && derivedCampOut(r.id, rosterToday);
      const campBadge = outInfo
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${CAMP_COLOR[outInfo.kind] || "#8B949E"}22;color:${CAMP_COLOR[outInfo.kind] || "#8B949E"}" title="Out of camp — ${escapeAttr(outInfo.reason || "")}">Out · ${CAMP_WHY[outInfo.kind] || outInfo.kind}</span>`
        : forcedIn
          ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#39D2C022;color:var(--teal)" title="Manually kept in camp today — would be out: ${escapeAttr(forcedIn.reason || "")}. Resets tomorrow.">In camp · manual</span>`
          : `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#3FB95018;color:var(--green)">In camp</span>`;
      const campToggle = outInfo
        ? `<button class="btn btn-icon btn-success" style="font-size:10px;padding:2px 7px" onclick="event.stopPropagation(); bookOutToggle('${r.id}', false)" title="Book in — count as in camp today (resets tomorrow)">↩ Book in</button>`
        : `<button class="btn btn-icon" style="font-size:10px;padding:2px 7px" onclick="event.stopPropagation(); bookOutToggle('${r.id}', true, 'Out of camp')" title="Book out of camp (controls in-camp strength)">🚪 Book out</button>`;
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
        <button class="btn" onclick="refreshLmsFromPolar()" title="Recount LMS participants for every conduct from STATE.polar (the Polar class summary photo is the LMS roster) and write into the attendance rows">🔄 Recompute LMS</button>
        <button class="btn btn-success" onclick="pushTab('Attendance',STATE.attendance)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openLogConductWizard()" title="One-shot wizard: date + time + conduct + Status Personnel checklist + bulk Report Sick / Fallout / RSI rows + auto totals + chat-format copy">+ Log Conduct</button>
      </div>
    </div>
    ${STATE.attendance.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Conduct</th><th>Program</th><th>Total</th><th>Part.</th><th>LMS</th><th>Status</th><th>Fallout</th><th>Rate</th><th>LMS Rate</th><th style="text-align:left">Remarks</th><th></th></tr></thead><tbody>
    ${[...STATE.attendance].filter(a => !STATE.filterProgram || progKey(a) === STATE.filterProgram).sort((a, b) => {
      // Newest first by date, then time (later in the day on top within a date).
      const ai = displayDateToISO(a.date) || a.date || "";
      const bi = displayDateToISO(b.date) || b.date || "";
      if (ai !== bi) return ai < bi ? 1 : -1;
      return (a.time || "") < (b.time || "") ? 1 : -1;
    }).map(a => {
      const r = pct(a.participating, a.total);
      const lms = +a.lms || 0;
      const lmsRate = pct(lms, a.participating);
      const rateColor = r >= 95 ? 'var(--green)' : r >= 70 ? 'var(--orange)' : 'var(--red)';
      const lmsRateColor = a.participating ? (lmsRate >= 95 ? 'var(--green)' : lmsRate >= 70 ? 'var(--orange)' : 'var(--red)') : 'var(--muted)';
      const time = fmtHrs(a.time) || '—';
      return `<tr><td>${a.date}</td><td class="mono" style="color:${a.time ? 'var(--text)' : 'var(--dim)'}">${time}</td><td style="text-align:left">${conductName(a.conductId)}</td><td>${programBadge(progKey(a))}</td><td>${a.total}</td><td>${a.participating}</td><td style="color:${lms > 0 ? 'var(--accent)' : 'var(--muted)'}">${lms}</td><td style="color:${a.px > 0 ? 'var(--orange)' : 'var(--muted)'}">${a.px}</td><td style="color:${a.fallout > 0 ? 'var(--red)' : 'var(--muted)'}">${a.fallout}</td><td style="font-weight:700;color:${rateColor}">${r}%</td><td style="font-weight:700;color:${lmsRateColor}">${a.participating ? lmsRate + '%' : '—'}</td><td style="text-align:left;color:${a.remarks ? 'var(--yellow)' : 'var(--muted)'};max-width:200px;white-space:normal;font-size:11px">${a.remarks || ''}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="copyConductChatFormat(${a.id})" title="Copy WhatsApp-format parade state message">📋</button> <button class="btn btn-icon" onclick="openLogConductWizard(${a.id})" title="Edit conduct (wizard)">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('attendance', ${a.id}, 'attendance entry')" title="Delete">✕</button></td></tr>`;
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
  const conductRecords = scopedAll.filter(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${progKey(d)}` === _detailFilterConduct);
  const absentSet = new Set(conductRecords.map(d => d.d4));
  // Participants = the session's program roster minus absentees (the detail rows
  // enumerate absentees, so the inverse gives participants for free). Scope to
  // the session's program so a PTP conduct doesn't count BMT recruits present.
  const sessionProgram = _detailFilterConduct.split("|")[3] || "Combined";
  const visible = visibleD4Set();
  const inScope = recruitsInProgram(sessionProgram).filter(r => passesFilter(r.id, visible));
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
  if (_detailFilterConduct) scoped = scoped.filter(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${progKey(d)}` === _detailFilterConduct);
  if (_detailFilterType) scoped = scoped.filter(d => d.type === _detailFilterType);

  // Unique conduct keys for the dropdown — newest first by parsed date. Program
  // is part of the key so PTP/BMT sessions of the same conduct list separately.
  const conductKeys = [...new Set(scopedAll.map(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${progKey(d)}`))]
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
    const k = `${d.date}|${d.time || ""}|${d.conductId || ""}|${progKey(d)}`;
    (missed[d.d4] = missed[d.d4] || new Set()).add(k);
  });
  const topMissed = Object.entries(missed)
    .map(([d4, set]) => ({ d4, count: set.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const typeBadgeColor = t => t === "PX" ? "orange" : t === "RSI" ? "red" : t === "Fallout" ? "purple" : "yellow";
  const totalConducts = [...new Set(scopedAll.map(d => `${d.date}|${d.time || ""}|${d.conductId || ""}|${progKey(d)}`))].length;
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
        ${conductKeys.map(k => { const [dt, tm, cid, prog] = k.split("|"); return `<option value="${escapeAttr(k)}" ${k === _detailFilterConduct ? "selected" : ""}>${dt}${tm ? " " + fmtHrs(tm) : ""} — ${conductName(cid) || "(unknown)"} (${programLabel(prog)})</option>`; }).join("")}
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
        ${rows.map(d => `<tr onclick="openPerson('${d.d4}')" style="cursor:pointer"><td>${d.date || ""}</td><td class="mono">${fmtHrs(d.time) || "—"}</td><td style="text-align:left">${conductName(d.conductId)}</td><td>${programBadge(progKey(d))}</td><td class="mono" style="font-weight:700;color:var(--accent)">${d.d4}</td><td style="text-align:left">${getName(d.d4)}</td><td>${badge(d.type, typeBadgeColor(d.type))}</td><td style="text-align:left;max-width:280px;white-space:normal;font-size:11px">${d.reason || ""}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openConductDetailForm(${d.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('conductDetail', ${d.id}, 'conduct detail record')" title="Delete">✕</button></td></tr>`).join("")}
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
        ${rowsWithTag.map(({ m, tagInfo }) => { const noDur = m.status === "Pending" || m.status === "NIL"; return `<tr onclick="openPerson('${m.d4}')" style="cursor:pointer"><td>${m.date || ""}</td><td class="mono" style="font-weight:700;color:var(--accent)">${displayId(m.d4)}</td><td style="text-align:left">${displayPersonLabel(m.d4)}</td><td style="text-align:left">${m.reason || ""}${m.location ? `<div style="font-size:10px;color:var(--muted)">📍 ${escapeAttr(m.location)}</div>` : ""}</td><td>${m.status ? medTagBadge(m.status) : '<span style="color:var(--muted)">—</span>'}</td><td>${m.startDate || (noDur ? '<span style="color:var(--muted)">—</span>' : "")}</td><td>${m.endDate || (noDur ? '<span style="color:var(--muted)">—</span>' : "")}</td><td>${tagInfo ? medTagBadge(tagInfo.tag) : '<span style="color:var(--dim)">cleared</span>'}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openMedicalForm(${m.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('medical', ${m.id}, 'medical record')" title="Delete">✕</button></td></tr>`; }).join("")}
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
    ${attemptScoped.map(i => `<tr><td class="mono" style="font-weight:700">${displayId(i.d4)}</td><td style="text-align:left">${displayPersonLabel(i.d4)}</td><td>${i.attempt}</td><td>${i.date}</td><td>${i.pushups}</td><td>${i.situps}</td><td>${i.runTime}</td><td style="font-weight:700;font-size:15px">${isYTT(i) ? '<span style="color:var(--muted)">—</span>' : i.score}</td><td>${ipptAwardBadge(i)}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="openIPPTForm(${i.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="deleteEntry('ippt', ${i.id}, 'IPPT entry')" title="Delete">✕</button></td></tr>`).join("")}
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
  const tiers = [
    { key: "Fail",   color: "#F85149" },
    { key: "Pass",   color: "#3FB950" },
    { key: "Silver", color: "#58A6FF" },
    { key: "Gold",   color: "#E3B341" },
    { key: "Gold★",  color: "#BC8CFF" }
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
        borderColor: "#161B22",
        borderWidth: 1
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: "#8B949E", font: { size: 12 }, usePointStyle: true } },
        tooltip: { titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10, callbacks: {
          label: ctx => `${ctx.dataset.label}: ${ctx.dataset.counts[ctx.dataIndex]} (${ctx.parsed.y}%)`
        } }
      },
      scales: {
        y: { stacked: true, min: 0, max: 100, title: { display: true, text: "% of takers", color: "#8B949E" }, grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 12 }, callback: v => v + "%" } },
        x: { stacked: true, grid: { display: false }, ticks: { color: "#8B949E", font: { size: 14 } } }
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
  const lineColor = r => { const d = ipptNetDelta(r); return d > 0 ? "#3FB95066" : d < 0 ? "#F8514966" : "#8B949E55"; };
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
          borderColor: "#58A6FF",
          backgroundColor: "#58A6FF",
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
        y: { title: { display: true, text: "Score", color: "#8B949E", font: { size: 13 } }, grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 12 } } },
        x: { grid: { display: false }, ticks: { color: "#8B949E", font: { size: 14 } } }
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
          pointBackgroundColor: paired.map(p => p.delta > 0 ? "#3FB950" : p.delta < 0 ? "#F85149" : "#8B949E"),
          pointBorderColor: "transparent",
          pointRadius: 6,
          pointHoverRadius: 9
        },
        {
          label: "No change (y=x)",
          type: "line",
          data: [{ x: lo, y: lo }, { x: hi, y: hi }],
          borderColor: "#8B949E",
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
        x: { min: lo, max: hi, title: { display: true, text: `IPPT ${cmpA} score`, color: "#8B949E", font: { size: 13 } }, grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 12 } } },
        y: { min: lo, max: hi, title: { display: true, text: `IPPT ${cmpB} score`, color: "#8B949E", font: { size: 13 } }, grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 12 } } }
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
  STATE.charts.ipptTrend = new Chart(canvas, {
    type: "line",
    data: {
      labels: trend.map(r => "IPPT " + r.n),
      datasets: [
        { label: "Avg Push-ups", data: trend.map(r => r.pushups), borderColor: "#58A6FF", backgroundColor: "#58A6FF", yAxisID: "reps", borderWidth: 3, tension: 0.3, pointRadius: 6, pointHoverRadius: 8, spanGaps: true },
        { label: "Avg Sit-ups", data: trend.map(r => r.situps), borderColor: "#3FB950", backgroundColor: "#3FB950", yAxisID: "reps", borderWidth: 3, tension: 0.3, pointRadius: 6, pointHoverRadius: 8, spanGaps: true },
        { label: "Avg 2.4km", data: trend.map(r => r.runSec), borderColor: "#F2A93B", backgroundColor: "#F2A93B", yAxisID: "run", borderWidth: 3, tension: 0.3, pointRadius: 6, pointHoverRadius: 8, spanGaps: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { color: "#8B949E", font: { size: 13 }, padding: 16, usePointStyle: true } },
        tooltip: { titleFont: { size: 13 }, bodyFont: { size: 13 }, padding: 10, callbacks: { label: ctx => ctx.dataset.yAxisID === "run"
          ? `${ctx.dataset.label}: ${formatSeconds(ctx.parsed.y)}`
          : `${ctx.dataset.label}: ${ctx.parsed.y}` } }
      },
      scales: {
        reps: { type: "linear", position: "left", beginAtZero: false, title: { display: true, text: "Reps", color: "#8B949E", font: { size: 13 } }, grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 12 } } },
        // Reversed so a FASTER time (fewer seconds) sits HIGHER — now an upward
        // run line means improvement, matching the rep lines.
        run: { type: "linear", position: "right", reverse: true, title: { display: true, text: "2.4km (faster ↑)", color: "#8B949E", font: { size: 13 } }, grid: { drawOnChartArea: false }, ticks: { color: "#8B949E", font: { size: 12 }, callback: v => formatSeconds(v) } },
        x: { grid: { display: false }, ticks: { color: "#8B949E", font: { size: 14 } } }
      }
    }
  });
}

function buildIPPTAwardsChart(stats) {
  const canvas = document.getElementById("chart-ippt-awards");
  if (!canvas || typeof Chart === "undefined") return;
  // Order high → low so the legend reads top-to-bottom intuitively.
  // Only include non-zero slices so the chart isn't cluttered with empty tiers.
  const labels = [], data = [], colors = [];
  if (stats.goldStar) { labels.push("Gold★"); data.push(stats.goldStar); colors.push("#BC8CFF"); }
  if (stats.gold)     { labels.push("Gold");   data.push(stats.gold);     colors.push("#E3B341"); }
  if (stats.silver)   { labels.push("Silver"); data.push(stats.silver);   colors.push("#58A6FF"); }
  if (stats.pass)     { labels.push("Pass");   data.push(stats.pass);     colors.push("#3FB950"); }
  if (stats.fail)     { labels.push("Fail");   data.push(stats.fail);     colors.push("#F85149"); }
  if (stats.ytt)      { labels.push("YTT");    data.push(stats.ytt);      colors.push("#484F58"); }
  if (!data.length) return;

  STATE.charts.ipptAwards = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: "#161B22", borderWidth: 2 }] },
    options: { plugins: { legend: { position: "right", labels: { color: "#8B949E", font: { size: 11 } } } } }
  });
}

function buildIPPTDistributionChart(buckets) {
  const canvas = document.getElementById("chart-ippt-distribution");
  if (!canvas || typeof Chart === "undefined") return;
  // buckets: [YTT, Fail 0–60, Pass 61–74, Silver 75–84, Gold 85–89, Gold★ 90+]
  STATE.charts.ipptDistribution = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["YTT", "Fail", "Pass", "Silver", "Gold", "Gold★"],
      datasets: [{
        data: buckets,
        backgroundColor: ["#484F58", "#F85149", "#3FB950", "#58A6FF", "#E3B341", "#BC8CFF"],
        borderWidth: 0,
        borderRadius: 4
      }]
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: "#30363D" }, ticks: { color: "#8B949E", stepSize: 1 } },
        x: { grid: { display: false }, ticks: { color: "#8B949E", font: { size: 10 } } }
      }
    }
  });
}

function renderRM(el) {
  const visible = visibleD4Set();
  const scoped = STATE.rm.filter(r => passesFilter(r.d4, visible));
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Route March Tracker${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.rm.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <label class="btn" style="cursor:pointer">Import CSV<input type="file" accept=".csv" onchange="importRM(this)" style="display:none"></label>
        <button class="btn btn-success" onclick="pushTab('RouteMarch',STATE.rm)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openRMForm()">+ Add</button>
      </div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
    ${[{ n: 1, d: "3KM" }, { n: 2, d: "3KM" }, { n: 3, d: "3KM" }, { n: 4, d: "4KM" }, { n: 5, d: "8KM" }, { n: 6, d: "12KM" }].map(rm => `<div style="flex:1;min-width:90px;background:var(--surface2);border-radius:8px;padding:10px 12px;border:1px solid ${scoped.some(r => r.rmNum == rm.n) ? 'var(--green)' : 'var(--border)'};text-align:center"><div style="font-size:16px;font-weight:700;color:${scoped.some(r => r.rmNum == rm.n) ? 'var(--green)' : 'var(--muted)'}">RM ${rm.n}</div><div style="font-size:10px;color:var(--muted)">${rm.d}</div><div style="font-size:10px;color:var(--dim)">${scoped.filter(r => r.rmNum == rm.n).length} entries</div></div>`).join("")}
    </div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th>Name</th><th>RM</th><th>Date</th><th>Finish Time</th><th>Avg HR</th><th>Max HR</th><th>Pass</th><th></th></tr></thead><tbody>
    ${scoped.map(r => `<tr><td class="mono" style="font-weight:700">${r.d4}</td><td style="text-align:left">${getName(r.d4)}</td><td>${r.rmNum}</td><td>${r.date}</td><td class="mono" style="font-weight:700">${r.time}</td><td>${r.avgHr}</td><td>${r.maxHr}</td><td>${badge(r.pass === "Y" ? "PASS" : "FAIL", r.pass === "Y" ? "green" : "red")}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="openRMForm(${r.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="deleteEntry('rm', ${r.id}, 'route march entry')" title="Delete">✕</button></td></tr>`).join("")}
    </tbody></table></div>` : ""}`;
}

function renderSOC(el) {
  const visible = visibleD4Set();
  const scoped = STATE.soc.filter(s => passesFilter(s.d4, visible));
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">SOC Tracker${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.soc.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('SOC',STATE.soc)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="openSOCForm()">+ Add</button>
      </div>
    </div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th>Name</th><th>SOC#</th><th>Date</th><th>Time</th><th>Avg HR</th><th>Pass</th><th></th></tr></thead><tbody>
    ${scoped.map(s => `<tr><td class="mono">${s.d4}</td><td style="text-align:left">${getName(s.d4)}</td><td>${s.socNum}</td><td>${s.date}</td><td class="mono" style="font-weight:700">${s.time}</td><td>${s.avgHr}</td><td>${badge(s.pass === "Y" ? "PASS" : "FAIL", s.pass === "Y" ? "green" : "red")}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="openSOCForm(${s.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="deleteEntry('soc', ${s.id}, 'SOC entry')" title="Delete">✕</button></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.soc.length ? `No SOC entries in ${filterLabel()}.` : "No SOC data yet."}</div>`}`;
}

function renderPolar(el) {
  const visible = visibleD4Set();
  const scoped = STATE.polar.filter(p => passesFilter(p.d4, visible));
  const totalStagedPhotos = _polarStagedGroups.reduce((s, g) => s + g.photos.length, 0);

  // Group cards — one per conduct, conduct/date/time entered ONCE, then
  // many photos dropped into the same group.
  const groupCards = _polarStagedGroups.map(g => {
    const photos = g.photos.map(p => `
      <div style="position:relative;width:100px;height:60px;border-radius:4px;overflow:hidden;border:1px solid var(--border)">
        <img src="${p.dataUrl}" style="width:100%;height:100%;object-fit:cover">
        <div style="position:absolute;top:2px;left:2px;font-size:9px;color:${p.status === 'done' ? 'var(--green)' : p.status === 'error' ? 'var(--red)' : p.status === 'analyzing' ? 'var(--orange)' : 'var(--muted)'};background:rgba(13,17,23,.85);padding:1px 4px;border-radius:3px;text-transform:uppercase;letter-spacing:.5px">${p.status === 'done' ? `✓ ${p.added || 0}` : p.status === 'error' ? '✕' : p.status === 'analyzing' ? '…' : 'ready'}</div>
        <button class="btn btn-icon btn-danger" onclick="removePolarPhotoFromGroup(${g.id}, ${p.id})" title="Remove" style="position:absolute;top:2px;right:2px;font-size:9px;padding:1px 5px;line-height:1">✕</button>
      </div>
    `).join("");

    const pickerInputId = `polar-group-cid-${g.id}`;
    return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Conduct group · ${g.photos.length} photo${g.photos.length === 1 ? '' : 's'}</div>
        <button class="btn btn-icon btn-danger" onclick="removePolarGroup(${g.id})" title="Remove this group">✕ group</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 130px 90px;gap:6px;margin-bottom:8px">
        <div>${conductPicker({ inputId: pickerInputId, selectedId: g.conductId, onChange: `updatePolarGroup(${g.id}, 'conductId', document.getElementById('${pickerInputId}').value)` })}</div>
        <input type="date" value="${g.date}" onchange="updatePolarGroup(${g.id}, 'date', this.value)" style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px">
        <input type="text" maxlength="4" placeholder="0730" value="${escapeAttr(g.time)}" oninput="updatePolarGroup(${g.id}, 'time', this.value)" style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px" title="Auto-fills from past conducts">
      </div>
      ${g.photos.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${photos}</div>` : ""}
      <label class="btn" style="cursor:pointer;font-size:11px;padding:6px 10px;display:inline-block">+ Add photos to this group<input type="file" accept="image/*" multiple onchange="addPolarPhotosToGroup(${g.id}, this.files); this.value=''" style="display:none"></label>
      <div ondragover="event.preventDefault(); this.style.borderColor='var(--accent)'; this.style.background='#58A6FF11'" ondragleave="this.style.borderColor='var(--border)'; this.style.background='transparent'" ondrop="event.preventDefault(); this.style.borderColor='var(--border)'; this.style.background='transparent'; addPolarPhotosToGroup(${g.id}, event.dataTransfer.files)" style="display:inline-block;margin-left:6px;padding:6px 10px;font-size:11px;color:var(--muted);border:1px dashed var(--border);border-radius:6px">…or drop here</div>
    </div>`;
  }).join("");

  // Per-conduct "Polar attendance gaps" — for each conduct that has any
  // Polar data, show who actually attended (scoped roster − absent) but
  // doesn't appear in Polar for THAT conduct. Surfaces "wore the watch"
  // gaps at the per-class level instead of one global bucket.
  const conductKeys = [...new Set(STATE.polar.filter(p => p.conductId).map(p => `${p.date}|${p.conductId}|${p.time || ""}`))]
    .filter(k => k.split("|")[0] && k.split("|")[1]);
  const scopedRoster = filteredRoster().filter(r => r.role !== "Commander");
  const scopedRosterIds = new Set(scopedRoster.map(r => r.id));
  const conductGaps = conductKeys.map(k => {
    const [date, conductId, time] = k.split("|");
    const polarSet = new Set(STATE.polar.filter(p => p.date === date && p.conductId === conductId).map(p => p.d4));
    const absent = new Set(STATE.conductDetail
      .filter(c => c.date === date && c.conductId === conductId && (c.type === "PX" || c.type === "RSI" || c.type === "Fallout"))
      .map(c => c.d4));
    const expectedAttenders = [...scopedRosterIds].filter(id => !absent.has(id));
    const missing = expectedAttenders.filter(id => !polarSet.has(id));
    return { date, conductId, time, polarCount: polarSet.size, attended: expectedAttenders.length, missing };
  }).filter(g => g.missing.length > 0)
    .sort((a, b) => {
      const ai = displayDateToISO(a.date) || a.date || "";
      const bi = displayDateToISO(b.date) || b.date || "";
      return ai < bi ? 1 : -1;
    });

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <h2 style="font-size:18px;font-weight:700">Polar Flow Data${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.polar.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="btn btn-primary" style="cursor:pointer">Import Polar CSV<input type="file" accept=".csv" onchange="importPolar(this)" style="display:none"></label>
        <button class="btn btn-success" onclick="pushTab('PolarFlow',STATE.polar)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div>
          <h3 style="margin:0">📸 Photo Import <span style="color:var(--dim);font-weight:400;font-size:11px">AI-extract Polar class summary</span></h3>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">Add a conduct group, then drop the Polar summary screenshots for THAT conduct into it. One conduct = many photos.</div>
        </div>
        <button class="btn btn-primary" style="font-size:12px" onclick="addPolarGroup()">+ New conduct group</button>
      </div>
      ${groupCards}
      ${_polarStagedGroups.length === 0 ? `<div style="text-align:center;padding:16px;color:var(--muted);font-size:12px;border:1.5px dashed var(--border);border-radius:8px">Tap <strong>+ New conduct group</strong> to start. Each group holds one conduct's photos.</div>` : ""}
      ${totalStagedPhotos > 0 ? `
        <div id="polar-analyze-progress" style="display:none;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:8px"></div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-success" style="flex:1;min-width:160px" onclick="analyzeAndPushPolarPhotos()">⚡ Analyze & Push ${totalStagedPhotos} photo${totalStagedPhotos === 1 ? '' : 's'} across ${_polarStagedGroups.filter(g => g.photos.length).length} conduct${_polarStagedGroups.filter(g => g.photos.length).length === 1 ? '' : 's'}</button>
          <button class="btn" onclick="_polarStagedGroups = []; render()">Clear all</button>
        </div>` : ""}
    </div>

    ${conductGaps.length ? `<div class="card" style="margin-bottom:14px">
      <h3>👻 Polar Attendance Gaps <span style="color:var(--dim);font-weight:400;font-size:11px">per conduct</span></h3>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Per conduct: recruits who attended (not Status/RSI/Fallout) but don't appear in Polar — chase them up to wear the watch.</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto">
        ${conductGaps.map(g => `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            <div style="font-size:12px;font-weight:600">${g.date}${g.time ? ` <span class="mono" style="color:var(--muted);font-size:11px">${fmtHrs(g.time)}</span>` : ""} · ${conductName(g.conductId)}</div>
            <div style="font-size:11px"><span style="color:var(--green)">${g.polarCount} wore polar</span> · <span style="color:var(--red);font-weight:700">${g.missing.length} didn't</span> · ${g.attended} attended</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${g.missing.map(d4 => `<button class="btn" style="font-size:10px;padding:3px 7px" onclick="openPerson('${d4}')" title="${escapeAttr(STATE.roster.find(r => r.id === d4)?.name || '')}"><span class="mono" style="color:var(--accent);font-weight:700">${displayId(d4)}</span> ${STATE.roster.find(r => r.id === d4)?.name || ''}</button>`).join("")}
          </div>
        </div>`).join("")}
      </div>
    </div>` : ""}

    <div class="card"><h3>Expected CSV Columns</h3><code class="mono" style="font-size:11px;color:var(--accent)">4D, Conduct, Date, Avg HR, Max HR, Min HR, Calories, Training Load, Recovery, Duration, Distance</code></div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th>Name</th><th>Conduct</th><th>Date</th><th>Avg HR</th><th>Max HR</th><th>Cal</th><th>Load</th><th>Dur</th></tr></thead><tbody>
    ${scoped.map(p => `<tr><td class="mono">${displayId(p.d4)}</td><td style="text-align:left">${displayPersonLabel(p.d4)}</td><td style="text-align:left">${conductName(p.conductId)}</td><td>${p.date}</td><td style="color:${+p.avgHr > 160 ? 'var(--red)' : +p.avgHr > 140 ? 'var(--orange)' : 'var(--green)'}">${p.avgHr}</td><td>${p.maxHr}</td><td>${p.calories}</td><td>${p.trainingLoad}</td><td>${p.duration}m</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.polar.length ? `No Polar sessions in ${filterLabel()}.` : "No Polar data. Import a CSV or upload photos."}</div>`}`;
}

// Conducts registry admin tab. Lists every entry in STATE.conducts with usage
// counts across attendance / polar / conductDetail, and offers rename / merge
// / delete actions. New conducts created here become available immediately
// in every form's conduct picker (the picker reads from STATE.conducts).
function renderConducts(el) {
  const rows = [...STATE.conducts].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const totalUsage = rows.reduce((s, c) => s + countConductUsage(c.id).total, 0);
  const orphanedCount = (arr) => arr.filter(r => r.conductId !== undefined && !STATE.conducts.find(c => c.id === r.conductId)).length;
  const orphans = orphanedCount(STATE.attendance) + orphanedCount(STATE.polar) + orphanedCount(STATE.conductDetail);
  const anyRecordsWithConductId = STATE.attendance.some(r => r.conductId) || STATE.polar.some(r => r.conductId) || STATE.conductDetail.some(r => r.conductId);
  const emptyRegistryWithUsage = rows.length === 0 && anyRecordsWithConductId;

  // Platoons present in the roster — the assignable columns for programs. A
  // platoon belongs to at most one program (mutually exclusive).
  const allPlatoons = [...new Set(STATE.roster.map(getPlt).filter(Boolean))].sort();
  const programsCard = `
    <div class="card" style="padding:12px 14px;margin-bottom:16px;background:var(--surface2);border-radius:8px">
      <div style="margin-bottom:8px">
        <strong style="font-size:14px">🎯 Training Programs</strong>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.5">Defines the programs and a <strong>fallback</strong> platoon→program mapping. A recruit's own <code>program</code> column (BMT/PTP on the Roster) overrides this; the platoon map only applies to recruits with no explicit program set. Drives the conduct wizard's program scoping and the program badges/filters.</div>
      </div>
      <div class="table-wrap"><table><thead><tr><th style="text-align:left">Program</th>${allPlatoons.map(p => `<th>P${p}</th>`).join("")}</tr></thead><tbody>
        ${STATE.programs.map(pr => `<tr>
          <td style="text-align:left"><span style="color:${programColor(pr.key)};font-weight:700">${escapeAttr(pr.name || pr.key)}</span> <button class="btn btn-icon" onclick="promptRenameProgram('${escapeAttr(pr.key)}')" title="Rename program">✎</button></td>
          ${allPlatoons.map(p => `<td><input type="checkbox" ${(pr.platoons || []).map(String).includes(String(p)) ? "checked" : ""} onchange="programSetPlatoon('${escapeAttr(pr.key)}','${escapeAttr(p)}',this.checked)" style="width:16px;height:16px;cursor:pointer"></td>`).join("")}
        </tr>`).join("")}
      </tbody></table></div>
    </div>`;

  el.innerHTML = `
    ${programsCard}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <h2 style="font-size:18px;font-weight:700">Conducts Registry <span style="color:var(--muted);font-weight:400;font-size:13px">${rows.length} entries · ${totalUsage} record${totalUsage === 1 ? "" : "s"}</span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${needsConductMigration() ? `<button class="btn" onclick="maybeRunConductMigration()" title="Open the legacy-data migration modal">🔧 Migrate legacy data</button>` : ""}
        ${duplicateConductIdGroups().length ? `<button class="btn" style="background:#F8514922;border-color:#F8514944;color:var(--red)" onclick="openFixConductIdsModal()" title="Multiple conducts share the same id — records resolve to the wrong name. Fix it.">⚠️ Fix duplicate ids (${duplicateConductIdGroups().length})</button>` : ""}
        <button class="btn btn-success" onclick="pushTab('Conducts',STATE.conducts)" title="Full re-write of this tab. Useful after manual sheet edits or to recover from a sync failure — normal edits auto-push.">↻ Re-push all</button>
        <button class="btn btn-primary" onclick="promptCreateConduct()">+ New conduct</button>
      </div>
    </div>
    ${emptyRegistryWithUsage ? `<div class="card" style="padding:12px 14px;margin-bottom:12px;background:#F8514922;border:1px solid #F8514944;font-size:12px;color:var(--red);line-height:1.6">
      <strong>⚠️ Registry is empty but records reference conductIds.</strong> This usually means the Apps Script backend wasn't redeployed with the new <code>Conducts</code> tab in its <code>readAllTabs</code> map. Until that's fixed, conduct names will show as <code>[c001?]</code> placeholders across the app.
      <div style="margin-top:6px;color:var(--muted)">Fix: open Apps Script editor → confirm <code>"Conducts": "conducts"</code> is in <code>tabMap</code> → Deploy → Manage deployments → New version. Then pull again.</div>
    </div>` : ""}
    <div class="card" style="padding:10px 14px;margin-bottom:12px;background:var(--surface2);font-size:11px;color:var(--muted);line-height:1.6">
      Conduct names are renames-safe — every record references the conduct by ID, so renaming here updates every display site without touching record data.
      Use <strong>Merge</strong> to fix near-duplicates that slipped through; use <strong>Delete</strong> only when usage is 0.
      ${orphans > 0 ? `<div style="color:var(--red);margin-top:6px"><strong>Warning:</strong> ${orphans} record${orphans === 1 ? " references" : "s reference"} a conductId not in the registry. Edit those records to repoint them.</div>` : ""}
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th style="text-align:left">Name</th><th>Attendance</th><th>Polar</th><th>Detail</th><th>Total</th><th></th></tr></thead><tbody>
      ${rows.map(c => {
        const u = countConductUsage(c.id);
        const mergeOpts = rows.filter(o => o.id !== c.id).map(o => `<option value="${o.id}">→ ${escapeAttr(o.name)}</option>`).join("");
        return `<tr>
          <td class="mono" style="color:var(--muted);font-size:11px">${c.id}</td>
          <td style="text-align:left;font-weight:600">${escapeAttr(c.name)}</td>
          <td>${u.attendance}</td>
          <td>${u.polar}</td>
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

// Assign/unassign a platoon to a program. A platoon belongs to at most one
// program, so assigning it first removes it from every other program.
function programSetPlatoon(programKey, plt, assigned) {
  const p = String(plt);
  STATE.programs.forEach(pr => {
    pr.platoons = (pr.platoons || []).map(String).filter(x => x !== p);
    if (assigned && pr.key === programKey) pr.platoons.push(p);
  });
  savePrograms();
  render();
}

function promptRenameProgram(programKey) {
  const pr = STATE.programs.find(x => x.key === programKey);
  if (!pr) return;
  const name = (prompt("Program name:", pr.name || pr.key) || "").trim();
  if (!name) return;
  pr.name = name;
  savePrograms();
  render();
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
