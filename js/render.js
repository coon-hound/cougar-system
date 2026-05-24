// View layer. render() dispatches to a per-tab function which fills #content.
// Each tab function may also (re)create charts; old chart instances are
// destroyed at the top of render() to avoid Chart.js canvas reuse errors.

function render() {
  Object.values(STATE.charts).forEach(c => c.destroy());
  STATE.charts = {};

  document.getElementById("content")?.scrollTo(0, 0);

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
    case "sync": renderSync(el); break;
    default: el.innerHTML = "";
  }
}

function renderDashboard(el) {
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
  const effectiveAll = currentMedicalEffectiveAll(today).filter(e => passesFilter(e.d4, visible));
  const allByD4 = Object.fromEntries(effectiveAll.map(e => [e.d4, e]));
  const topTag = r => allByD4[r.id]?.statuses[0];
  const liveRows = scoped.filter(r => topTag(r) && topTag(r).ghostDay === 0)
    .sort((a, b) => medSeverityRank(topTag(b).tag) - medSeverityRank(topTag(a).tag));
  const recoveringRows = scoped.filter(r => topTag(r) && topTag(r).ghostDay > 0)
    .sort((a, b) => topTag(a).ghostDay - topTag(b).ghostDay);
  const active = scoped.length - liveRows.length;
  const awayFromCamp = liveRows.filter(r => allByD4[r.id].statuses.some(s => s.tag === "MC" || s.tag === "Warded")).length;
  const inCamp = scoped.length - awayFromCamp;
  const avgPart = STATE.attendance.length ? Math.round(STATE.attendance.reduce((a, c) => a + (c.participating / c.total * 100), 0) / STATE.attendance.length) : 0;
  const scopeBanner = isFilterActive() ? `<div style="font-size:11px;color:var(--accent);margin-bottom:8px">Scope: <strong>${filterLabel()}</strong> — Attendance figures remain company-wide.</div>` : "";

  const isAll = !STATE.filterRole;
  const recRows = scoped.filter(r => r.role !== "Commander");
  const cmdRows = scoped.filter(r => r.role === "Commander");
  const recLive = liveRows.filter(r => r.role !== "Commander");
  const cmdLive = liveRows.filter(r => r.role === "Commander");
  const recActive = recRows.length - recLive.length;
  const cmdActive = cmdRows.length - cmdLive.length;
  const recAway = recLive.filter(r => allByD4[r.id].statuses.some(s => s.tag === "MC" || s.tag === "Warded")).length;
  const cmdAway = cmdLive.filter(r => allByD4[r.id].statuses.some(s => s.tag === "MC" || s.tag === "Warded")).length;
  const recInCamp = recRows.length - recAway;
  const cmdInCamp = cmdRows.length - cmdAway;
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
        </div>
      </div>
    </div>
    ${scopeBanner}
    <div class="stats-row" style="margin-top:12px">
      <div class="stat"><label>Total Str</label><div class="val">${scoped.length}${inlineBreakdown(recRows.length, cmdRows.length)}</div></div>
      <div class="stat"><label>Active today</label><div class="val" style="color:var(--green)">${active}${inlineBreakdown(recActive, cmdActive)}</div></div>
      <div class="stat"><label>Non-Active</label><div class="val" style="color:var(--red)">${liveRows.length}${inlineBreakdown(recLive.length, cmdLive.length)}</div></div>
      <div class="stat"><label>In Camp</label><div class="val" style="color:var(--teal)">${inCamp}${inlineBreakdown(recInCamp, cmdInCamp)}</div></div>
      <div class="stat"><label>Avg Part.</label><div class="val" style="color:var(--accent)">${avgPart}%</div></div>
    </div>
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
    ${renderDashLeaveOut(visible, today)}`;

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

  STATE.charts.participation = new Chart(document.getElementById("chart-participation"), {
    type: "bar",
    data: { labels: STATE.attendance.map(a => a.conduct?.slice(0, 12)), datasets: [{ data: STATE.attendance.map(a => pct(a.participating, a.total)), backgroundColor: "#58A6FF44", borderColor: "#58A6FF", borderWidth: 1 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 80, max: 100, grid: { color: "#30363D" }, ticks: { color: "#8B949E" } }, x: { grid: { display: false }, ticks: { color: "#8B949E", font: { size: 9 } } } } }
  });
}

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

  const typeColor = t => t === "Off-in-Lieu" ? "accent" : t === "Leave" ? "teal" : t === "Night's Out" ? "pink" : t === "Course" ? "purple" : t === "Guard Duty" ? "orange" : t === "NDP" ? "yellow" : "muted";

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
  const typeColor = t => t === "Off-in-Lieu" ? "accent" : t === "Leave" ? "teal" : t === "Night's Out" ? "pink" : t === "Course" ? "purple" : t === "Guard Duty" ? "orange" : t === "NDP" ? "yellow" : "muted";

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="font-size:18px;font-weight:700">📅 Leave / Out${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('Leave',STATE.leave)">Push to Sheet</button>
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

  const byPerson = {};
  overlapping.forEach(l => { (byPerson[l.d4] = byPerson[l.d4] || []).push(l); });
  const people = Object.keys(byPerson).sort((a, b) => {
    const aEarliest = byPerson[a].reduce((m, l) => l.startIso < m ? l.startIso : m, "9999");
    const bEarliest = byPerson[b].reduce((m, l) => l.startIso < m ? l.startIso : m, "9999");
    return aEarliest < bEarliest ? -1 : 1;
  });

  const typeBg = t => ({
    "Off-in-Lieu": "#58A6FF", "Leave": "#39D2C0", "Night's Out": "#F778BA",
    "Course": "#BC8CFF", "Guard Duty": "#D29922", "NDP": "#E3B341", "Other": "#8B949E"
  })[t] || "#8B949E";

  const headerCells = days.map((d, i) => {
    const isWeekStart = i === 0 || d.getDay() === 1;
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

  const legend = ["Off-in-Lieu", "Leave", "Night's Out", "Course", "Guard Duty", "NDP", "Other"]
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

  const rows = upcoming.map(a => {
    const iso = displayDateToISO(a.date);
    const isToday = iso === todayIso;
    const dayLabel = isToday ? `<span class="badge badge-red" style="font-size:9px">TODAY</span>` : "";
    return `<tr onclick="openPerson('${a.d4}')" style="cursor:pointer${isToday ? ';background:#F8514911' : ''}">
      <td class="mono" style="font-weight:700;color:var(--accent)">${displayId(a.d4)}</td>
      <td style="text-align:left">${displayPersonLabel(a.d4)}</td>
      <td style="text-align:left">${a.reason || ""}</td>
      <td style="white-space:nowrap">${a.date || ""} ${dayLabel}</td>
      <td class="mono" style="white-space:nowrap">${pad4Time(a.time) || ""}</td>
      <td style="text-align:left;font-size:11px;color:var(--muted)">${a.location || ""}</td>
      <td style="white-space:nowrap"><button class="btn btn-icon" style="color:var(--green)" onclick="event.stopPropagation(); toggleAppointmentResolved(${a.id})" title="Mark as resolved">✓</button> <button class="btn btn-icon" onclick="event.stopPropagation(); openAppointmentForm(${a.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('appointments', ${a.id}, 'appointment')" title="Delete">✕</button></td>
    </tr>`;
  }).join("");

  return header + `<div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Reason</th><th>Date</th><th>Time</th><th style="text-align:left">Location</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDashProfileCards(scoped) {
  const rationCounts = {};
  scoped.forEach(r => { const k = (r.ration || "").trim() || "Unspecified"; rationCounts[k] = (rationCounts[k] || 0) + 1; });
  const rationRows = Object.entries(rationCounts).sort((a, b) => b[1] - a[1]);
  const rationColor = k => k === "Muslim" ? "var(--green)" : k === "Non-Muslim" ? "var(--accent)" : "var(--muted)";

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
  const titleSuffix = isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.roster.length}]</span>` : ` (${STATE.roster.length})`;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Master Roster${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="exportCSV(STATE.roster,'roster.csv')">Export CSV</button>
        <button class="btn btn-success" onclick="pushTab('Roster',STATE.roster)">Push to Sheet</button>
      </div>
    </div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th style="text-align:left">Name</th><th>Role</th><th>Status</th><th>BMI</th><th>RSIs</th></tr></thead><tbody>
    ${scoped.map(r => {
      const bmi = calcBMI(r);
      const isCmd = r.role === "Commander";
      const nameCell = isCmd ? `${r.rank ? r.rank + " " : ""}${r.name}` : r.name;
      const idCell = isCmd ? "" : r.id;
      const roleCell = isCmd ? `<span class="badge badge-purple">Commander</span>` : `<span style="color:var(--muted);font-size:11px">Recruit</span>`;
      return `<tr onclick="openPerson('${r.id}')" style="cursor:pointer"><td class="mono" style="font-weight:700;color:var(--accent)">${idCell}</td><td style="text-align:left">${nameCell}</td><td>${roleCell}</td><td>${statusBadge(r.status)}</td><td style="font-weight:700;color:${bmiColor(bmi)}">${isCmd ? '—' : (bmi ?? '—')}</td><td style="color:${(rsiCount[r.id] || 0) > 1 ? 'var(--red)' : 'var(--muted)'}">${rsiCount[r.id] || 0}</td></tr>`;
    }).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.roster.length ? `No personnel in ${filterLabel()}.` : (STATE.authToken ? "Loading roster from sheet…" : "No invite redeemed on this device yet.")}</div>`}`;
}

function renderAttendance(el) {
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Conduct Attendance</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('Attendance',STATE.attendance)">Push to Sheet</button>
        <button class="btn btn-primary" onclick="openAttendanceForm()">+ Log</button>
      </div>
    </div>
    ${STATE.attendance.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Conduct</th><th>Total</th><th>Part.</th><th>LMS</th><th>PX</th><th>Fallout</th><th>Rate</th><th>LMS Rate</th><th style="text-align:left">Remarks</th><th></th></tr></thead><tbody>
    ${STATE.attendance.map(a => {
      const r = pct(a.participating, a.total);
      const lms = +a.lms || 0;
      const lmsRate = pct(lms, a.participating);
      const rateColor = r >= 95 ? 'var(--green)' : r >= 70 ? 'var(--orange)' : 'var(--red)';
      const lmsRateColor = a.participating ? (lmsRate >= 95 ? 'var(--green)' : lmsRate >= 70 ? 'var(--orange)' : 'var(--red)') : 'var(--muted)';
      return `<tr><td>${a.date}</td><td style="text-align:left">${a.conduct}</td><td>${a.total}</td><td>${a.participating}</td><td style="color:${lms > 0 ? 'var(--accent)' : 'var(--muted)'}">${lms}</td><td style="color:${a.px > 0 ? 'var(--orange)' : 'var(--muted)'}">${a.px}</td><td style="color:${a.fallout > 0 ? 'var(--red)' : 'var(--muted)'}">${a.fallout}</td><td style="font-weight:700;color:${rateColor}">${r}%</td><td style="font-weight:700;color:${lmsRateColor}">${a.participating ? lmsRate + '%' : '—'}</td><td style="text-align:left;color:${a.remarks ? 'var(--yellow)' : 'var(--muted)'};max-width:200px;white-space:normal;font-size:11px">${a.remarks || ''}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="openAttendanceForm(${a.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('attendance', ${a.id}, 'attendance entry')" title="Delete">✕</button></td></tr>`;
    }).join("")}
    </tbody></table></div>` : `<div class="empty-state">No attendance records yet.</div>`}`;
}

let _detailFilterConduct = "";
let _detailFilterType = "";
let _showParticipants = false;
function setDetailFilterConduct(v) { _detailFilterConduct = v; _showParticipants = false; render(); }
function setDetailFilterType(v) { _detailFilterType = v; render(); }
function clearDetailFilters() { _detailFilterConduct = ""; _detailFilterType = ""; _showParticipants = false; render(); }
function toggleParticipants() { _showParticipants = !_showParticipants; render(); }

function renderDetailParticipantsSummary(scopedAll) {
  if (!_detailFilterConduct) return "";
  const conductRecords = scopedAll.filter(d => `${d.date}|${d.time || ""}|${d.conduct}` === _detailFilterConduct);
  const absentSet = new Set(conductRecords.map(d => d.d4));
  const inScope = filteredRoster();
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
          <span style="color:var(--muted)"> (PX ${ct("PX")} · RSI ${ct("RSI")} · Fallout ${ct("Fallout")} · ReportSick ${ct("ReportSick")})</span>
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
  if (_detailFilterConduct) scoped = scoped.filter(d => `${d.date}|${d.time || ""}|${d.conduct}` === _detailFilterConduct);
  if (_detailFilterType) scoped = scoped.filter(d => d.type === _detailFilterType);

  const conductKeys = [...new Set(scopedAll.map(d => `${d.date}|${d.time || ""}|${d.conduct}`))]
    .filter(Boolean)
    .sort((a, b) => {
      const [ad, at] = a.split("|"), [bd, bt] = b.split("|");
      const ai = displayDateToISO(ad) || ad;
      const bi = displayDateToISO(bd) || bd;
      if (ai !== bi) return ai < bi ? 1 : -1;
      return (at || "") < (bt || "") ? 1 : -1;
    });

  const rows = [...scoped].sort((a, b) => {
    const ai = displayDateToISO(a.date) || a.date || "";
    const bi = displayDateToISO(b.date) || b.date || "";
    if (ai !== bi) return ai < bi ? 1 : -1;
    return (a.time || "") < (b.time || "") ? 1 : -1;
  });

  const cnt = t => scoped.filter(d => d.type === t).length;

  const missed = {};
  scopedAll.forEach(d => {
    const k = `${d.date}|${d.time || ""}|${d.conduct}`;
    (missed[d.d4] = missed[d.d4] || new Set()).add(k);
  });
  const topMissed = Object.entries(missed)
    .map(([d4, set]) => ({ d4, count: set.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const typeBadgeColor = t => t === "PX" ? "orange" : t === "RSI" ? "red" : t === "Fallout" ? "purple" : "yellow";
  const totalConducts = [...new Set(scopedAll.map(d => `${d.date}|${d.time || ""}|${d.conduct}`))].length;
  const titleSuffix = isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scopedAll.length}/${STATE.conductDetail.length}]</span>` : ` (${STATE.conductDetail.length})`;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="font-size:18px;font-weight:700">Conduct Detail${titleSuffix}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('ConductDetail',STATE.conductDetail)">Push to Sheet</button>
        <button class="btn btn-primary" onclick="openConductDetailForm()">+ Log</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><label>PX (pre-existing)</label><div class="val" style="color:var(--orange)">${cnt("PX")}</div></div>
      <div class="stat"><label>RSI (1st parade)</label><div class="val" style="color:var(--red)">${cnt("RSI")}</div></div>
      <div class="stat"><label>Fallout (mid-conduct)</label><div class="val" style="color:var(--purple)">${cnt("Fallout")}</div></div>
      <div class="stat"><label>Reported Sick (mid-day)</label><div class="val" style="color:var(--yellow)">${cnt("ReportSick")}</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">Filter:</span>
      <select onchange="setDetailFilterConduct(this.value)" class="topbar-select" style="min-width:260px">
        <option value="">All conducts (${totalConducts})</option>
        ${conductKeys.map(k => { const [dt, tm, cn] = k.split("|"); return `<option value="${escapeAttr(k)}" ${k === _detailFilterConduct ? "selected" : ""}>${dt}${tm ? " " + pad4Time(tm) : ""} — ${cn}</option>`; }).join("")}
      </select>
      <select onchange="setDetailFilterType(this.value)" class="topbar-select">
        <option value="">All types</option>
        ${["PX","RSI","Fallout","ReportSick"].map(t => `<option value="${t}" ${t === _detailFilterType ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      ${(_detailFilterConduct || _detailFilterType) ? `<button class="btn" onclick="clearDetailFilters()">Reset</button>` : ""}
    </div>
    ${renderDetailParticipantsSummary(scopedAll)}
    <div class="grid-2" style="grid-template-columns:2fr 1fr;align-items:start">
      <div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th style="text-align:left">Conduct</th><th>4D</th><th style="text-align:left">Name</th><th>Type</th><th style="text-align:left">Reason</th><th></th></tr></thead><tbody>
        ${rows.map(d => `<tr onclick="openPerson('${d.d4}')" style="cursor:pointer"><td>${d.date || ""}</td><td class="mono">${pad4Time(d.time) || "—"}</td><td style="text-align:left">${d.conduct || ""}</td><td class="mono" style="font-weight:700;color:var(--accent)">${d.d4}</td><td style="text-align:left">${getName(d.d4)}</td><td>${badge(d.type, typeBadgeColor(d.type))}</td><td style="text-align:left;max-width:280px;white-space:normal;font-size:11px">${d.reason || ""}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openConductDetailForm(${d.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('conductDetail', ${d.id}, 'conduct detail record')" title="Delete">✕</button></td></tr>`).join("")}
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
  const rowsWithTag = scoped.map(m => ({ m, tagInfo: medStatusTag(m, today) }));
  rowsWithTag.sort((a, b) => {
    const ai = displayDateToISO(a.m.startDate || a.m.date) || "";
    const bi = displayDateToISO(b.m.startDate || b.m.date) || "";
    return ai < bi ? 1 : ai > bi ? -1 : 0;
  });
  const activeCount = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay === 0).length;
  const ghostCount = rowsWithTag.filter(r => r.tagInfo && r.tagInfo.ghostDay > 0).length;
  const pendingCount = scoped.filter(m => m.status === "Pending").length;

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

  const rsCounts = {};
  scoped.forEach(m => { rsCounts[m.d4] = (rsCounts[m.d4] || 0) + 1; });
  const topReporters = Object.entries(rsCounts)
    .map(([d4, count]) => ({ d4, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Report Sick Log${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.medical.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('Medical',STATE.medical)">Push to Sheet</button>
        <button class="btn btn-primary" onclick="openMedicalForm()">+ Log Report Sick</button>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat"><label>Total report sicks</label><div class="val">${scoped.length}${inlineBreakdown(totalSplit)}</div></div>
      <div class="stat"><label>Active today</label><div class="val" style="color:var(--red)">${activeCount}${inlineBreakdown(activeSplit)}</div></div>
      <div class="stat"><label>Recovering</label><div class="val" style="color:var(--orange)">${ghostCount}${inlineBreakdown(recoveringSplit)}</div></div>
      <div class="stat"><label>Pending</label><div class="val" style="color:var(--muted)">${pendingCount}${inlineBreakdown(pendingSplit)}</div></div>
    </div>
    <div class="grid-2" style="grid-template-columns:2fr 1fr;align-items:start">
      <div>
        ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>Reported</th><th>4D</th><th style="text-align:left">Name</th><th style="text-align:left">Reason</th><th>Status</th><th>Start</th><th>End</th><th>Today</th><th></th></tr></thead><tbody>
        ${rowsWithTag.map(({ m, tagInfo }) => { const noDur = m.status === "Pending" || m.status === "NIL"; return `<tr onclick="openPerson('${m.d4}')" style="cursor:pointer"><td>${m.date || ""}</td><td class="mono" style="font-weight:700;color:var(--accent)">${displayId(m.d4)}</td><td style="text-align:left">${displayPersonLabel(m.d4)}</td><td style="text-align:left">${m.reason || ""}</td><td>${m.status ? medTagBadge(m.status) : '<span style="color:var(--muted)">—</span>'}</td><td>${m.startDate || (noDur ? '<span style="color:var(--muted)">—</span>' : "")}</td><td>${m.endDate || (noDur ? '<span style="color:var(--muted)">—</span>' : "")}</td><td>${tagInfo ? medTagBadge(tagInfo.tag) : '<span style="color:var(--dim)">cleared</span>'}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="event.stopPropagation(); openMedicalForm(${m.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="event.stopPropagation(); deleteEntry('medical', ${m.id}, 'medical record')" title="Delete">✕</button></td></tr>`; }).join("")}
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

function renderIPPT(el) {
  const visible = visibleD4Set();
  const scoped = STATE.ippt.filter(i => passesFilter(i.d4, visible));
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">IPPT Tracker${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.ippt.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <label class="btn" style="cursor:pointer">Import CSV<input type="file" accept=".csv" onchange="importIPPT(this)" style="display:none"></label>
        <button class="btn btn-success" onclick="pushTab('IPPT',STATE.ippt)">Push to Sheet</button>
        <button class="btn btn-primary" onclick="openIPPTForm()">+ Add</button>
      </div>
    </div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th>Name</th><th>#</th><th>Date</th><th>PU</th><th>SU</th><th>2.4km</th><th>Score</th><th>Award</th><th></th></tr></thead><tbody>
    ${scoped.map(i => `<tr><td class="mono" style="font-weight:700">${displayId(i.d4)}</td><td style="text-align:left">${displayPersonLabel(i.d4)}</td><td>${i.attempt}</td><td>${i.date}</td><td>${i.pushups}</td><td>${i.situps}</td><td>${i.runTime}</td><td style="font-weight:700;font-size:15px">${i.score}</td><td>${awardBadge(i.score)}</td><td style="white-space:nowrap"><button class="btn btn-icon" onclick="openIPPTForm(${i.id})" title="Edit">✎</button> <button class="btn btn-icon btn-danger" onclick="deleteEntry('ippt', ${i.id}, 'IPPT entry')" title="Delete">✕</button></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.ippt.length ? `No IPPT entries in ${filterLabel()}.` : "No IPPT data yet. Add results or import CSV."}</div>`}`;
}

function renderRM(el) {
  const visible = visibleD4Set();
  const scoped = STATE.rm.filter(r => passesFilter(r.d4, visible));
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Route March Tracker${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.rm.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <label class="btn" style="cursor:pointer">Import CSV<input type="file" accept=".csv" onchange="importRM(this)" style="display:none"></label>
        <button class="btn btn-success" onclick="pushTab('RouteMarch',STATE.rm)">Push to Sheet</button>
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
        <button class="btn btn-success" onclick="pushTab('SOC',STATE.soc)">Push to Sheet</button>
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
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:700">Polar Flow Data${isFilterActive() ? ` <span style="color:var(--accent);font-size:13px">[${filterLabel()}: ${scoped.length}/${STATE.polar.length}]</span>` : ""}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-success" onclick="pushTab('PolarFlow',STATE.polar)">Push to Sheet</button>
        <label class="btn btn-primary" style="cursor:pointer">Import Polar CSV<input type="file" accept=".csv" onchange="importPolar(this)" style="display:none"></label>
      </div>
    </div>
    <div class="card"><h3>Expected CSV Columns</h3><code class="mono" style="font-size:11px;color:var(--accent)">4D, Conduct, Date, Avg HR, Max HR, Min HR, Calories, Training Load, Recovery, Duration, Distance</code></div>
    ${scoped.length ? `<div class="table-wrap"><table><thead><tr><th>4D</th><th>Name</th><th>Conduct</th><th>Date</th><th>Avg HR</th><th>Max HR</th><th>Cal</th><th>Load</th><th>Dur</th></tr></thead><tbody>
    ${scoped.map(p => `<tr><td class="mono">${displayId(p.d4)}</td><td style="text-align:left">${displayPersonLabel(p.d4)}</td><td style="text-align:left">${p.conduct}</td><td>${p.date}</td><td style="color:${+p.avgHr > 160 ? 'var(--red)' : +p.avgHr > 140 ? 'var(--orange)' : 'var(--green)'}">${p.avgHr}</td><td>${p.maxHr}</td><td>${p.calories}</td><td>${p.trainingLoad}</td><td>${p.duration}m</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">${STATE.polar.length ? `No Polar sessions in ${filterLabel()}.` : "No Polar data. Import a CSV."}</div>`}

    <div id="polar-photo-panel" style="margin-top:1.5rem;">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;flex-wrap:wrap;gap:8px;">
          <h3 style="margin:0;">📸 Class Photo Analysis</h3>
          <span id="pp-counter" style="font-size:12px;color:var(--muted);">No pages analysed yet</span>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:1rem;">
          Upload each page of the Polar summary screen one at a time. Results accumulate across pages automatically.
        </p>
        <div id="pp-drop" onclick="document.getElementById('pp-file').click()" style="border:1.5px dashed var(--border);border-radius:8px;padding:1.5rem 1rem;text-align:center;cursor:pointer;margin-bottom:1rem;">
          <div style="font-size:24px;margin-bottom:.3rem;">📷</div>
          <div style="font-size:14px;color:var(--muted);">Drop photo here or <strong style="color:var(--accent);">click to browse</strong></div>
          <div style="font-size:11px;color:var(--dim);margin-top:.2rem;">JPG, PNG, WEBP — max 10 MB</div>
          <input type="file" id="pp-file" accept="image/jpeg,image/png,image/webp" onchange="ppSelectFile(this)" style="display:none;">
        </div>
        <div id="pp-preview" style="display:none;margin-bottom:1rem;">
          <img id="pp-img" style="max-width:100%;max-height:320px;border-radius:8px;border:1px solid var(--border);display:block;">
          <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="ppAnalyse()">Analyse this page</button>
            <button class="btn" onclick="ppDiscard()">Discard</button>
            <span id="pp-fname" style="font-size:12px;color:var(--muted);"></span>
          </div>
        </div>
        <div id="pp-status" style="display:none;font-size:13px;color:var(--muted);padding:6px 0;"></div>
        <button id="pp-view-btn" class="btn" style="display:none;margin-top:.5rem;" onclick="ppViewResults()">View results</button>
      </div>
    </div>`;
}
