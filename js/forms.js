// Modal infrastructure, person-detail view, form openers/submitters, and CSV importers.

function openModal(title, html) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = html;
  document.getElementById("modal-overlay").classList.remove("hidden");
}
function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  // Reset the wide-modal flag so the next form-style modal isn't oversized.
  document.querySelector(".modal")?.classList.remove("wide");
}

function openPerson(d4) {
  const p = STATE.roster.find(r => r.id === d4); if (!p) return;
  const med = STATE.medical.filter(m => m.d4 === d4);
  const ippts = STATE.ippt.filter(i => i.d4 === d4).sort((a, b) => a.attempt - b.attempt);
  const rms = STATE.rm.filter(r => r.d4 === d4).sort((a, b) => a.rmNum - b.rmNum);
  const socs = STATE.soc.filter(s => s.d4 === d4).sort((a, b) => a.socNum - b.socNum);

  // Polar sessions, chronological. Dates from the sheet arrive as "17 May 2026",
  // so convert to ISO for a reliable sort and fall back to raw string if parse fails.
  const pol = STATE.polar.filter(x => x.d4 === d4).slice().sort((a, b) => {
    const ai = displayDateToISO(a.date) || a.date || "";
    const bi = displayDateToISO(b.date) || b.date || "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  // Per-session derived metrics. Guard against div-by-zero on missing HR/duration.
  const computed = pol.map(x => {
    const avg = +x.avgHr || 0, max = +x.maxHr || 0, cal = +x.calories || 0, dur = +x.duration || 0;
    return {
      date: x.date, conduct: conductName(x.conductId),
      avgHr: avg, maxHr: max, calories: cal, duration: dur,
      efficiency: avg ? +(cal / avg).toFixed(2) : 0,
      intensity:  max ? +((avg / max) * 100).toFixed(1) : 0,
      workload:   avg * dur
    };
  });
  const latest = computed[computed.length - 1];

  // Commanders never show their 00xx id — surface rank instead. Recruits keep
  // the existing "4D — status" header, plus a training-program badge (PTP/BMT).
  const prog = p.role === "Commander" ? "" : programOf(p);
  let html = p.role === "Commander"
    ? `<div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.rank ? p.rank + " · " : ""}Commander${p.status ? ` — ${statusBadge(p.status)}` : ""}</div>`
    : `<div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.id} — ${statusBadge(p.status)}${prog ? " " + programBadge(prog) : ""}</div>`;

  // ── In/out-of-camp status + Book Out / Book In ───────
  // Reflects the shared out-of-camp computation. The lever always offers the
  // opposite of the effective state: out (any reason, incl. MC/leave) → Book In,
  // which counts them present for today; in camp → Book Out. A present-override
  // over an MC/leave reason shows as a teal "IN CAMP (MANUAL)" pill.
  const campInfo = outOfCampMap(todayISO()).get(d4);
  const forcedInHere = !campInfo && isForcedIn(p, todayISO()) && derivedCampOut(d4, todayISO());
  const pill = (txt, bg) => `<span style="display:inline-block;padding:3px 9px;border-radius:10px;font-size:10px;font-weight:700;background:${bg}22;color:${bg}">${txt}</span>`;
  html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
    ${campInfo ? pill("OUT OF CAMP", "#F85149") : forcedInHere ? pill("IN CAMP (MANUAL)", "#39D2C0") : pill("IN CAMP", "#3FB950")}
    ${campInfo ? `<span style="font-size:11px;color:var(--muted)">${escapeAttr(campInfo.reason || "")}</span>` : ""}
    ${campInfo && campInfo.kind !== "bookedout"
      ? `<span style="font-size:10px;color:var(--dim)">(via ${campInfo.kind} record — Book In counts them present today)</span>`
      : forcedInHere ? `<span style="font-size:10px;color:var(--dim)">(would be out: ${escapeAttr(forcedInHere.reason || "")}; resets tomorrow)</span>` : ""}
    <button class="btn ${campInfo ? "btn-success" : "btn-danger"}" style="font-size:11px;padding:4px 10px" onclick="bookOutToggle('${d4}', ${campInfo ? "false" : "true"}, 'Out of camp'); openPerson('${d4}')">${campInfo ? "↩ Book In" : "🚪 Book Out"}</button>
  </div>`;

  // ── Profile section ──────────────────────────────────
  const bmi = calcBMI(p);
  // 8-digit local numbers display nicer with a space in the middle.
  const fmtPhone = s => { const d = String(s || "").replace(/\D/g, ""); return d.length === 8 ? d.slice(0, 4) + " " + d.slice(4) : (s || ""); };
  const edu = p["highest education level"] || "";
  const moto = p["motorcycle license"] || "";
  const fact = (label, val, color) => `<span style="color:var(--muted)">${label}:</span> <strong style="color:${color || 'var(--text)'}">${val || '—'}</strong>`;

  html += `<div class="card" style="margin-bottom:12px;padding:14px"><h3 style="margin-bottom:10px">Profile</h3>
    <div class="stats-row" style="margin-bottom:10px">
      <div class="stat"><label>Age</label><div class="val">${p.age || '—'}</div></div>
      <div class="stat"><label>Height</label><div class="val">${p.height ? p.height + '<span style="font-size:11px;color:var(--muted)"> cm</span>' : '—'}</div></div>
      <div class="stat"><label>Weight</label><div class="val">${p.weight ? p.weight + '<span style="font-size:11px;color:var(--muted)"> kg</span>' : '—'}</div></div>
      <div class="stat"><label>BMI</label><div class="val" style="color:${bmiColor(bmi)}">${bmi ?? '—'}</div></div>
    </div>
    ${p.phone || p.email ? `<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-bottom:8px">
      ${p.phone ? `<span>📞 <a href="tel:${escapeAttr(String(p.phone).replace(/\D/g, ""))}" style="color:var(--accent);text-decoration:none">${fmtPhone(p.phone)}</a></span>` : ""}
      ${p.email ? `<span>✉ <a href="mailto:${escapeAttr(p.email)}" style="color:var(--accent);text-decoration:none;word-break:break-all">${p.email}</a></span>` : ""}
    </div>` : ""}
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px">
      ${fact("Ration", p.ration)}
      ${fact("Edu", edu)}
      ${fact("Motorcycle", moto || "No")}
    </div>
  </div>`;

  if (p.allergies) html += `<div style="background:#E3B34122;border:1px solid #E3B34144;border-radius:6px;padding:8px;margin-bottom:8px;font-size:12px;color:var(--yellow)"><strong>Allergies:</strong> ${p.allergies}</div>`;
  if (p.msk) html += `<div style="background:#F8514922;border:1px solid #F8514944;border-radius:6px;padding:8px;margin-bottom:12px;font-size:12px;color:var(--red)"><strong>MSK history:</strong> ${p.msk}</div>`;
  if (p.otherMedical) html += `<div style="background:#E3B34122;border:1px solid #E3B34144;border-radius:6px;padding:8px;margin-bottom:12px;font-size:12px;color:var(--yellow)"><strong>Other medical:</strong> ${p.otherMedical}</div>`;

  // ── Personal details (enlistment form) ────────────────
  // Only rendered when at least one field is present — hides the whole card for
  // commanders and older recruits who never filled the detailed intake form.
  if (p.dob || p.bloodType || p.fieldOfStudy || p.gpa || p.smoker || p.address) {
    html += `<div class="card" style="margin-bottom:12px;padding:14px"><h3 style="margin-bottom:10px">Personal</h3>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-bottom:${p.address ? '8px' : '0'}">
        ${fact("DOB", p.dob)}
        ${fact("Blood", p.bloodType)}
        ${fact("Smoker", p.smoker)}
        ${fact("Field of study", p.fieldOfStudy)}
        ${fact("GPA", p.gpa)}
      </div>
      ${p.address ? `<div style="font-size:12px"><span style="color:var(--muted)">Address:</span> <strong>${p.address}</strong></div>` : ""}
    </div>`;
  }

  // ── Next of kin ───────────────────────────────────────
  if (p.nokName || p.nokRelation || p.nokPhone || p.nokOccupation) {
    html += `<div class="card" style="margin-bottom:12px;padding:14px"><h3 style="margin-bottom:10px">Next of Kin</h3>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px">
        ${fact("Name", p.nokName)}
        ${fact("Relationship", p.nokRelation)}
        ${p.nokPhone ? `<span style="color:var(--muted)">Phone:</span> <strong><a href="tel:${escapeAttr(String(p.nokPhone).replace(/\D/g, ""))}" style="color:var(--accent);text-decoration:none">${fmtPhone(p.nokPhone)}</a></strong>` : fact("Phone", "")}
        ${fact("Occupation", p.nokOccupation)}
      </div>
    </div>`;
  }

  // RSIs stat is clickable when there are records — opens an inline patterns
  // panel below the stats strip with day-of-week, status mix, timeline, reasons.
  // Count is deduped per date so a recruit with multiple medical entries on
  // the same day (e.g. wizard auto-Pending + manual MC + manual Excuse) only
  // shows as one report-sick event.
  const rsClickable = med.length > 0;
  const medDays = new Set(med.map(m => m.date)).size;
  html += `<div class="stats-row"><div class="stat" ${rsClickable ? `onclick="toggleReportSickPatterns('${d4}')" style="cursor:pointer" title="Click to see patterns (unique days — multiple medical rows on the same day count as 1)"` : ""}><label>RSIs ${rsClickable ? '<span style="color:var(--dim);font-size:9px">▾ patterns</span>' : ''}</label><div class="val" style="color:${medDays > 1 ? 'var(--red)' : 'var(--muted)'}">${medDays}</div></div>`;
  html += `<div class="stat"><label>IPPT Best</label><div class="val" style="color:var(--orange)">${ippts.length ? Math.max(...ippts.map(i => +i.score)) : "—"}</div></div>`;
  html += `<div class="stat"><label>RMs</label><div class="val" style="color:var(--teal)">${rms.length}</div></div>`;
  html += `<div class="stat"><label>SOCs</label><div class="val" style="color:var(--purple)">${socs.length}</div></div></div>`;
  html += `<div id="rs-patterns" style="display:none"></div>`;

  // Conduct Participation History — sits above IPPT/RM/SOC so a PC checking
  // "why has this recruit been missing conducts" sees the answer first thing.
  const cd = STATE.conductDetail.filter(d => d.d4 === d4).slice().sort((a, b) => {
    const ai = displayDateToISO(a.date) || a.date || "";
    const bi = displayDateToISO(b.date) || b.date || "";
    if (ai !== bi) return ai < bi ? 1 : -1;
    return (a.time || "") < (b.time || "") ? 1 : -1;
  });
  if (cd.length) {
    const cdTypeColor = t => t === "PX" ? "orange" : t === "RSI" ? "red" : t === "Fallout" ? "purple" : "yellow";
    // ReportSick is deduped by date — a recruit who falls out of three
    // conducts on the same day only went to MO once. Other types count rows
    // directly since each row is a distinct conduct miss.
    const cdCount = t => {
      const rows = cd.filter(d => d.type === t);
      if (t === "ReportSick") return new Set(rows.map(d => d.date)).size;
      return rows.length;
    };
    html += `<h4 style="font-size:12px;color:var(--muted);margin:16px 0 8px">Conduct Participation History — <span style="color:var(--red)">${cd.length} missed</span> <span style="color:var(--dim);font-weight:400">(${cdCount("PX")} PX · ${cdCount("RSI")} RSI · ${cdCount("Fallout")} Fallout · ${cdCount("ReportSick")} ReportSick)</span></h4>`;
    html += `<div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:left">Date</th><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:left">Conduct</th><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Type</th><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:left">Reason</th></tr></thead>
        <tbody>
          ${cd.map(d => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px;font-size:11px;color:var(--muted);white-space:nowrap">${d.date}${d.time ? ' <span class="mono" style="color:var(--dim)">' + fmtHrs(d.time) + '</span>' : ''}</td><td style="padding:6px 8px;font-size:11px">${conductName(d.conductId)}</td><td style="padding:6px 8px;text-align:center">${badge(d.type, cdTypeColor(d.type))}</td><td style="padding:6px 8px;font-size:11px;color:var(--text)">${d.reason || ''}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  }

  if (ippts.length) {
    html += `<h4 style="font-size:12px;color:var(--muted);margin:12px 0 8px">IPPT Progression</h4>`;
    html += `<div class="chart-box"><canvas id="person-ippt-chart"></canvas></div>`;
    html += ippts.map(i => `<span class="badge badge-accent" style="margin:2px">#${i.attempt}: ${i.score} ${awardBadge(i.score)}</span>`).join("");
  }
  if (rms.length) {
    html += `<h4 style="font-size:12px;color:var(--muted);margin:12px 0 8px">Route March</h4><div style="display:flex;gap:8px;flex-wrap:wrap">`;
    html += rms.map(r => `<div style="background:var(--surface2);border-radius:6px;padding:8px 12px;border:1px solid var(--border);text-align:center"><div style="font-size:10px;color:var(--muted)">RM ${r.rmNum}</div><div class="mono" style="font-size:16px;font-weight:700;color:var(--teal)">${r.time}</div></div>`).join("");
    html += `</div>`;
  }
  if (socs.length) {
    html += `<h4 style="font-size:12px;color:var(--muted);margin:12px 0 8px">SOC</h4><div style="display:flex;gap:8px;flex-wrap:wrap">`;
    html += socs.map(s => `<div style="background:var(--surface2);border-radius:6px;padding:8px 12px;border:1px solid var(--border);text-align:center"><div style="font-size:10px;color:var(--muted)">SOC ${s.socNum}</div><div class="mono" style="font-size:16px;font-weight:700;color:var(--purple)">${s.time}</div></div>`).join("");
    html += `</div>`;
  }
  if (med.length) {
    const today = todayISO();
    // Sort newest-first by startDate (falling back to date logged) so the
    // most recent / currently-relevant entries are at the top.
    const medSorted = med.slice().sort((a, b) => {
      const ai = displayDateToISO(a.startDate || a.date) || "";
      const bi = displayDateToISO(b.startDate || b.date) || "";
      return ai < bi ? 1 : ai > bi ? -1 : 0;
    });
    html += `<h4 style="font-size:12px;color:var(--muted);margin:12px 0 8px">Medical History <span style="color:var(--dim);font-weight:400">(${med.length})</span></h4>`;
    html += medSorted.map(m => {
      const tagInfo = medStatusTag(m, today);
      const todayLabel = tagInfo ? `<span style="margin-left:6px">${medTagBadge(tagInfo.tag)}<span style="color:var(--dim);font-size:10px;margin-left:4px">today</span></span>` : "";
      return `<div style="background:var(--surface2);border-radius:6px;padding:8px 10px;margin-bottom:4px;border:1px solid var(--border);font-size:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span>${m.status ? medTagBadge(m.status) : '<span style="color:var(--muted)">No status</span>'} ${m.reason || ""}</span>
          ${todayLabel}
        </div>
        <div style="color:var(--muted);font-size:11px;margin-top:2px">${medDurationLabel(m)}</div>
      </div>`;
    }).join("");
  }

  // ── MSK / Physio section ─────────────────────────────
  // Self-reported via Google Form (separate from medical layer). Shows
  // injury reports + exercise log timeline + whether the case is currently
  // cleared. Helps a sergeant get the full physio picture in one glance.
  const mskRows = STATE.msk.filter(m => m.d4 === d4);
  if (mskRows.length) {
    const tsOf = r => String(r.timestamp || "");
    const injuries = mskRows.filter(r => (r.type || "").toLowerCase().includes("report"))
      .sort((a, b) => tsOf(a) < tsOf(b) ? 1 : -1);
    const exercises = mskRows.filter(r => (r.type || "").toLowerCase().includes("log") || (r.type || "").toLowerCase().includes("exercise"))
      .sort((a, b) => tsOf(a) < tsOf(b) ? 1 : -1);
    const allCleared = mskRows.every(r => r.cleared);
    const clearedBadge = allCleared
      ? ` <span class="badge badge-green" style="font-size:9px">CLEARED</span>`
      : ` <span class="badge badge-pink" style="font-size:9px">ACTIVE</span>`;
    html += `<h4 style="font-size:12px;color:var(--muted);margin:16px 0 8px">🦵 MSK / Physio <span style="color:var(--dim);font-weight:400">(${mskRows.length} record${mskRows.length === 1 ? '' : 's'})</span>${clearedBadge}</h4>`;
    if (injuries.length) {
      html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Injury reports</div>`;
      html += injuries.map(r => {
        // Apps Script already formats Date cells as "21 May 2026" — use
        // as-is. Slicing was truncating the last digit of the year.
        const t = r.timestamp || "";
        return `<div style="background:var(--surface2);border-radius:6px;padding:8px 10px;margin-bottom:4px;border-left:2px solid var(--pink);font-size:12px"><div style="color:var(--muted);font-size:10px">${t}</div>${r.description || ""}</div>`;
      }).join("");
    }
    if (exercises.length) {
      html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px">Physio visits</div>`;
      html += exercises.map(r => {
        const d = r.physioDate || r.timestamp || "";
        const exText = r.exercises || `<span style="color:var(--dim)">(no new exercises)</span>`;
        return `<div style="background:var(--surface2);border-radius:6px;padding:8px 10px;margin-bottom:4px;border-left:2px solid var(--teal);font-size:12px"><div style="color:var(--muted);font-size:10px">${d}</div>${exText}</div>`;
      }).join("");
    }
  }

  // ── Polar metrics section ────────────────────────────
  if (computed.length) {
    // Color thresholds: HR ranges follow the existing Polar table convention.
    // Intensity uses standard zone bands (~70 moderate, 80 hard, 90 max).
    const avgHrCol = latest.avgHr > 160 ? 'var(--red)' : latest.avgHr > 140 ? 'var(--orange)' : latest.avgHr ? 'var(--green)' : 'var(--muted)';
    const intCol = latest.intensity >= 90 ? 'var(--red)' : latest.intensity >= 80 ? 'var(--orange)' : latest.intensity >= 70 ? 'var(--yellow)' : latest.intensity ? 'var(--green)' : 'var(--muted)';

    html += `<h4 style="font-size:12px;color:var(--muted);margin:16px 0 8px">Polar Metrics & Progression <span style="color:var(--dim);font-weight:400">(${computed.length} session${computed.length === 1 ? '' : 's'}, latest: ${latest.date || '—'})</span></h4>`;

    html += `<div class="stats-row" style="margin-bottom:10px">
      <div class="stat" title="Latest session average heart rate"><label>Avg HR</label><div class="val" style="color:${avgHrCol};font-size:17px">${latest.avgHr || '—'}</div></div>
      <div class="stat" title="Latest session peak heart rate"><label>Max HR</label><div class="val" style="color:var(--red);font-size:17px">${latest.maxHr || '—'}</div></div>
      <div class="stat" title="Calories burned latest session"><label>kcal</label><div class="val" style="color:var(--orange);font-size:17px">${latest.calories || '—'}</div></div>
      <div class="stat" title="kcal / avg HR — output per heartbeat"><label>Efficiency</label><div class="val" style="color:var(--teal);font-size:17px">${latest.efficiency || '—'}</div></div>
      <div class="stat" title="avg HR / max HR — how close to ceiling"><label>Intensity</label><div class="val" style="color:${intCol};font-size:17px">${latest.intensity ? latest.intensity + '%' : '—'}</div></div>
      <div class="stat" title="avg HR × duration — total cardiac load"><label>Workload</label><div class="val" style="color:var(--purple);font-size:17px">${latest.workload || '—'}</div></div>
    </div>`;

    html += `<div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:12px;line-height:1.55">
      <div><strong style="color:var(--teal)">Efficiency</strong> = kcal ÷ avg HR. Rising over time means more output per heartbeat — improving conditioning.</div>
      <div><strong style="color:var(--yellow)">Intensity</strong> = avg HR ÷ max HR (%). How close to their ceiling they worked. &lt;70% easy, 70–80% moderate, 80–90% hard, &gt;90% max effort.</div>
      <div><strong style="color:var(--pink)">Recovery</strong> = max HR trend across identical sessions. A declining max HR at the same workload suggests improved fitness <em>or</em> fatigue/overtraining — context matters.</div>
      <div><strong style="color:var(--purple)">Workload</strong> = avg HR × duration (min). Total cardiac load — useful for tracking weekly load and periodisation.</div>
    </div>`;

    html += `<div class="grid-2" style="gap:10px">
      <div class="card" style="padding:10px;margin:0"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">Heart Rate (avg vs max)</div><div class="chart-box"><canvas id="pm-hr"></canvas></div></div>
      <div class="card" style="padding:10px;margin:0"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">Calories (kcal)</div><div class="chart-box"><canvas id="pm-cal"></canvas></div></div>
      <div class="card" style="padding:10px;margin:0"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">Efficiency (kcal / avg HR)</div><div class="chart-box"><canvas id="pm-eff"></canvas></div></div>
      <div class="card" style="padding:10px;margin:0"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">Intensity (avg / max %)</div><div class="chart-box"><canvas id="pm-int"></canvas></div></div>
      <div class="card" style="padding:10px;margin:0;grid-column:span 2"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">Workload (avg HR × min)</div><div class="chart-box tall"><canvas id="pm-wl"></canvas></div></div>
    </div>`;
  }

  openModal(p.name, html);
  // Wide modal: this view is chart-heavy and needs more horizontal room than
  // the default form-sized modal.
  document.querySelector(".modal")?.classList.add("wide");

  // Charts need to be created after modal contents are in the DOM.
  setTimeout(() => {
    const ipptCanvas = document.getElementById("person-ippt-chart");
    if (ipptCanvas && ippts.length) {
      new Chart(ipptCanvas, {
        type: "line",
        data: { labels: ippts.map(i => "#" + i.attempt), datasets: [{ data: ippts.map(i => +i.score), borderColor: "#D29922", backgroundColor: "#D2992233", fill: true, tension: .3, pointRadius: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, grid: { color: "#30363D" } }, x: { grid: { color: "#30363D" } } } }
      });
    }

    if (computed.length) {
      // Short labels — drop the year so the x-axis stays readable in a small canvas.
      const labels = computed.map(c => {
        const parts = (c.date || "").split(" ");
        return parts.length >= 2 ? parts.slice(0, 2).join(" ") : (c.date || "");
      });
      // maintainAspectRatio: false → fill the .chart-box wrapper's fixed height
      // instead of growing the canvas indefinitely with container width.
      const axisBase = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => computed[items[0].dataIndex]?.conduct || labels[items[0].dataIndex] } } },
        scales: {
          y: { grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 9 } } },
          x: { grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 9 }, maxRotation: 0, autoSkip: true } }
        }
      };

      new Chart(document.getElementById("pm-hr"), {
        type: "line",
        data: { labels, datasets: [
          { label: "Avg HR", data: computed.map(c => c.avgHr), borderColor: "#58A6FF", backgroundColor: "#58A6FF22", tension: .3, pointRadius: 3 },
          { label: "Max HR", data: computed.map(c => c.maxHr), borderColor: "#F85149", backgroundColor: "#F8514922", tension: .3, pointRadius: 3 }
        ] },
        options: { ...axisBase, plugins: { ...axisBase.plugins, legend: { display: true, position: "bottom", labels: { color: "#8B949E", font: { size: 9 }, boxWidth: 10 } } } }
      });

      new Chart(document.getElementById("pm-cal"), {
        type: "line",
        data: { labels, datasets: [{ data: computed.map(c => c.calories), borderColor: "#D29922", backgroundColor: "#D2992233", fill: true, tension: .3, pointRadius: 3 }] },
        options: axisBase
      });

      new Chart(document.getElementById("pm-eff"), {
        type: "line",
        data: { labels, datasets: [{ data: computed.map(c => c.efficiency), borderColor: "#39D2C0", backgroundColor: "#39D2C033", fill: true, tension: .3, pointRadius: 3 }] },
        options: axisBase
      });

      new Chart(document.getElementById("pm-int"), {
        type: "line",
        data: { labels, datasets: [{ data: computed.map(c => c.intensity), borderColor: "#E3B341", backgroundColor: "#E3B34133", fill: true, tension: .3, pointRadius: 3 }] },
        options: { ...axisBase, scales: { ...axisBase.scales, y: { min: 0, max: 100, grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 9 }, callback: v => v + '%' } } } }
      });

      new Chart(document.getElementById("pm-wl"), {
        type: "bar",
        data: { labels, datasets: [{ data: computed.map(c => c.workload), backgroundColor: "#BC8CFF44", borderColor: "#BC8CFF", borderWidth: 1 }] },
        options: axisBase
      });
    }
  }, 100);
}

// Inline expand under the RSIs stat — shows day-of-week, status mix, timeline,
// and top reasons. A PC checking "is this guy gaming the system?" gets the
// answer at a glance: Mondays + always-NIL → suspicious; mixed days + LD/MC
// with real diagnoses → genuine pattern.
function toggleReportSickPatterns(d4) {
  const panel = document.getElementById("rs-patterns");
  if (!panel) return;
  if (panel.style.display !== "none") { panel.style.display = "none"; panel.innerHTML = ""; return; }

  const med = STATE.medical.filter(m => m.d4 === d4);
  if (!med.length) return;

  // Day-of-week distribution. The "report sick" date is what matters here —
  // not the MC start date, which can shift forward by a day.
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dow = [0, 0, 0, 0, 0, 0, 0];
  med.forEach(m => {
    const iso = displayDateToISO(m.date);
    if (!iso) return;
    dow[new Date(iso).getDay()]++;
  });
  const maxDow = Math.max(...dow, 1);

  // Status mix — reveals "always NIL" (malingering signal) vs real MC/LD pattern.
  const statusCounts = {};
  med.forEach(m => { const k = m.status || "—"; statusCounts[k] = (statusCounts[k] || 0) + 1; });
  const statusOrder = ["MC", "Warded", "LD", "RMJ", "Excuse Heavy Load", "Excuse Kneeling", "Excuse Squatting", "Excuse Uniform", "Excuse RMJ", "Excuse Swimming", "Excuse Prolonged Standing", "Excuse Upper Limb", "Excuse Lower Limb", "Pending", "NIL"];
  const statusRows = statusOrder.filter(s => statusCounts[s]).map(s => [s, statusCounts[s]]);
  const nilPct = med.length ? Math.round((statusCounts["NIL"] || 0) / med.length * 100) : 0;

  // Avg gap between report-sick events — accelerating frequency is a signal.
  const isoDates = med.map(m => displayDateToISO(m.date)).filter(Boolean).sort();
  const gaps = [];
  for (let i = 1; i < isoDates.length; i++) {
    gaps.push(Math.round((new Date(isoDates[i]) - new Date(isoDates[i - 1])) / 86400000));
  }
  const avgGap = gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null;
  const lastGap = gaps.length ? gaps[gaps.length - 1] : null;

  // Top reasons (case-insensitive grouping; show original casing of first occurrence).
  const reasonMap = {};
  med.forEach(m => {
    const key = (m.reason || "").trim().toLowerCase();
    if (!key) return;
    if (!reasonMap[key]) reasonMap[key] = { display: (m.reason || "").trim(), count: 0 };
    reasonMap[key].count++;
  });
  const topReasons = Object.values(reasonMap).sort((a, b) => b.count - a.count).slice(0, 6);

  // Timeline: each report-sick as a dot on a date axis, colored by status.
  const tlPoints = med
    .map(m => ({ iso: displayDateToISO(m.date), status: m.status || "—", reason: m.reason || "" }))
    .filter(p => p.iso)
    .sort((a, b) => a.iso < b.iso ? -1 : 1);

  const statusColor = {
    "MC": "#F85149", "Warded": "#F85149",
    "LD": "#D29922", "RMJ": "#D29922",
    "Excuse Heavy Load": "#E3B341", "Excuse Kneeling": "#E3B341", "Excuse Squatting": "#E3B341", "Excuse Uniform": "#E3B341", "Excuse RMJ": "#E3B341", "Excuse Swimming": "#E3B341", "Excuse Prolonged Standing": "#E3B341", "Excuse Upper Limb": "#E3B341", "Excuse Lower Limb": "#E3B341",
    "Pending": "#8B949E", "NIL": "#39D353", "—": "#6E7681"
  };

  const dowBars = dow.map((c, i) => {
    const h = Math.round((c / maxDow) * 80);
    // Flag Mon (1) prominently if it's the modal day and there are ≥3 entries.
    const isMonPeak = i === 1 && c === maxDow && c >= 3;
    const color = isMonPeak ? "var(--red)" : c === maxDow && c > 0 ? "var(--orange)" : "var(--accent)";
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
      <div style="font-size:10px;color:var(--muted);height:12px">${c || ""}</div>
      <div style="width:100%;background:${color};height:${h}px;min-height:${c ? 2 : 0}px;border-radius:3px 3px 0 0;opacity:${c ? 1 : .15}"></div>
      <div style="font-size:10px;color:var(--muted)">${dowNames[i]}</div>
    </div>`;
  }).join("");

  const statusBars = statusRows.map(([s, n]) => {
    const pct = Math.round((n / med.length) * 100);
    return `<div style="display:flex;align-items:center;gap:8px;font-size:11px">
      <div style="flex:0 0 110px">${medTagBadge(s)}</div>
      <div style="flex:1;background:var(--surface2);border-radius:3px;height:14px;position:relative;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${statusColor[s] || "var(--accent)"}"></div>
      </div>
      <div class="mono" style="flex:0 0 60px;text-align:right;color:var(--muted)">${n} · ${pct}%</div>
    </div>`;
  }).join("");

  // Detect concerning patterns and surface them as text callouts.
  const flags = [];
  if (nilPct >= 50 && med.length >= 3) flags.push(`<span style="color:var(--red)">⚠ ${nilPct}% NIL outcomes</span> — MO frequently finds nothing wrong`);
  if (dow[1] === maxDow && dow[1] >= 3) flags.push(`<span style="color:var(--orange)">⚠ Monday-heavy</span> — ${dow[1]} of ${med.length} on Mondays`);
  if (lastGap !== null && avgGap !== null && lastGap < avgGap / 2 && gaps.length >= 2) flags.push(`<span style="color:var(--orange)">⚠ Accelerating</span> — last gap ${lastGap}d vs avg ${avgGap}d`);

  panel.innerHTML = `
    <div class="card" style="margin:8px 0 16px;padding:14px;border-left:3px solid var(--accent)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:13px">Report Sick Patterns <span style="color:var(--dim);font-weight:400;font-size:11px">(${med.length} events${avgGap !== null ? ` · avg ${avgGap}d apart` : ""})</span></h3>
        <button class="btn btn-icon" onclick="toggleReportSickPatterns('${d4}')" title="Close">✕</button>
      </div>
      ${flags.length ? `<div style="background:var(--surface2);border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:11px;line-height:1.7">${flags.join("<br>")}</div>` : ""}
      <div class="grid-2" style="gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Day of Week</div>
          <div style="display:flex;gap:4px;align-items:flex-end;height:110px">${dowBars}</div>
        </div>
        <div>
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Status Mix</div>
          <div style="display:flex;flex-direction:column;gap:5px">${statusBars}</div>
        </div>
      </div>
      ${tlPoints.length ? `<div style="margin-top:14px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Timeline <span style="color:var(--dim);text-transform:none;letter-spacing:0">(first → last, color = status)</span></div>
        <div class="chart-box" style="height:80px"><canvas id="rs-timeline"></canvas></div>
      </div>` : ""}
      ${topReasons.length ? `<div style="margin-top:14px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Top Reasons</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${topReasons.map(r => `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:11px"><span style="color:var(--text)">${r.display}</span> <span class="mono" style="color:var(--accent);font-weight:700;margin-left:4px">×${r.count}</span></div>`).join("")}
        </div>
      </div>` : ""}
    </div>
  `;
  panel.style.display = "";

  setTimeout(() => {
    const tlCanvas = document.getElementById("rs-timeline");
    if (!tlCanvas || !tlPoints.length) return;
    new Chart(tlCanvas, {
      type: "scatter",
      data: { datasets: [{
        data: tlPoints.map(p => ({ x: new Date(p.iso).getTime(), y: 0, _status: p.status, _reason: p.reason, _iso: p.iso })),
        backgroundColor: tlPoints.map(p => statusColor[p.status] || "#6E7681"),
        borderColor: tlPoints.map(p => statusColor[p.status] || "#6E7681"),
        pointRadius: 7, pointHoverRadius: 9
      }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => { const p = c.raw; const d = new Date(p.x); return `${d.toLocaleDateString()} — ${p._status}${p._reason ? ": " + p._reason : ""}`; } } }
        },
        scales: {
          y: { display: false, min: -1, max: 1 },
          x: { type: "linear", grid: { color: "#30363D" }, ticks: { color: "#8B949E", font: { size: 9 }, callback: v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth() + 1}`; } } }
        }
      }
    });
  }, 50);
}

// ─── FORM OPENERS + SUBMITTERS ─────────────────────────

// Validation strategy: every form is wrapped in <form onsubmit> so HTML5
// constraint validation (required, min, max, type=date/time) runs before our
// JS. Cross-field rules (e.g. participating ≤ total) are checked in submit*.
//
// Edit mode: open*Form(id) pre-fills the form from the existing entry. A hidden
// f-entry-id input carries the id through to submit*, which then replaces the
// row instead of pushing a new one. Edits stay local — sheet sync only auto-
// appends new rows; edited rows wait for a manual "Push to Sheet" to avoid
// duplicating rows in the sheet.

// Small banner shown in edit mode to remind users that edits don't auto-sync.
const editHint = `<div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin-bottom:4px">Edits save locally. Use the tab's <strong>Push to Sheet</strong> button to sync.</div>`;


// Builds the <option> markup for a medical-status <select>: the standard enum
// (grouped by severity), saved custom statuses, and — when `selected` is a
// one-off status not in any known list — an orphan option so it stays selected.
// Shared by the main status field and every "additional status" row.
function medStatusOptionsHtml(selected = "") {
  const std = MED_STATUS_GROUPS.map(g =>
    `<optgroup label="${g.label}">${g.options.map(o => `<option value="${o}" ${o === selected ? "selected" : ""}>${o}</option>`).join("")}</optgroup>`
  ).join("");
  const customList = STATE.customStatuses || [];
  const custom = customList.length
    ? `<optgroup label="Custom">${customList.map(c => `<option value="${escapeAttr(c.name)}" ${c.name === selected ? "selected" : ""}>${escapeAttr(c.name)}${c.participates ? " (participates)" : ""}</option>`).join("")}</optgroup>`
    : "";
  const known = new Set([...MED_STATUSES, ...customList.map(c => c.name)]);
  const orphan = (selected && !known.has(selected))
    ? `<optgroup label="Current"><option value="${escapeAttr(selected)}" selected>${escapeAttr(selected)}</option></optgroup>`
    : "";
  return `<option value="">Select status...</option>${std}${custom}${orphan}`;
}

// Appends an "additional status" row to the medical form so one report-sick
// entry can carry several statuses (e.g. "2D LD" + "4D Excuse RMJ"), each with
// its own duration. On submit these become sibling Medical rows sharing the
// recruit/date/reason/location — which the parade state + dashboard already
// group under one person. Optional args pre-fill the row when editing.
let _medExtraIdx = 0;
function addMedStatusRow(status = "", startIso = null, endIso = null) {
  const host = document.getElementById("f-extra-statuses");
  if (!host) return;
  // Subsequent statuses usually share the previous one's duration, so default
  // the dates to the status directly above (the last extra row, or the main
  // status fields if this is the first extra). Passing explicit dates overrides.
  if (startIso === null || endIso === null) {
    const rows = host.querySelectorAll(".med-extra-row");
    const last = rows.length ? rows[rows.length - 1] : null;
    const prevStart = last ? (last.querySelector(".f-extra-start")?.value || "") : gv("f-start");
    const prevEnd = last ? (last.querySelector(".f-extra-end")?.value || "") : gv("f-end");
    if (startIso === null) startIso = prevStart;
    if (endIso === null) endIso = prevEnd;
  }
  _medExtraIdx++;
  const row = document.createElement("div");
  row.className = "med-extra-row";
  row.style.cssText = "display:flex;flex-direction:column;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px";
  row.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:11px;color:var(--muted);font-weight:600">Additional status</span>
      <button type="button" class="btn btn-icon btn-danger" title="Remove this status" onclick="this.closest('.med-extra-row').remove()">✕</button>
    </div>
    <div class="form-group"><label>Status</label>
      <select class="f-extra-status" required onchange="medExtraStatusChanged(this)">
        ${medStatusOptionsHtml(status)}
        <option value="__new__">＋ New custom status…</option>
      </select>
    </div>
    <div class="f-extra-custom" style="display:none;flex-direction:column;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px">
      <div class="form-group"><label>New status name</label><input class="f-extra-custom-name" type="text" maxlength="40" placeholder="e.g. Excuse Finger"></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" class="f-extra-custom-participates" style="width:15px;height:15px"> Still participates in conducts</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" class="f-extra-custom-save" checked style="width:15px;height:15px"> Save for reuse <span style="color:var(--dim)">(adds it to the dropdowns)</span></label>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Start (inclusive)</label><input type="date" class="f-extra-start" value="${startIso}" min="2020-01-01" max="2099-12-31"></div>
      <div class="form-group"><label>End (inclusive)</label><input type="date" class="f-extra-end" value="${endIso}" min="2020-01-01" max="2099-12-31"></div>
    </div>`;
  host.appendChild(row);
}

// Reveal a row's custom-status fields only when "＋ New custom status…" is picked.
function medExtraStatusChanged(sel) {
  const wrap = sel.closest(".med-extra-row")?.querySelector(".f-extra-custom");
  if (wrap) wrap.style.display = sel.value === "__new__" ? "flex" : "none";
}

function openMedicalForm(id) {
  const e = id ? STATE.medical.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  const startVal = e ? displayDateToISO(e.startDate) || dateVal : todayISO();
  const endVal = e ? displayDateToISO(e.endDate) || "" : "";
  const selectedStatus = e?.status || "";
  _medExtraIdx = 0;
  openModal(e ? "Edit Report Sick Entry" : "Log Report Sick", `
    <form onsubmit="event.preventDefault(); submitMedical(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formField("f-date", "Date Reported Sick", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        ${formField("f-reason", "Reason", "text", "Fever, sore throat...", `required maxlength="200" value="${escapeAttr(e?.reason)}"`)}
        ${formField("f-location", "Location (only if reported sick outside)", "text", "e.g. Lim Clinic and Surgery", `maxlength="200" value="${escapeAttr(e?.location)}"`)}
        <div class="form-group">
          <label>Status</label>
          <select id="f-status" required onchange="medStatusSelChanged(this.value)">
            ${medStatusOptionsHtml(selectedStatus)}
            <option value="__new__">＋ New custom status…</option>
          </select>
        </div>
        <div id="f-custom-wrap" style="display:none;flex-direction:column;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px">
          ${formField("f-custom-name", "New status name", "text", "e.g. Excuse Finger", `maxlength="40"`)}
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" id="f-custom-participates" style="width:15px;height:15px"> Still participates in conducts <span style="color:var(--dim)">(wizard won't auto-mark as out)</span></label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" id="f-custom-save" checked style="width:15px;height:15px"> Save for reuse <span style="color:var(--dim)">(adds it to this dropdown)</span></label>
          <div style="font-size:10px;color:var(--muted)">Custom statuses are in-camp/restricted and don't get +1/+2 recovery tags.</div>
        </div>
        <label id="f-incamp-wrap" style="display:${(selectedStatus === "MC" || selectedStatus === "Warded") ? "flex" : "none"};align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" id="f-incamp" ${e?.inCamp ? "checked" : ""} style="width:15px;height:15px"> Consume in camp <span style="color:var(--dim)">(stays in camp; counted in strength, listed under MEDICAL STATUS not ATTC)</span></label>
        <div class="form-row">
          ${formField("f-start", "Start (inclusive)", "date", "", `value="${startVal}" min="2020-01-01" max="2099-12-31"`)}
          ${formField("f-end", "End (inclusive)", "date", "", `value="${endVal}" min="2020-01-01" max="2099-12-31"`)}
        </div>
        <div style="font-size:10px;color:var(--muted)">Start and end dates can be left blank for <strong>Pending</strong> (MO outcome unknown) and <strong>NIL</strong> (MO cleared, no status). Required for everything else.</div>
        <div id="f-extra-statuses" style="display:flex;flex-direction:column;gap:8px"></div>
        <button type="button" class="btn" style="font-size:11px;align-self:flex-start" onclick="addMedStatusRow()">＋ Add another status</button>
        <div style="font-size:10px;color:var(--muted)">Use this when the MO gives more than one status for the same visit (e.g. <strong>2D LD</strong> + <strong>4D Excuse RMJ</strong>). Each status keeps its own duration.</div>
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
}
// Reveal the custom-status fields only when "＋ New custom status…" is picked.
function medStatusSelChanged(v) {
  const wrap = document.getElementById("f-custom-wrap");
  if (wrap) wrap.style.display = v === "__new__" ? "flex" : "none";
  // "Consume in camp" is only meaningful for the away statuses (MC/Warded) —
  // everything else is already in camp. Hide + clear it otherwise.
  const inCampWrap = document.getElementById("f-incamp-wrap");
  const inCampBox = document.getElementById("f-incamp");
  const showInCamp = v === "MC" || v === "Warded";
  if (inCampWrap) inCampWrap.style.display = showInCamp ? "flex" : "none";
  if (inCampBox && !showInCamp) inCampBox.checked = false;
}

function submitMedical() {
  const editId = +gv("f-entry-id");
  let status = gv("f-status");
  // Resolve a freshly-created custom status: use the typed name as the status,
  // and (optionally) persist it to the reusable list with its participates flag.
  if (status === "__new__") {
    const name = gv("f-custom-name").trim();
    if (!name) { alert("Enter a name for the new custom status."); return; }
    const participates = !!document.getElementById("f-custom-participates")?.checked;
    if (document.getElementById("f-custom-save")?.checked) addCustomStatus(name, participates);
    status = name;
  }
  // Gather the main status plus any "additional status" rows. Each carries its
  // own status + duration; they share the recruit/date/reason/location below.
  const statuses = [{ status, startIso: gv("f-start"), endIso: gv("f-end") }];
  for (const row of document.querySelectorAll("#f-extra-statuses .med-extra-row")) {
    let s = row.querySelector(".f-extra-status")?.value || "";
    if (!s) continue; // ignore a blank row rather than erroring
    // Resolve a per-row freshly-created custom status, same as the main field.
    if (s === "__new__") {
      const name = (row.querySelector(".f-extra-custom-name")?.value || "").trim();
      if (!name) { alert("Enter a name for the new custom status."); return; }
      const participates = !!row.querySelector(".f-extra-custom-participates")?.checked;
      if (row.querySelector(".f-extra-custom-save")?.checked) addCustomStatus(name, participates);
      s = name;
    }
    statuses.push({
      status: s,
      startIso: row.querySelector(".f-extra-start")?.value || "",
      endIso: row.querySelector(".f-extra-end")?.value || ""
    });
  }

  const noDurationStatuses = ["Pending", "NIL"];
  for (const st of statuses) {
    if (!st.status) { alert("Select a status for every row (or remove the empty one)."); return; }
    if (!noDurationStatuses.includes(st.status) && !st.endIso) { alert(`End date is required for "${st.status}" (only Pending and NIL may be left blank).`); return; }
    if (st.endIso && st.startIso && st.endIso < st.startIso) { alert(`End date cannot be before start date for "${st.status}".`); return; }
  }

  const d4 = gv("f-d4");
  const date = isoToDisplayDate(gv("f-date"));
  const reason = gv("f-reason");
  const location = gv("f-location").trim();
  // Consume-in-camp applies to the PRIMARY status only (an additional LD/Excuse
  // row is already in camp). The checkbox only shows for MC/Warded, so guard on
  // the resolved primary status too in case a stale checked box lingers.
  const inCamp = !!document.getElementById("f-incamp")?.checked
    && (status === "MC" || status === "Warded");

  // First status reuses the edited row's id; each extra status becomes a new
  // sibling row. Siblings group automatically per-recruit in the reports.
  const records = statuses.map((st, i) => ({
    id: (i === 0 && editId) ? editId : nextId(),
    d4, date, reason, location,
    status: st.status,
    startDate: isoToDisplayDate(st.startIso),
    endDate: st.endIso ? isoToDisplayDate(st.endIso) : "",
    inCamp: i === 0 ? inCamp : false
  }));

  records.forEach((rec, i) => {
    if (i === 0 && editId) {
      const idx = STATE.medical.findIndex(m => m.id === editId);
      if (idx >= 0) STATE.medical[idx] = rec; else STATE.medical.push(rec);
    } else {
      STATE.medical.push(rec);
    }
  });

  // Roster status mirrors the primary (first) status, as before.
  let rosterEdit = null;
  const main = records[0];
  if (main.d4 && main.status) {
    const r = STATE.roster.find(x => x.id === main.d4);
    if (r) { r.status = main.status; rosterEdit = r; }
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) {
    records.forEach(rec => autoSync("Medical", { type: "upsert", row: rec }));
    // Status field on the roster row also changes — push that update too,
    // otherwise the recruit's roster row goes out of sync until next pull.
    if (rosterEdit) autoSync("Roster", { type: "upsert", row: rosterEdit });
  }
}

function openAttendanceForm(id) {
  const e = id ? STATE.attendance.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  const numVal = v => v !== undefined && v !== null ? ` value="${v}"` : "";
  openModal(e ? "Edit Conduct Attendance" : "Log Conduct Attendance", `
    <form onsubmit="event.preventDefault(); submitAttendance(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        ${formField("f-date", "Date", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        <div class="form-group">
          <label>Conduct</label>
          ${conductPicker({ inputId: "f-conductId", selectedId: e?.conductId || "" })}
        </div>
        <div class="form-group">
          <label>Program</label>
          <select id="f-program" class="topbar-select" style="width:100%">
            ${[...STATE.programs.map(p => p.key), PROGRAM_COMBINED].map(key => `<option value="${escapeAttr(key)}" ${progKey(e || {}) === key ? "selected" : ""}>${escapeAttr(programLabel(key))}</option>`).join("")}
          </select>
        </div>
        <div class="form-row">
          ${formField("f-total", "Total Str", "number", "", `required min="0" max="999" step="1"${numVal(e?.total)}`)}
          ${formField("f-part", "Participating", "number", "", `required min="0" max="999" step="1"${numVal(e?.participating)}`)}
          ${formField("f-lms", "LMS Participation", "number", "", `min="0" max="999" step="1" value="${e?.lms ?? 0}"`)}
        </div>
        <div class="form-row">
          ${formField("f-px", "Status (pre-existing medical status)", "number", "", `required min="0" max="999" step="1" value="${e?.px ?? 0}"`)}
          ${formField("f-fallout", "Fallout", "number", "", `required min="0" max="999" step="1" value="${e?.fallout ?? 0}"`)}
        </div>
        <div class="form-group"><label>Remarks (data inconsistencies, recruit flags)</label><textarea id="f-remarks" maxlength="500" rows="2" style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px;resize:vertical" placeholder="e.g. JOHN: HR drop sus; 2 Polar rows missing">${escapeAttr(e?.remarks)}</textarea></div>
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
}
function submitAttendance() {
  const editId = +gv("f-entry-id");
  const total = +gv("f-total"), part = +gv("f-part"), lms = +gv("f-lms"), px = +gv("f-px"), fallout = +gv("f-fallout");
  const conductId = gv("f-conductId");
  if (!conductId) { alert("Pick a conduct (or create a new one from the dropdown)."); return; }
  if (part > total) { alert("Participating cannot exceed total."); return; }
  if (px + fallout > total) { alert("Status + Fallout cannot exceed total."); return; }
  if (lms > part) { alert("LMS Participation cannot exceed Participating."); return; }
  const entry = {
    id: editId || nextId(),
    date: isoToDisplayDate(gv("f-date")),
    conductId,
    program: gv("f-program") || PROGRAM_COMBINED,
    total, participating: part, lms, px, fallout,
    remarks: gv("f-remarks")
  };
  if (editId) {
    const idx = STATE.attendance.findIndex(a => a.id === editId);
    if (idx >= 0) STATE.attendance[idx] = entry;
  } else {
    STATE.attendance.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("Attendance", { type: "upsert", row: entry });
}

function openIPPTForm(id) {
  // 2.4km run is a duration in mm:ss, not a time of day. Native <input type=time>
  // can't do MM:SS-only, so use two number inputs and combine at submit.
  const e = id ? STATE.ippt.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  const [runMinPrefill, runSecPrefill] = (e?.runTime || "").split(":");
  const numVal = v => v !== undefined && v !== null && v !== "" ? ` value="${v}"` : "";
  // Three rep/time inputs all call recomputeIPPTScore() on change so the
  // score field auto-fills as the user types. Recruit picker too — score
  // depends on age-group, which depends on the picked recruit's age.
  const recalcAttr = `oninput="recomputeIPPTScore()" onchange="recomputeIPPTScore()"`;
  openModal(e ? "Edit IPPT Result" : "Add IPPT Result", `
    <form onsubmit="event.preventDefault(); submitIPPT(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div class="form-group"><label>Recruit</label><span onchange="recomputeIPPTScore()">${rosterSelect("f-d4", true, e?.d4 || "")}</span></div>
        ${formSelect("f-attempt", "Attempt", ["1", "2", "3", "4"], true, e?.attempt ? String(e.attempt) : "")}
        ${formField("f-date", "Date", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        <div class="form-row">
          <div class="form-group"><label>Push-ups</label><input id="f-pu" type="number" required min="0" max="99" step="1"${numVal(e?.pushups)} ${recalcAttr}></div>
          <div class="form-group"><label>Sit-ups</label><input id="f-su" type="number" required min="0" max="99" step="1"${numVal(e?.situps)} ${recalcAttr}></div>
          <div class="form-group">
            <label>2.4km Run (min:sec)</label>
            <div style="display:flex;gap:6px;align-items:center">
              <input id="f-run-min" type="number" required min="8" max="30" step="1" placeholder="min"${runMinPrefill ? ` value="${+runMinPrefill}"` : ""} ${recalcAttr}>
              <span style="color:var(--muted)">:</span>
              <input id="f-run-sec" type="number" required min="0" max="59" step="1" placeholder="sec"${runSecPrefill ? ` value="${+runSecPrefill}"` : ""} ${recalcAttr}>
            </div>
          </div>
          <div class="form-group">
            <label>Total Score <span style="font-size:10px;color:var(--muted);font-weight:400">(auto, editable)</span></label>
            <input id="f-score" type="number" required min="0" max="100" step="1"${numVal(e?.score)}>
          </div>
        </div>
        <div id="ippt-score-breakdown" style="font-size:11px;color:var(--muted);padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;line-height:1.5;display:none"></div>
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
  // Wire the recruit picker's change handler (rosterSelect returns a plain
  // <select>, so the wrapping <span onchange> above bubble-catches it).
  // Run an initial recompute so the score is pre-filled when editing.
  setTimeout(recomputeIPPTScore, 0);
}

// Reads the current form inputs + the picked recruit's age, computes the
// IPPT score via the scoring tables, pre-fills the Total Score field, and
// renders a live breakdown below the form. Called on every input/change.
// Falls back gracefully when age is missing or run time is incomplete.
function recomputeIPPTScore() {
  const d4 = gv("f-d4");
  const r = STATE.roster.find(x => x.id === d4);
  const age = r?.age;
  const pu = gv("f-pu");
  const su = gv("f-su");
  const min = gv("f-run-min");
  const sec = gv("f-run-sec");
  const runTime = (min !== "" && sec !== "") ? `${+min}:${String(+sec).padStart(2, "0")}` : "";
  const breakdown = document.getElementById("ippt-score-breakdown");
  if (!breakdown) return;

  if (!age) {
    breakdown.style.display = "block";
    breakdown.innerHTML = `<span style="color:var(--orange)">Auto-calc unavailable:</span> recruit's age not on roster — enter score manually.`;
    return;
  }
  const result = calculateIPPTScore(age, pu, su, runTime);
  if (!result) {
    breakdown.style.display = "block";
    breakdown.innerHTML = `Fill in push-ups, sit-ups, and run time to auto-calculate score (age group ${IPPT_AGE_LABELS[ageGroupForIPPT(age) - 1] || "?"}).`;
    return;
  }
  const scoreField = document.getElementById("f-score");
  if (scoreField) scoreField.value = result.total;
  // If every component is 0, surface "YTT" instead of "N/A"/"Fail" so the form
  // matches the table's YTT tagging convention.
  const ytt = isYTT({ pushups: pu, situps: su, runTime });
  const awardColors = { "Gold★": "var(--purple)", Gold: "var(--yellow)", Silver: "var(--accent)", Pass: "var(--green)", Fail: "var(--red)" };
  const displayAward = ytt ? "YTT" : result.award;
  const awardColor = ytt ? "var(--accent)" : (awardColors[result.award] || "var(--muted)");
  breakdown.style.display = "block";
  breakdown.innerHTML = `
    <div>Age group <strong>${result.ageLabel}</strong> · <span>PU ${result.pushupScore}/25 + SU ${result.situpScore}/25 + Run ${result.runScore}/50</span> = <strong style="color:var(--text)">${result.total}/100</strong> <span style="color:${awardColor};font-weight:700;margin-left:6px">${displayAward}</span></div>
    <div style="font-size:10px;color:var(--dim);margin-top:2px">Tiers: ≥61 Pass · ≥75 Silver · ≥85 Gold · ≥90 Gold★ (NDU / Commando / Guards)</div>
  `;
}
function submitIPPT() {
  const editId = +gv("f-entry-id");
  const runMin = +gv("f-run-min"), runSec = +gv("f-run-sec");
  const runTime = `${String(runMin).padStart(2, "0")}:${String(runSec).padStart(2, "0")}`;
  const entry = {
    id: editId || nextId(), d4: gv("f-d4"),
    attempt: +gv("f-attempt"),
    date: isoToDisplayDate(gv("f-date")),
    pushups: +gv("f-pu"), situps: +gv("f-su"),
    runTime,
    score: +gv("f-score")
  };
  if (editId) {
    const idx = STATE.ippt.findIndex(i => i.id === editId);
    if (idx >= 0) STATE.ippt[idx] = entry;
  } else {
    STATE.ippt.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("IPPT", { type: "upsert", row: entry });
}

function openRMForm(id) {
  // f-time is the wall-clock time the march was completed (e.g. 13:45), not a duration.
  const e = id ? STATE.rm.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  const numVal = v => v !== undefined && v !== null && v !== "" ? ` value="${v}"` : "";
  openModal(e ? "Edit Route March Result" : "Add Route March Result", `
    <form onsubmit="event.preventDefault(); submitRM(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formSelect("f-rm", "RM #", ["1", "2", "3", "4", "5", "6"], true, e?.rmNum ? String(e.rmNum) : "")}
        ${formField("f-date", "Date", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        ${formField("f-time", "Finish Time (hh:mm)", "time", "", `required value="${escapeAttr(e?.time)}"`)}
        <div class="form-row">
          ${formField("f-avghr", "Avg HR", "number", "", `required min="30" max="220" step="1"${numVal(e?.avgHr)}`)}
          ${formField("f-maxhr", "Max HR", "number", "", `required min="30" max="220" step="1"${numVal(e?.maxHr)}`)}
        </div>
        ${formSelect("f-pass", "Pass", [["Y", "Pass"], ["N", "Fail"]], true, e?.pass || "")}
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
}
function submitRM() {
  const editId = +gv("f-entry-id");
  const avgHr = +gv("f-avghr"), maxHr = +gv("f-maxhr");
  if (maxHr < avgHr) { alert("Max HR cannot be lower than Avg HR."); return; }
  const entry = {
    id: editId || nextId(), d4: gv("f-d4"), rmNum: +gv("f-rm"),
    date: isoToDisplayDate(gv("f-date")),
    time: gv("f-time"),
    avgHr, maxHr, pass: gv("f-pass")
  };
  if (editId) {
    const idx = STATE.rm.findIndex(r => r.id === editId);
    if (idx >= 0) STATE.rm[idx] = entry;
  } else {
    STATE.rm.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("RouteMarch", { type: "upsert", row: entry });
}

function openSOCForm(id) {
  const e = id ? STATE.soc.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  const numVal = v => v !== undefined && v !== null && v !== "" ? ` value="${v}"` : "";
  openModal(e ? "Edit SOC Result" : "Add SOC Result", `
    <form onsubmit="event.preventDefault(); submitSOC(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formSelect("f-soc", "SOC #", ["1", "2", "3", "4", "5"], true, e?.socNum ? String(e.socNum) : "")}
        ${formField("f-date", "Date", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        ${formField("f-time", "Completion Time (hh:mm:ss)", "time", "", `required step="1" min="00:04:00" max="00:30:00" value="${escapeAttr(e?.time)}"`)}
        ${formField("f-avghr", "Avg HR", "number", "", `required min="30" max="220" step="1"${numVal(e?.avgHr)}`)}
        ${formSelect("f-pass", "Pass", [["Y", "Pass"], ["N", "Fail"]], true, e?.pass || "")}
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
}
function submitSOC() {
  const editId = +gv("f-entry-id");
  const entry = {
    id: editId || nextId(), d4: gv("f-d4"), socNum: +gv("f-soc"),
    date: isoToDisplayDate(gv("f-date")),
    time: gv("f-time"),
    avgHr: +gv("f-avghr"),
    pass: gv("f-pass")
  };
  if (editId) {
    const idx = STATE.soc.findIndex(s => s.id === editId);
    if (idx >= 0) STATE.soc[idx] = entry;
  } else {
    STATE.soc.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("SOC", { type: "upsert", row: entry });
}

// ─── CSV IMPORTERS ─────────────────────────────────────

function importIPPT(input) {
  Papa.parse(input.files[0], { header: true, skipEmptyLines: true, complete: r => {
    const missing = checkCols(r.meta.fields, ["4D", "Score"]);
    if (missing.length) { alert("CSV missing required columns: " + missing.join(", ") + "\n\nExpected: 4D, Attempt, Date, Push-ups, Sit-ups, 2.4km, Score"); return; }
    r.data.forEach(row => STATE.ippt.push({
      id: nextId(), d4: col(row, "4D", "id"), attempt: colNum(row, "Attempt", "#", "attempt"),
      date: col(row, "Date", "date"), pushups: colNum(row, "Push-ups", "Pushups", "PU", "push-ups"),
      situps: colNum(row, "Sit-ups", "Situps", "SU", "sit-ups"), runTime: col(row, "2.4km", "Run", "RunTime", "run time", "2.4"),
      score: colNum(row, "Score", "Total", "Total Score", "score")
    }));
    saveLocal(); render(); alert(`Imported ${r.data.length} IPPT rows`);
  } }); input.value = "";
}
function importRM(input) {
  Papa.parse(input.files[0], { header: true, skipEmptyLines: true, complete: r => {
    const missing = checkCols(r.meta.fields, ["4D"]);
    if (missing.length) { alert("CSV missing required column: 4D\n\nExpected: 4D, RM, Date, Time, Avg HR, Max HR, Pass"); return; }
    r.data.forEach(row => STATE.rm.push({
      id: nextId(), d4: col(row, "4D", "id"), rmNum: colNum(row, "RM", "RM #", "RM#", "rmNum", "Route March"),
      date: col(row, "Date", "date"), time: col(row, "Time", "Completion Time", "time", "Duration"),
      avgHr: colNum(row, "Avg HR", "AvgHR", "avg_hr", "Average HR", "Heart Rate"),
      maxHr: colNum(row, "Max HR", "MaxHR", "max_hr", "Maximum HR"),
      pass: col(row, "Pass", "pass", "Result", "Status") || "Y"
    }));
    saveLocal(); render(); alert(`Imported ${r.data.length} Route March rows`);
  } }); input.value = "";
}
// Normalize a free-text date string to the app's display format ("17 May 2026")
// so CSV-imported rows match form-entered rows on the date half of any
// (date, conductId) join. Round-trips through displayDateToISO + isoToDisplayDate
// — if the input is unparseable, falls back to the raw string.
function normalizeDateToDisplay(raw) {
  if (!raw) return "";
  const iso = displayDateToISO(raw);
  if (iso) return isoToDisplayDate(iso);
  // Try direct Date parsing (e.g. ISO "2026-05-17" not caught by displayDateToISO).
  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const displayed = isoToDisplayDate(`${yyyy}-${mm}-${dd}`);
    if (displayed) return displayed;
  }
  return raw;
}

// Holds an in-flight CSV polar import while the user resolves any unknown
// conduct names. Each entry: { rawRows: [parsed CSV rows], unknownConducts:
// [{name, count}], rawConductByRowIdx: [conductName per row] }.
let _polarImportPending = null;

function importPolar(input) {
  Papa.parse(input.files[0], { header: true, skipEmptyLines: true, complete: r => {
    const missing = checkCols(r.meta.fields, ["4D"]);
    if (missing.length) { alert("CSV missing required column: 4D"); return; }
    // Pre-resolve each row's conduct against the registry. Group unknowns by
    // normalized key so the modal only asks the user once per distinct name.
    const rawRows = r.data;
    const rawConductByRowIdx = rawRows.map(row => col(row, "Conduct", "Activity", "conduct", "Exercise") || "");
    const unknownsByKey = new Map(); // key -> {name (canonical raw), count}
    rawConductByRowIdx.forEach(name => {
      if (!name) return;
      if (conductIdByName(name)) return;
      const key = normalizeConductKey(name);
      if (!unknownsByKey.has(key)) unknownsByKey.set(key, { name, count: 0 });
      unknownsByKey.get(key).count++;
    });
    const unknownConducts = [...unknownsByKey.values()].sort((a, b) => b.count - a.count);

    _polarImportPending = { rawRows, rawConductByRowIdx, unknownConducts };
    if (unknownConducts.length > 0) {
      openUnknownPolarConductsModal();
    } else {
      finalizePolarImport({});
    }
  } }); input.value = "";
}

// Modal: for each conduct name in the CSV that doesn't match the registry,
// ask the user to either (a) merge into an existing conduct, or (b) create
// a new conduct with this name. Maps are keyed by normalized name so the
// finalize step can look up every row's resolution in one pass.
function openUnknownPolarConductsModal() {
  const { unknownConducts } = _polarImportPending;
  const opts = getAllConducts();
  openModal(`Resolve ${unknownConducts.length} new conduct${unknownConducts.length === 1 ? "" : "s"} from CSV`, `
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px">
      The CSV uses conduct names that aren't in your registry yet. For each one, pick an
      existing conduct to merge it into, or create a new conduct with this name.
    </p>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow-y:auto">
      ${unknownConducts.map((u, i) => `
        <div class="card" style="padding:8px 12px;background:var(--surface2)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px">
            <code style="font-family:var(--mono);font-size:12px;color:var(--text)">"${escapeAttr(u.name)}"</code>
            <span style="font-size:11px;color:var(--muted)">${u.count} row${u.count === 1 ? "" : "s"}</span>
          </div>
          <select id="polar-resolve-${i}" data-key="${escapeAttr(normalizeConductKey(u.name))}" style="width:100%;padding:5px 8px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:12px">
            <option value="__new__" selected>+ Create new conduct: "${escapeAttr(u.name)}"</option>
            ${opts.map(c => `<option value="${c.id}">→ Merge into "${escapeAttr(c.name)}"</option>`).join("")}
          </select>
        </div>
      `).join("")}
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="btn" onclick="cancelPolarImport()">Cancel import</button>
      <button class="btn btn-success" onclick="confirmPolarConductResolutions()">Continue import</button>
    </div>
  `);
}

function cancelPolarImport() {
  _polarImportPending = null;
  closeModal();
}

function confirmPolarConductResolutions() {
  const { unknownConducts } = _polarImportPending;
  // Build keyResolutions: normalizeConductKey(unknown) → conductId
  const keyResolutions = {};
  unknownConducts.forEach((u, i) => {
    const sel = document.getElementById(`polar-resolve-${i}`);
    if (!sel) return;
    const key = sel.dataset.key;
    if (sel.value === "__new__") {
      keyResolutions[key] = createConduct(u.name);
    } else {
      keyResolutions[key] = sel.value;
    }
  });
  closeModal();
  finalizePolarImport(keyResolutions);
}

// Walks the staged rows and pushes them onto STATE.polar with resolved
// conductIds + normalized dates. keyResolutions covers the unknowns;
// the rest resolve directly via the registry.
function finalizePolarImport(keyResolutions) {
  const { rawRows, rawConductByRowIdx } = _polarImportPending;
  const insertedRows = [];
  rawRows.forEach((row, idx) => {
    const rawConduct = rawConductByRowIdx[idx];
    const conductId = conductIdByName(rawConduct) || keyResolutions[normalizeConductKey(rawConduct)] || "";
    const entry = {
      id: nextId(),
      d4: col(row, "4D", "id"),
      conductId,
      date: normalizeDateToDisplay(col(row, "Date", "date")),
      avgHr: colNum(row, "Avg HR", "AvgHR", "avg_hr", "Average HR"),
      maxHr: colNum(row, "Max HR", "MaxHR", "max_hr"),
      minHr: colNum(row, "Min HR", "MinHR", "min_hr"),
      calories: colNum(row, "Calories", "Cal", "calories", "Energy"),
      trainingLoad: colNum(row, "Training Load", "TrainingLoad", "training_load", "Load"),
      duration: colNum(row, "Duration", "duration", "Time", "Dur"),
      distance: colNum(row, "Distance", "distance", "Dist")
    };
    STATE.polar.push(entry);
    insertedRows.push(entry);
  });
  _polarImportPending = null;
  const lmsChangedRows = recomputeAttendanceLmsFromPolar();
  saveLocal(); render();
  // Auto-push the new rows. Previously the user had to navigate to PolarFlow
  // tab and click Push to Sheet manually — exactly the kind of tab-switching
  // this redesign eliminates.
  if (STATE.apiUrl && insertedRows.length) {
    autoSync("PolarFlow", { type: "appendMany", rows: insertedRows });
    // Push each attendance row whose LMS changed as a granular upsert. (Was a
    // full-tab replace — but a stale replace conflicts and silently drops the
    // backfill; per-row upserts merge under OCC and never clobber other edits.)
    lmsChangedRows.forEach(row => autoSync("Attendance", { type: "upsert", row }));
  }
  alert(`Imported ${insertedRows.length} Polar rows${lmsChangedRows.length ? `\nUpdated LMS on ${lmsChangedRows.length} attendance row${lmsChangedRows.length === 1 ? "" : "s"}.` : ""}\n\nSyncing to sheet — check the sidebar indicator for status.`);
}
function openConductDetailForm(id) {
  const e = id ? STATE.conductDetail.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  openModal(e ? "Edit Conduct Detail" : "Log Conduct Detail", `
    <form onsubmit="event.preventDefault(); submitConductDetail(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        ${formField("f-date", "Date", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        ${formField("f-time", "Time (optional)", "text", "0730", `maxlength="10" value="${escapeAttr(e?.time)}"`)}
        <div class="form-group">
          <label>Conduct</label>
          ${conductPicker({ inputId: "f-conductId", selectedId: e?.conductId || "" })}
        </div>
        <div class="form-group">
          <label>Program</label>
          <select id="f-program" class="topbar-select" style="width:100%">
            ${[...STATE.programs.map(p => p.key), PROGRAM_COMBINED].map(key => `<option value="${escapeAttr(key)}" ${progKey(e || {}) === key ? "selected" : ""}>${escapeAttr(programLabel(key))}</option>`).join("")}
          </select>
        </div>
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formSelect("f-type", "Type", [["PX", "Status (pre-existing medical status)"], ["Fallout", "Fallout (dropped out, no MO visit)"], ["RSI", "RSI (reported sick at first parade)"], ["ReportSick", "Report Sick (fallout → went to MO)"]], true, e?.type || "")}
        ${formField("f-reason", "Reason", "text", "Sprained ankle / Fever / Shin splint...", `required maxlength="200" value="${escapeAttr(e?.reason)}"`)}
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
}
function submitConductDetail() {
  const editId = +gv("f-entry-id");
  const conductId = gv("f-conductId");
  if (!conductId) { alert("Pick a conduct (or create a new one from the dropdown)."); return; }
  const entry = {
    id: editId || nextId(),
    date: isoToDisplayDate(gv("f-date")),
    time: pad4Time(gv("f-time")),
    conductId,
    program: gv("f-program") || PROGRAM_COMBINED,
    d4: gv("f-d4"),
    type: gv("f-type"),
    reason: gv("f-reason")
  };
  if (editId) {
    const idx = STATE.conductDetail.findIndex(d => d.id === editId);
    if (idx >= 0) STATE.conductDetail[idx] = entry;
  } else {
    STATE.conductDetail.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("ConductDetail", { type: "upsert", row: entry });
}

function openAppointmentForm(id, prefill) {
  // `prefill` is only honored when not editing — used by the MSK widget's
  // Book button to pre-populate d4/reason/location without typing.
  const isEdit = !!id;
  const e = isEdit ? STATE.appointments.find(x => x.id === id) : (prefill || null);
  const dateVal = e?.date ? (displayDateToISO(e.date) || todayISO()) : todayISO();
  openModal(isEdit ? "Edit Appointment" : "Book Appointment", `
    <form onsubmit="event.preventDefault(); submitAppointment(); return false">
      <input type="hidden" id="f-entry-id" value="${isEdit ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${isEdit ? editHint : ""}
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formField("f-reason", "Reason", "text", "Knee specialist review / IPPT retake / Board…", `required maxlength="200" value="${escapeAttr(e?.reason)}"`)}
        <div class="form-row">
          ${formField("f-date", "Date", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
          ${formField("f-time", "Time", "text", "0930", `required maxlength="10" value="${escapeAttr(e?.time)}"`)}
        </div>
        ${formField("f-location", "Location", "text", "MO Office / SAFTI MC / Camp HQ…", `required maxlength="100" value="${escapeAttr(e?.location)}"`)}
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer">
          <input id="f-appt-ooc" type="checkbox" ${e?.outOfCamp ? "checked" : ""} style="width:16px;height:16px;cursor:pointer">
          Out of camp (recruit leaves camp for this appointment)
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer">
          <input id="f-resolved" type="checkbox" ${e?.resolved ? "checked" : ""} style="width:16px;height:16px;cursor:pointer">
          Mark as resolved (hides from dashboard + parade state)
        </label>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Book"}</button>
      </div>
    </form>`);
}
function submitAppointment() {
  const editId = +gv("f-entry-id");
  const entry = {
    id: editId || nextId(),
    d4: gv("f-d4"),
    reason: gv("f-reason"),
    date: isoToDisplayDate(gv("f-date")),
    time: gv("f-time"),
    location: gv("f-location"),
    outOfCamp: document.getElementById("f-appt-ooc")?.checked || false,
    resolved: document.getElementById("f-resolved")?.checked || false
  };
  entry.time = pad4Time(entry.time);
  if (editId) {
    const idx = STATE.appointments.findIndex(a => a.id === editId);
    if (idx >= 0) STATE.appointments[idx] = entry;
  } else {
    STATE.appointments.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("Appointments", { type: "upsert", row: entry });
}

// Toggle clearance on every MSK row for a recruit. Acts as case-level
// clear: if ANY row is still un-cleared we mark them all cleared; if
// they're all already cleared we flip back to active (un-clear). Lets
// sergeants reverse mistakes without going to the sheet.
function toggleMSKCleared(d4) {
  const rows = STATE.msk.filter(m => m.d4 === d4);
  if (!rows.length) return;
  const allCleared = rows.every(m => m.cleared);
  rows.forEach(m => { m.cleared = !allCleared; });
  saveLocal(); render();
}

// Module-scope toggle for the MSK widget's "Show cleared" reveal. Kept
// here so it survives re-renders of the dashboard.
let _mskShowCleared = false;
function toggleMSKShowCleared() {
  _mskShowCleared = !_mskShowCleared;
  render();
}

// Persist a manual body-region tag list on the recruit's latest Report
// Injury row. Reading the regions back uses getMSKRegionsForRecruit which
// prefers manualRegions over the auto-classifier when set.
function setMSKRegions(d4, regions) {
  const reports = STATE.msk
    .filter(m => m.d4 === d4 && (m.type || "").toLowerCase().includes("report"))
    .sort((a, b) => (a.timestamp || "") < (b.timestamp || "") ? 1 : -1);
  if (!reports.length) {
    alert("No injury report on file for this recruit — can't tag regions.");
    return;
  }
  reports[0].manualRegions = regions.join(", ");
  saveLocal(); render();
}

// Modal for editing a recruit's body region tags. Pre-checks current
// regions; on Save, persists via setMSKRegions and re-renders.
function openMSKRegionMenu(d4) {
  const current = getMSKRegionsForRecruit(d4);
  const currentSet = new Set(current);
  const options = MSK_REGION_LIST.map(r => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;background:${currentSet.has(r) ? MSK_REGION_COLORS[r] + "22" : "var(--surface2)"}">
      <input type="checkbox" data-region="${escapeAttr(r)}" ${currentSet.has(r) ? "checked" : ""} style="width:14px;height:14px;cursor:pointer">
      <span style="width:10px;height:10px;border-radius:50%;background:${MSK_REGION_COLORS[r]}"></span>
      <span style="font-size:12px">${r}</span>
    </label>`).join("");

  openModal("Tag injury regions — " + displayPersonLabel(d4), `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.55">
        Pick the body regions this recruit's injury affects. Overrides the auto-classifier. Push to Sheet to persist.
      </div>
      <div id="msk-region-list" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:4px">${options}</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="saveMSKRegionMenu('${d4}')">Save tags</button>
      </div>
    </div>`);
}

function saveMSKRegionMenu(d4) {
  const checked = [...document.querySelectorAll("#msk-region-list input[type=checkbox]:checked")]
    .map(el => el.dataset.region);
  if (!checked.length) {
    alert("Pick at least one region (or use 'Other' for unclassified).");
    return;
  }
  setMSKRegions(d4, checked);
  closeModal();
}

// Inline tick from the dashboard widget — flips the resolved bit. The
// appointment disappears from dashboard/parade state immediately. To un-
// resolve, edit the entry via the pencil icon (visible while it's still
// in the list) or correct via the sheet.
function toggleAppointmentResolved(id) {
  const a = STATE.appointments.find(x => x.id === id);
  if (!a) return;
  a.resolved = !a.resolved;
  saveLocal(); render();
}

// Book a recruit out of / back into camp. The persistent, synced source of truth
// for "physically out of camp now" — drives BOTH the dashboard strength board
// and the parade state (via outOfCampMap). `on` omitted = toggle. `outSince` is
// today's local day so it auto-clears at the start of the next day. MUST sync
// (unlike toggleMSKCleared) so every device + the parade reflect it.
function bookOutToggle(d4, on, reason) {
  const r = STATE.roster.find(x => x.id === d4);
  if (!r) return;
  const today = todayISO();
  if (on === undefined) on = !outOfCampMap(today).has(d4);   // toggle the EFFECTIVE camp state
  if (on) {
    // Book out — manual out for today. Clears any present-override.
    r.outOfCamp = true;
    r.outReason = reason || r.outReason || "Out of camp";
    r.outSince = today;
    r.campIn = false;
    r.campInSince = "";
  } else {
    // Book in — clear any manual book-out. If they'd STILL be out for a medical
    // or leave reason, set a manual present-override so they count in camp today
    // (auto-clears tomorrow); otherwise just return them to the derived state.
    r.outOfCamp = false;
    r.outReason = "";
    r.outSince = "";
    if (derivedCampOut(d4, today)) {
      r.campIn = true;
      r.campInSince = today;
    } else {
      r.campIn = false;
      r.campInSince = "";
    }
  }
  saveLocal(); render();
  if (STATE.apiUrl) autoSync("Roster", { type: "upsert", row: r });
}

// In-camp recruits (commanders excluded, anyone already out skipped) matching a
// book-out scope: "company", "plt:<n>", or "prog:<key>". THE definition of who a
// bulk book-out targets, shared by the picker's live counts and submit.
function bookOutTargets(scope) {
  const outMap = outOfCampMap(todayISO());
  const inCamp = STATE.roster.filter(r => r.role !== "Commander" && !outMap.has(r.id));
  if (scope === "company") return inCamp;
  if (scope && scope.indexOf("plt:") === 0) { const p = scope.slice(4); return inCamp.filter(r => getPlt(r) === p); }
  if (scope && scope.indexOf("prog:") === 0) { const k = scope.slice(5); return inCamp.filter(r => programOf(r) === k); }
  if (scope && scope.indexOf("grp:") === 0) { const g = scope.slice(4); return inCamp.filter(r => recruitInGroup(r, g)); }
  if (scope && scope.indexOf("comb:") === 0) { const set = combinedMemberSet(scope.slice(5)); return inCamp.filter(r => set.has(r.id)); }
  return [];
}

// Inverse of bookOutTargets: recruits in the scope who are currently OUT of camp
// (the ones a bulk Book In can act on). Same scope grammar.
function bookInTargets(scope) {
  const outMap = outOfCampMap(todayISO());
  const out = STATE.roster.filter(r => r.role !== "Commander" && outMap.has(r.id));
  if (scope === "company") return out;
  if (scope && scope.indexOf("plt:") === 0) { const p = scope.slice(4); return out.filter(r => getPlt(r) === p); }
  if (scope && scope.indexOf("prog:") === 0) { const k = scope.slice(5); return out.filter(r => programOf(r) === k); }
  if (scope && scope.indexOf("grp:") === 0) { const g = scope.slice(4); return out.filter(r => recruitInGroup(r, g)); }
  if (scope && scope.indexOf("comb:") === 0) { const set = combinedMemberSet(scope.slice(5)); return out.filter(r => set.has(r.id)); }
  return [];
}

// Bulk book-out for TODAY — mirrors moveToLocation's optimistic + N-upsert
// pattern. Only recruits currently IN camp are affected; anyone already out (MC/
// leave/booked out) is skipped so we never stamp a manual reason over a record.
// Day-scoped (outSince === today) so the whole batch auto-clears tomorrow.
function bookOutMany(d4s, reason) {
  const ids = Array.isArray(d4s) ? d4s : [d4s];
  const today = todayISO();
  const outMap = outOfCampMap(today);
  const booked = [];
  ids.forEach(d4 => {
    const r = STATE.roster.find(x => x.id === d4);
    if (!r || r.role === "Commander" || outMap.has(d4)) return;
    r.outOfCamp = true;
    r.outReason = reason || "Out of camp";
    r.outSince = today;
    r.campIn = false;
    r.campInSince = "";
    booked.push(r);
  });
  if (!booked.length) return 0;
  saveLocal(); render();
  if (STATE.apiUrl) booked.forEach(r => autoSync("Roster", { type: "upsert", row: r }));
  return booked.length;
}

// Bulk book-IN for TODAY (inverse of bookOutMany) — only recruits currently OUT
// are affected. Clears a manual book-out; for an MC/leave recruit it sets the
// day-scoped present-override so they count in camp today (same as the per-
// recruit Book In). Auto-resets tomorrow.
function bookInMany(d4s) {
  const ids = Array.isArray(d4s) ? d4s : [d4s];
  const today = todayISO();
  const outMap = outOfCampMap(today);
  const changed = [];
  ids.forEach(d4 => {
    const r = STATE.roster.find(x => x.id === d4);
    if (!r || r.role === "Commander" || !outMap.has(d4)) return;
    r.outOfCamp = false;
    r.outReason = "";
    r.outSince = "";
    if (derivedCampOut(d4, today)) { r.campIn = true; r.campInSince = today; }
    else { r.campIn = false; r.campInSince = ""; }
    changed.push(r);
  });
  if (!changed.length) return 0;
  saveLocal(); render();
  if (STATE.apiUrl) changed.forEach(r => autoSync("Roster", { type: "upsert", row: r }));
  return changed.length;
}

// Ad-hoc book out / in picker (dashboard buttons): act on a single recruit, or a
// whole company / platoon / program / group / combined group in one tap. `dir`
// is "out" (default) or "in". Counts show the live number of recruits each scope
// would affect — in-camp for book-out, out-of-camp for book-in.
function openBookOutPicker(dir) {
  dir = dir === "in" ? "in" : "out";
  const outMap = outOfCampMap(todayISO());
  // The pool a direction can act on: in-camp recruits for book-out, out-of-camp
  // recruits for book-in.
  const pool = STATE.roster.filter(r => r.role !== "Commander" && (dir === "in" ? outMap.has(r.id) : !outMap.has(r.id)));
  const poolIds = new Set(pool.map(r => r.id));
  const platoons = [...new Set(pool.map(getPlt).filter(Boolean))].sort();
  const progs = (STATE.programs || []).filter(pr => pool.some(r => programOf(r) === pr.key));
  const groups = allGroupNames().filter(g => pool.some(r => recruitInGroup(r, g)));
  const combined = allCombinedNames().filter(n => [...combinedMemberSet(n)].some(d => poolIds.has(d)));
  const cnt = pred => pool.filter(pred).length;
  const scopeOpts = [
    `<option value="recruit">One recruit…</option>`,
    `<option value="company">Whole company (${pool.length})</option>`,
    ...platoons.map(p => `<option value="plt:${p}">Platoon ${p} (${cnt(r => getPlt(r) === p)})</option>`),
    ...progs.map(pr => `<option value="prog:${escapeAttr(pr.key)}">${escapeAttr(pr.name || pr.key)} (${cnt(r => programOf(r) === pr.key)})</option>`),
    ...groups.map(g => `<option value="grp:${escapeAttr(g)}">⦿ ${escapeAttr(g)} (${cnt(r => recruitInGroup(r, g))})</option>`),
    ...combined.map(n => { const set = combinedMemberSet(n); return `<option value="comb:${escapeAttr(n)}">▣ ${escapeAttr(n)} (${cnt(r => set.has(r.id))})</option>`; })
  ].join("");
  const title = dir === "in" ? "Book In to Camp" : "Book Out of Camp";
  const info = dir === "in"
    ? "Books recruits back IN for today — clears a manual book-out, or counts an MC/leave recruit present (auto-resets tomorrow). Only affects recruits currently out of camp."
    : "Marks recruits out of camp for today (auto-clears tomorrow). Recruits already out (MC / leave / booked out) are skipped. For multi-day absences, log a Leave instead.";
  const reasonField = dir === "in" ? "" : formField("f-bo-reason", "Reason", "text", "MO / Appointment / Personal…", `value="Out of camp" maxlength="120"`);
  const btn = dir === "in"
    ? `<button type="submit" class="btn btn-success">↩ Book In</button>`
    : `<button type="submit" class="btn btn-danger">🚪 Book Out</button>`;
  openModal(title, `
    <form onsubmit="event.preventDefault(); submitBookOut('${dir}'); return false">
      <input type="hidden" id="f-bo-dir" value="${dir}">
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:11px;color:var(--muted)">${info}</div>
        <div class="form-group"><label>Scope</label><select id="f-bo-scope" class="topbar-select" style="width:100%" onchange="onBookOutScopeChange()">${scopeOpts}</select></div>
        <div class="form-group" id="f-bo-recruit-wrap"><label>Recruit</label>${rosterSelect("f-bo-d4", false, "")}</div>
        ${reasonField}
        ${btn}
      </div>
    </form>`);
  onBookOutScopeChange();
}
// Show the single-recruit dropdown only when the "One recruit" scope is picked.
function onBookOutScopeChange() {
  const wrap = document.getElementById("f-bo-recruit-wrap");
  if (wrap) wrap.style.display = gv("f-bo-scope") === "recruit" ? "" : "none";
}
function submitBookOut(dir) {
  dir = (dir || gv("f-bo-dir")) === "in" ? "in" : "out";
  const scope = gv("f-bo-scope") || "recruit";
  if (scope === "recruit") {
    const d4 = gv("f-bo-d4");
    if (!d4) { alert("Pick a recruit first."); return; }
    bookOutToggle(d4, dir === "out", dir === "out" ? (gv("f-bo-reason") || "Out of camp") : undefined);
    closeModal();
    return;
  }
  const label = scope === "company" ? "the whole company"
    : scope.indexOf("plt:") === 0 ? "Platoon " + scope.slice(4)
    : scope.indexOf("grp:") === 0 ? scope.slice(4)
    : scope.indexOf("comb:") === 0 ? scope.slice(5)
    : programLabel(scope.slice(5));
  if (dir === "in") {
    const targets = bookInTargets(scope).map(r => r.id);
    if (!targets.length) { alert("No out-of-camp recruits to book in in that scope."); return; }
    if (!confirm(`Book in ${targets.length} recruit${targets.length === 1 ? "" : "s"} in ${label}?`)) return;
    bookInMany(targets);
    closeModal();
    return;
  }
  const reason = gv("f-bo-reason") || "Out of camp";
  const targets = bookOutTargets(scope).map(r => r.id);
  if (!targets.length) { alert("No in-camp recruits to book out in that scope."); return; }
  if (!confirm(`Book out ${targets.length} in-camp recruit${targets.length === 1 ? "" : "s"} in ${label}?\nReason: ${reason}`)) return;
  bookOutMany(targets, reason);
  closeModal();
}

// ── Movement board mutations + forms ─────────────────────────
// Move one or more recruits to an in-camp location for TODAY. Day-scoped
// (locationSince === today) exactly like a manual book-out, so it auto-clears
// tomorrow with no cron. Optimistic: STATE + render() update instantly, then
// each Roster row upserts (row-scoped, cross-device-safe). Moving to
// DEFAULT_LOCATION clears the fields. A body that's OUT of camp isn't on the
// in-camp board, so it's skipped — movement never touches out-of-camp state.
function moveToLocation(d4s, location) {
  const ids = Array.isArray(d4s) ? d4s : [d4s];
  const today = todayISO();
  const outMap = outOfCampMap(today);
  const toDefault = !location || location === DEFAULT_LOCATION;
  const moved = [];
  ids.forEach(d4 => {
    const r = STATE.roster.find(x => x.id === d4);
    if (!r || r.role === "Commander" || outMap.has(d4)) return;
    if (toDefault) { r.location = ""; r.locationSince = ""; }
    else { r.location = location; r.locationSince = today; }
    moved.push(r);
  });
  if (!moved.length) return;
  saveLocal(); render();
  // N sequential row upserts through the per-tab queue. Fine for squad sizes;
  // the local update already landed so the UI never waits on the network.
  if (STATE.apiUrl) moved.forEach(r => autoSync("Roster", { type: "upsert", row: r }));
}

// One-tap automation: send everyone currently in camp back to DEFAULT_LOCATION
// (end-of-activity recall). Out-of-camp bodies are untouched. The manual per-
// move flow remains the backup for anything finer-grained.
function recallAll() {
  const today = todayISO();
  const outMap = outOfCampMap(today);
  const ids = STATE.roster
    .filter(r => r.role !== "Commander" && !outMap.has(r.id) && r.locationSince === today && r.location && r.location !== DEFAULT_LOCATION)
    .map(r => r.id);
  if (!ids.length) { alert(`Everyone in camp is already at ${DEFAULT_LOCATION}.`); return; }
  if (!confirm(`Recall all ${ids.length} recruit${ids.length === 1 ? "" : "s"} back to ${DEFAULT_LOCATION}?`)) return;
  moveToLocation(ids, DEFAULT_LOCATION);
}

// Toggle every checkbox in a platoon group (or all, when plt === "*").
function moveToggleGroup(master, plt) {
  const sel = plt === "*"
    ? "#move-recruit-list input[type=checkbox][data-d4]"
    : `#move-recruit-list input[type=checkbox][data-plt="${CSS.escape(plt)}"]`;
  document.querySelectorAll(sel).forEach(el => { el.checked = master.checked; });
}

// Primary movement input: pick a destination + check who's moving. In-camp
// recruits only (out-of-camp bodies are managed by medical/leave/book-out),
// grouped by platoon with per-group select-all so a whole squad moves in a tap.
// `preselectId` pre-checks one recruit for the per-card quick-move path.
function openMoveForm(preselectId) {
  const today = todayISO();
  const outMap = outOfCampMap(today);
  const recruits = STATE.roster.filter(r => r.role !== "Commander" && !outMap.has(r.id));
  if (!recruits.length) {
    openModal("🚶 Move Bodies", `<div class="empty-state" style="padding:16px;font-size:12px">No in-camp recruits to move — everyone is out of camp or the roster is empty.</div>`);
    return;
  }
  const curLoc = r => (r.locationSince === today && r.location) ? r.location : DEFAULT_LOCATION;
  const byPlt = {};
  recruits.forEach(r => { const p = getPlt(r) || "?"; (byPlt[p] = byPlt[p] || []).push(r); });
  const groups = Object.keys(byPlt).sort().map(p => {
    const rows = byPlt[p].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(r => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;background:var(--surface2)">
        <input type="checkbox" data-d4="${r.id}" data-plt="${escapeAttr(p)}" ${r.id === preselectId ? "checked" : ""} style="width:14px;height:14px;cursor:pointer">
        <span class="mono" style="font-weight:700;color:var(--accent);font-size:11px;min-width:34px">${displayId(r.id)}</span>
        <span style="font-size:12px;flex:1">${displayPersonLabel(r.id)}</span>
        <span style="font-size:10px;color:var(--muted)">${curLoc(r)}</span>
      </label>`).join("");
    return `
      <div style="margin-bottom:8px">
        <label style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;cursor:pointer">
          <input type="checkbox" onchange="moveToggleGroup(this, '${escapeAttr(p)}')" style="width:14px;height:14px;cursor:pointer"> Platoon ${p} <span style="font-weight:400">(${byPlt[p].length})</span>
        </label>
        <div style="display:flex;flex-direction:column;gap:3px">${rows}</div>
      </div>`;
  }).join("");

  openModal("🚶 Move Bodies", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.5">Pick who's moving and where to. Movement is for <strong>today</strong> only — everyone auto-returns to ${DEFAULT_LOCATION} tomorrow. Out-of-camp recruits (MC / leave / booked out) aren't shown.</div>
      ${formSelect("f-move-loc", "Move to", STATE.locations, false, DEFAULT_LOCATION)}
      ${formField("f-move-new", "…or a new location", "text", "e.g. Parade Square", `maxlength="40"`)}
      <div id="move-recruit-list" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        <label style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:var(--text);margin-bottom:8px;cursor:pointer">
          <input type="checkbox" onchange="moveToggleGroup(this, '*')" style="width:14px;height:14px;cursor:pointer"> Select all in camp (${recruits.length})
        </label>
        ${groups}
      </div>
      <button class="btn btn-primary" onclick="submitMove()">Move selected</button>
    </div>`);
}
function submitMove() {
  const ids = [...document.querySelectorAll("#move-recruit-list input[type=checkbox][data-d4]:checked")].map(el => el.dataset.d4);
  if (!ids.length) { alert("Pick at least one recruit to move."); return; }
  const dest = ((gv("f-move-new") || "").trim()) || gv("f-move-loc") || DEFAULT_LOCATION;
  if (/^out of camp$/i.test(dest)) { alert('"Out of Camp" is managed automatically — pick or type an in-camp location.'); return; }
  // Register a brand-new location name so it's reusable next time.
  if (dest !== DEFAULT_LOCATION && !(STATE.locations || []).includes(dest)) {
    STATE.locations.push(dest); saveLocations();
  }
  moveToLocation(ids, dest);
  closeModal();
}

// Manage the named location list. Rename → recruits follow; remove → recruits
// return to DEFAULT_LOCATION; DEFAULT_LOCATION itself is protected.
function openLocationsForm() {
  const rows = (STATE.locations || []).map(loc => {
    if (loc === DEFAULT_LOCATION) {
      return `<div data-loc-row style="display:flex;align-items:center;gap:8px">
        <input data-orig="${escapeAttr(loc)}" value="${escapeAttr(loc)}" readonly style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font:inherit;font-size:12px">
        <span style="font-size:10px;color:var(--dim);min-width:44px;text-align:right">default</span></div>`;
    }
    return `<div data-loc-row style="display:flex;align-items:center;gap:8px">
      <input data-orig="${escapeAttr(loc)}" value="${escapeAttr(loc)}" maxlength="40" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px">
      <button type="button" class="btn btn-danger" style="padding:4px 10px" onclick="this.closest('[data-loc-row]').remove()">✕</button></div>`;
  }).join("");
  openModal("⚙ Manage Locations", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.5">Rename a location and its recruits move with it. Remove one (✕) and its recruits return to ${DEFAULT_LOCATION}. ${DEFAULT_LOCATION} is the default and can't be removed.</div>
      <div id="loc-list" style="display:flex;flex-direction:column;gap:6px">${rows}</div>
      ${formField("f-loc-new", "Add a location", "text", "e.g. Parade Square", `maxlength="40"`)}
      <button class="btn btn-primary" onclick="submitLocations()">Save locations</button>
    </div>`);
}
function submitLocations() {
  const inputs = [...document.querySelectorAll("#loc-list [data-loc-row] input[data-orig]")];
  const newList = [DEFAULT_LOCATION];
  const renameMap = {};   // orig name → new name (kept rows only)
  for (const inp of inputs) {
    const orig = inp.dataset.orig;
    const val = (inp.value || "").trim();
    if (orig === DEFAULT_LOCATION) continue;   // fixed, already seeded
    if (!val) continue;                        // emptied → treated as removed
    if (/^out of camp$/i.test(val)) { alert('"Out of Camp" is reserved.'); return; }
    if (!newList.includes(val)) newList.push(val);
    renameMap[orig] = val;
  }
  const add = (gv("f-loc-new") || "").trim();
  if (add) {
    if (/^out of camp$/i.test(add)) { alert('"Out of Camp" is reserved.'); return; }
    if (!newList.includes(add)) newList.push(add);
  }
  // Migrate recruits whose current (fresh) location was renamed or removed.
  const today = todayISO();
  const changed = [];
  STATE.roster.forEach(r => {
    if (r.role === "Commander" || r.locationSince !== today || !r.location || r.location === DEFAULT_LOCATION) return;
    const renamed = renameMap[r.location];
    if (renamed && renamed !== r.location) { r.location = renamed; changed.push(r); }
    else if (!newList.includes(r.location)) { r.location = ""; r.locationSince = ""; changed.push(r); }
  });
  STATE.locations = newList; saveLocations();
  if (changed.length) {
    saveLocal();
    if (STATE.apiUrl) changed.forEach(r => autoSync("Roster", { type: "upsert", row: r }));
  }
  closeModal(); render();
}

// ── Recruit groups: mutations + management UI ────────────────
// A group's membership is stored on each recruit's `groups` tag. Setting the
// FULL membership in one batch mirrors moveToLocation (optimistic local update,
// then N row-scoped upserts). Persistent (NOT day-scoped) — a group assignment
// stays until changed. Commanders are never grouped (strength convention).
function setGroupMembers(name, d4s) {
  name = String(name || "").trim();
  if (!name) return 0;
  const want = new Set(d4s);
  const changed = [];
  (STATE.roster || []).forEach(r => {
    if (r.role === "Commander") return;
    const has = recruitInGroup(r, name);
    const should = want.has(r.id);
    if (has === should) return;
    const groups = getGroups(r).filter(g => g !== name);
    if (should) groups.push(name);
    r.groups = groups.join(",");
    changed.push(r);
  });
  if (!changed.length) return 0;
  saveLocal(); render();
  if (STATE.apiUrl) changed.forEach(r => autoSync("Roster", { type: "upsert", row: r }));
  return changed.length;
}
// Rename a group across all members (de-dupes if the target name already exists).
function renameGroup(oldName, newName) {
  oldName = String(oldName || "").trim(); newName = String(newName || "").trim();
  if (!oldName || !newName || oldName === newName) return;
  const changed = [];
  (STATE.roster || []).forEach(r => {
    if (!recruitInGroup(r, oldName)) return;
    r.groups = [...new Set(getGroups(r).map(g => g === oldName ? newName : g))].join(",");
    changed.push(r);
  });
  if (!changed.length) return;
  saveLocal(); render();
  if (STATE.apiUrl) changed.forEach(r => autoSync("Roster", { type: "upsert", row: r }));
}
// Delete a group = clear its membership (dissolves it, since names are derived).
function deleteGroup(name) {
  setGroupMembers(name, []);
  if (STATE.filterGroup === name) { STATE.filterGroup = ""; saveFilter(); }
}

// Toggle every checkbox in a platoon block of the group member picker (or all
// when plt === "*").
function groupToggleAll(master, plt) {
  const sel = plt === "*"
    ? "#group-member-list input[type=checkbox][data-d4]"
    : `#group-member-list input[type=checkbox][data-plt="${CSS.escape(plt)}"]`;
  document.querySelectorAll(sel).forEach(el => { el.checked = master.checked; });
}

// Groups overview: rename / delete existing groups + create a new one. "Members"
// opens the member picker for that group. Commanders are excluded everywhere.
function openGroupsForm() {
  const names = allGroupNames();
  const rows = names.length ? names.map(n => `
    <div data-grp-row style="display:flex;align-items:center;gap:8px">
      <input data-orig="${escapeAttr(n)}" value="${escapeAttr(n)}" maxlength="40" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px">
      <span style="font-size:10px;color:var(--muted);min-width:52px;text-align:right">${groupMembers(n).length} rec</span>
      <button type="button" class="btn" style="padding:4px 10px" onclick="openGroupMembersForm('${escapeAttr(n)}')" title="Edit members">✎ Members</button>
      <button type="button" class="btn btn-danger" style="padding:4px 10px" onclick="if(confirm('Delete group ${escapeAttr(n)}? Members keep their other groups.')){deleteGroup('${escapeAttr(n)}');openGroupsForm();}">✕</button>
    </div>`).join("") : `<div class="empty-state" style="padding:10px;font-size:11px">No groups yet. Create one below, then pick its members.</div>`;
  const combRows = (STATE.combinedGroups || []).length ? (STATE.combinedGroups || []).map(c => `
    <div style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:12px">▣ ${escapeAttr(c.name)}</div>
        <div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeAttr(combinedFormula(c))} = ${combinedMemberSet(c.name).size} rec</div>
      </div>
      <button type="button" class="btn" style="padding:4px 10px" onclick="openCombinedForm('${escapeAttr(c.name)}')" title="Edit formula">✎</button>
      <button type="button" class="btn btn-danger" style="padding:4px 10px" onclick="if(confirm('Delete combined group ${escapeAttr(c.name)}?')){deleteCombined('${escapeAttr(c.name)}')}">✕</button>
    </div>`).join("") : `<div class="empty-state" style="padding:10px;font-size:11px">No combined groups yet — e.g. "P4 − Guard Duty".</div>`;
  openModal("⦿ Recruit Groups", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.5">Groups are ad-hoc squads that cut across platoons (e.g. <strong>Guard Duty</strong>). Filter the whole app by a group, or book a group out on its own. Rename a group and its members follow; membership persists until you change it.</div>
      <div id="grp-list" style="display:flex;flex-direction:column;gap:6px">${rows}</div>
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div class="form-group" style="flex:1;margin:0"><label>New group</label><input id="f-grp-new" type="text" placeholder="e.g. Guard Duty" maxlength="40"></div>
        <button class="btn btn-primary" onclick="createGroupThenPick()">Create + pick members</button>
      </div>
      <button class="btn" onclick="submitGroupNames()">Save names</button>
      <div style="border-top:1px solid var(--border);margin:4px 0"></div>
      <div style="font-size:12px;font-weight:700;color:var(--text)">▣ Combined groups <span style="font-weight:400;color:var(--muted);font-size:11px">— mix platoons / programs / groups with + and −</span></div>
      <div style="display:flex;flex-direction:column;gap:6px">${combRows}</div>
      <button class="btn btn-primary" onclick="openCombinedForm()">＋ New combined group</button>
    </div>`);
}
// Apply inline renames from the overview (delete is immediate via its button).
function submitGroupNames() {
  const inputs = [...document.querySelectorAll("#grp-list [data-grp-row] input[data-orig]")];
  for (const inp of inputs) {
    const orig = inp.dataset.orig;
    const val = (inp.value || "").trim();
    if (!val) { alert("Group names can't be empty — use ✕ to delete a group."); return; }
    if (val.indexOf(",") !== -1) { alert("Group names can't contain a comma."); return; }
    if (val !== orig) renameGroup(orig, val);
  }
  closeModal(); render();
}
function createGroupThenPick() {
  const name = (gv("f-grp-new") || "").trim();
  if (!name) { alert("Enter a group name first."); return; }
  if (name.indexOf(",") !== -1) { alert("Group names can't contain a comma."); return; }
  if (allGroupNames().includes(name)) { alert("That group already exists."); return; }
  openGroupMembersForm(name);
}

// Member picker for one group: ALL recruits (group membership isn't camp-scoped),
// grouped by platoon with per-block select-all. Ticked = member. Save replaces
// the group's membership with exactly the ticked set.
function openGroupMembersForm(name) {
  const recruits = STATE.roster.filter(r => r.role !== "Commander");
  const byPlt = {};
  recruits.forEach(r => { const p = getPlt(r) || "?"; (byPlt[p] = byPlt[p] || []).push(r); });
  const blocks = Object.keys(byPlt).sort().map(p => {
    const rows = byPlt[p].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(r => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;background:var(--surface2)">
        <input type="checkbox" data-d4="${r.id}" data-plt="${escapeAttr(p)}" ${recruitInGroup(r, name) ? "checked" : ""} style="width:14px;height:14px;cursor:pointer">
        <span class="mono" style="font-weight:700;color:var(--accent);font-size:11px;min-width:34px">${displayId(r.id)}</span>
        <span style="font-size:12px;flex:1">${displayPersonLabel(r.id)}</span>
        <span style="font-size:10px;color:var(--muted)">${getGroups(r).filter(g => g !== name).join(", ")}</span>
      </label>`).join("");
    return `<div style="margin-bottom:8px">
      <label style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;cursor:pointer">
        <input type="checkbox" onchange="groupToggleAll(this, '${escapeAttr(p)}')" style="width:14px;height:14px;cursor:pointer"> Platoon ${p} <span style="font-weight:400">(${byPlt[p].length})</span>
      </label>
      <div style="display:flex;flex-direction:column;gap:3px">${rows}</div>
    </div>`;
  }).join("");
  openModal(`⦿ ${name} — members`, `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:11px;color:var(--muted)">Tick everyone in <strong>${escapeAttr(name)}</strong>. Saving replaces the group's members with exactly who's ticked.</div>
      <div id="group-member-list" style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        <label style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:var(--text);margin-bottom:8px;cursor:pointer">
          <input type="checkbox" onchange="groupToggleAll(this, '*')" style="width:14px;height:14px;cursor:pointer"> Select all (${recruits.length})
        </label>
        ${blocks}
      </div>
      <button class="btn btn-primary" onclick="submitGroupMembers('${escapeAttr(name)}')">Save members</button>
    </div>`);
}
function submitGroupMembers(name) {
  const ids = [...document.querySelectorAll("#group-member-list input[type=checkbox][data-d4]:checked")].map(el => el.dataset.d4);
  setGroupMembers(name, ids);
  closeModal(); render();
}

// ── Combined-group builder (tristate chips) ──────────────────
// The chips a combined group can mix: whole company, each platoon, each program,
// each plain group. Tap a chip to cycle neutral → include(+) → exclude(−).
let _combBuilder = null;
function combTokens() {
  const toks = ["company"];
  [...new Set(STATE.roster.filter(r => r.role !== "Commander").map(getPlt).filter(Boolean))].sort().forEach(p => toks.push("plt:" + p));
  (STATE.programs || []).forEach(pr => toks.push("prog:" + pr.key));
  allGroupNames().forEach(g => toks.push("grp:" + g));
  return toks;
}
function openCombinedForm(name) {
  const def = name ? combinedByName(name) : null;
  _combBuilder = {
    editing: name || "",
    name: def ? def.name : "",
    include: new Set(def ? def.include : []),
    exclude: new Set(def ? def.exclude : []),
    autoName: !def   // keep name synced to the formula until the user types
  };
  renderCombinedForm();
}
// Cycle a chip: neutral → include → exclude → neutral.
function combCycle(token) {
  const b = _combBuilder;
  if (b.include.has(token)) { b.include.delete(token); b.exclude.add(token); }
  else if (b.exclude.has(token)) { b.exclude.delete(token); }
  else { b.include.add(token); }
  renderCombinedForm();
}
function combNameInput(v) { _combBuilder.name = v; _combBuilder.autoName = false; }
function renderCombinedForm() {
  const b = _combBuilder;
  const def = { include: [...b.include], exclude: [...b.exclude] };
  const formula = combinedFormula(def);
  const count = b.include.size ? combinedMemberSetFromDef(def).size : 0;
  if (b.autoName) b.name = formula === "∅" ? "" : formula.replace(/⦿ /g, "");
  const chips = combTokens().map(tok => {
    const inc = b.include.has(tok), exc = b.exclude.has(tok);
    const bg = inc ? "#3FB950" : exc ? "#F85149" : "transparent";
    const bd = inc ? "#3FB950" : exc ? "#F85149" : "var(--border)";
    const col = (inc || exc) ? "#0D1117" : "var(--muted)";
    const sign = inc ? "+ " : exc ? "− " : "";
    return `<button type="button" onclick="combCycle('${escapeAttr(tok)}')" style="padding:6px 11px;border-radius:14px;border:1px solid ${bd};background:${bg};color:${col};font-weight:600;font-size:12px;cursor:pointer">${sign}${escapeAttr(scopeTokenLabel(tok))}</button>`;
  }).join("");
  openModal(b.editing ? `▣ Edit ${b.editing}` : "▣ New combined group", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.5">Tap a chip once to <span style="color:var(--green);font-weight:700">include (+)</span>, again to <span style="color:var(--red);font-weight:700">exclude (−)</span>, again to clear. e.g. tap <strong>P4</strong>, then tap <strong>⦿ Guard Duty</strong> twice → "P4 − Guard Duty".</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Formula</div>
        <div style="font-size:13px;font-weight:700">${escapeAttr(formula)} <span style="color:var(--accent);font-weight:600">= ${count} recruit${count === 1 ? "" : "s"}</span></div>
      </div>
      <div class="form-group" style="margin:0"><label>Name</label><input id="f-comb-name" type="text" value="${escapeAttr(b.name)}" oninput="combNameInput(this.value)" placeholder="Auto from formula" maxlength="40"></div>
      <button class="btn btn-primary" onclick="submitCombined()">${b.editing ? "Save changes" : "Create combined group"}</button>
    </div>`);
}
function submitCombined() {
  const b = _combBuilder;
  if (!b.include.size) { alert("Tap at least one chip to INCLUDE (green +) first."); return; }
  let name = (b.name || "").trim() || combinedFormula({ include: [...b.include], exclude: [...b.exclude] }).replace(/⦿ /g, "");
  name = name.replace(/,/g, "").trim();
  if (!name) { alert("Give the combined group a name."); return; }
  const list = STATE.combinedGroups || [];
  const def = { name, include: [...b.include], exclude: [...b.exclude] };
  if (b.editing) {
    const i = list.findIndex(c => c.name === b.editing);
    if (i >= 0) list[i] = def; else list.push(def);
    if (STATE.filterGroup === "c:" + b.editing) { STATE.filterGroup = "c:" + name; saveFilter(); }
  } else {
    if (list.some(c => c.name === name)) { alert("A combined group with that name already exists."); return; }
    list.push(def);
  }
  STATE.combinedGroups = list; saveCombinedGroups();
  _combBuilder = null;
  openGroupsForm(); render();
}
function deleteCombined(name) {
  STATE.combinedGroups = (STATE.combinedGroups || []).filter(c => c.name !== name);
  saveCombinedGroups();
  if (STATE.filterGroup === "c:" + name) { STATE.filterGroup = ""; saveFilter(); }
  openGroupsForm(); render();
}

// Lightweight roster-add form scoped to commanders. Recruits are added via
// the Google Sheet directly (their data is sourced from pre-enlistment
// nominal rolls); commanders are added ad-hoc in-app so the user doesn't
// need to touch the sheet just to track their own team.
function openCommanderForm(id) {
  const e = id ? STATE.roster.find(r => r.id === id && r.role === "Commander") : null;
  openModal(e ? "Edit Commander" : "+ Add Commander", `
    <form onsubmit="event.preventDefault(); submitCommander(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px">Commander IDs use the <strong>00xx</strong> range (0001–0099). The ID is administrative — the app only ever shows rank + name.</div>
        <div class="form-row">
          ${formField("f-id", "4D (00xx)", "text", "0001", `required maxlength="4" pattern="00[0-9]{2}" value="${escapeAttr(e?.id)}"${e ? " readonly" : ""}`)}
          ${formField("f-rank", "Rank", "text", "3SG / 2LT / CPT…", `required maxlength="10" value="${escapeAttr(e?.rank)}"`)}
        </div>
        ${formField("f-name", "Name", "text", "Nicholas Eng", `required maxlength="100" value="${escapeAttr(e?.name)}"`)}
        ${formField("f-quota", "Off-in-Lieu Quota (days)", "number", "14", `min="0" max="365" step="1" value="${e?.leaveQuota ?? 14}"`)}
        ${formField("f-phone", "Phone (optional)", "text", "9123 4567", `maxlength="20" value="${escapeAttr(e?.phone)}"`)}
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Add Commander"}</button>
      </div>
    </form>`);
}
function submitCommander() {
  const editId = gv("f-entry-id");
  const id = gv("f-id").trim();
  if (!/^00\d{2}$/.test(id)) { alert("Commander ID must be 4 digits in the 00xx range (e.g. 0001)."); return; }
  if (!editId && STATE.roster.some(r => r.id === id)) { alert(`ID ${id} is already taken.`); return; }
  const entry = {
    id,
    name: gv("f-name"),
    rank: gv("f-rank"),
    role: "Commander",
    leaveQuota: +gv("f-quota") || 0,
    phone: gv("f-phone") || "",
    status: "",
    plt: "",
    sect: ""
  };
  if (editId) {
    const idx = STATE.roster.findIndex(r => r.id === editId);
    if (idx >= 0) STATE.roster[idx] = { ...STATE.roster[idx], ...entry };
  } else {
    STATE.roster.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("Roster", { type: "upsert", row: entry });
}

function openLeaveForm(id) {
  const e = id ? STATE.leave.find(x => x.id === id) : null;
  const startVal = e ? displayDateToISO(e.startDate) || todayISO() : todayISO();
  const endVal = e ? displayDateToISO(e.endDate) || todayISO() : todayISO();
  // Bulk scope options (add mode only): a whole platoon / program / group /
  // combined group on leave in one entry. Counts are recruits in the scope.
  const recruits = STATE.roster.filter(r => r.role !== "Commander");
  const platoons = [...new Set(recruits.map(getPlt).filter(Boolean))].sort();
  const progs = (STATE.programs || []).filter(pr => recruits.some(r => programOf(r) === pr.key));
  const cnt = s => scopeRecruits(s).length;
  const scopeOpts = [
    `<option value="person">One person…</option>`,
    `<option value="company">Whole company (${recruits.length})</option>`,
    ...platoons.map(p => `<option value="plt:${p}">Platoon ${p} (${cnt("plt:" + p)})</option>`),
    ...progs.map(pr => `<option value="prog:${escapeAttr(pr.key)}">${escapeAttr(pr.name || pr.key)} (${cnt("prog:" + pr.key)})</option>`),
    ...allGroupNames().map(g => `<option value="grp:${escapeAttr(g)}">⦿ ${escapeAttr(g)} (${cnt("grp:" + g)})</option>`),
    ...allCombinedNames().map(n => `<option value="comb:${escapeAttr(n)}">▣ ${escapeAttr(n)} (${cnt("comb:" + n)})</option>`)
  ].join("");
  openModal(e ? "Edit Leave/Out Entry" : "Log Leave / Out", `
    <form onsubmit="event.preventDefault(); submitLeave(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.6">
          <div style="font-weight:600;color:var(--text);margin-bottom:4px">📋 Pick the type</div>
          <div><strong>Off-in-Lieu</strong> — counts against the commander's quota.</div>
          <div><strong>Leave / Compassionate / Course / Guard Duty / NDP / Other</strong> — tracked but doesn't decrement the off balance.</div>
        </div>
        ${e ? "" : `<div class="form-group"><label>Apply to</label><select id="f-leave-scope" class="topbar-select" style="width:100%" onchange="onLeaveScopeChange()">${scopeOpts}</select></div>`}
        <div class="form-group" id="f-leave-person-wrap"><label>Person</label>${rosterSelect("f-d4", false, e?.d4 || "")}</div>
        ${formSelect("f-type", "Type", [["Off-in-Lieu", "Off-in-Lieu (counts toward quota)"], ["Annual Leave", "Annual Leave"], ["Compassionate", "Compassionate Leave"], ["Weekend", "Weekend"], ["Night's Out", "Night's Out (same-day, evening off-camp)"], ["Course", "Course"], ["Guard Duty", "Guard Duty"], ["NDP", "NDP"], ["Other", "Other"]], true, e?.type || "")}
        <div class="form-row">
          ${formField("f-start", "Start date", "date", "", `required value="${startVal}" min="2020-01-01" max="2099-12-31" onchange="recalcLeaveDays()"`)}
          ${formField("f-end", "End date", "date", "", `required value="${endVal}" min="2020-01-01" max="2099-12-31" onchange="recalcLeaveDays()"`)}
        </div>
        ${formField("f-days", "Days (auto-calc — editable for half-days)", "number", "1", `required min="0" max="365" step="0.5" value="${e?.days ?? 1}"`)}
        ${formField("f-reason", "Reason / notes", "text", "APSC course / NDP rehearsal / Cleared leave balance…", `maxlength="200" value="${escapeAttr(e?.reason)}"`)}
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Log"}</button>
      </div>
    </form>`);
}
// Auto-recompute the days field from the start/end date inputs on the leave
// form. Half-day edge case: users override after this fires.
function recalcLeaveDays() {
  const s = document.getElementById("f-start"), en = document.getElementById("f-end"), d = document.getElementById("f-days");
  if (!s || !en || !d || !s.value || !en.value) return;
  const diff = Math.round((new Date(en.value) - new Date(s.value)) / 86400000) + 1;
  if (diff > 0) d.value = diff;
}
// Show the single-person picker only for the "One person" scope.
function onLeaveScopeChange() {
  const wrap = document.getElementById("f-leave-person-wrap");
  if (wrap) wrap.style.display = (gv("f-leave-scope") || "person") === "person" ? "" : "none";
}
function submitLeave() {
  const editId = +gv("f-entry-id");
  const startIso = gv("f-start");
  const endIso = gv("f-end");
  if (endIso < startIso) { alert("End date must be on or after start date."); return; }
  const template = {
    type: gv("f-type"),
    startDate: isoToDisplayDate(startIso),
    endDate: isoToDisplayDate(endIso),
    days: +gv("f-days") || 0,
    reason: gv("f-reason") || ""
  };
  // Bulk: one entry per recruit in the chosen scope (platoon / program / group /
  // combined). Skipped for edits, which always target the single person.
  const scope = editId ? "person" : (gv("f-leave-scope") || "person");
  if (scope !== "person") {
    const ids = scopeRecruits(scope);
    if (!ids.length) { alert("No recruits in that scope."); return; }
    if (!confirm(`Log ${template.type} for ${ids.length} recruit${ids.length === 1 ? "" : "s"}?`)) return;
    leaveMany(ids, template);
    closeModal();
    return;
  }
  const entry = { id: editId || nextId(), d4: gv("f-d4"), ...template };
  if (!entry.d4) { alert("Pick a person."); return; }
  if (editId) {
    const idx = STATE.leave.findIndex(l => l.id === editId);
    if (idx >= 0) STATE.leave[idx] = entry;
  } else {
    STATE.leave.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (STATE.apiUrl) autoSync("Leave", { type: "upsert", row: entry });
}
// Bulk leave/out — one row per recruit, optimistic local update then a row
// upsert each (Leave rows are id-keyed, so upsert = append here).
function leaveMany(d4s, t) {
  const rows = d4s.map(d4 => ({ id: nextId(), d4, type: t.type, startDate: t.startDate, endDate: t.endDate, days: t.days, reason: t.reason }));
  STATE.leave.push(...rows);
  saveLocal(); render();
  if (STATE.apiUrl) rows.forEach(row => autoSync("Leave", { type: "upsert", row }));
  return rows.length;
}

// ─── PARADE STATE + MEDICAL STATUS GENERATORS ─────────
// Compose the three battalion-format WhatsApp messages (First/Last Parade
// State + standalone Medical Status list) from live STATE. The PDS spec
// previously retyped these by hand from chats; now the dashboard generates
// an editable preview that round-trips to clipboard in one tap.

const SEP = "----------------------------------------------------------------";

// Statuses that have their own dedicated parade-state section (ATTC = MC/Warded,
// REPORT SICK = Pending) or are cleared (NIL). MEDICAL STATUS is the catch-all
// for every OTHER active restriction — LD, all Excuses, and any custom/one-off
// status (e.g. "Excuse Jumping") that isn't in the canonical MED_STATUSES list.
// Using an exclusion predicate instead of a hardcoded allowlist means a new or
// custom status can never silently fall through the cracks of the report.
const PARADE_SECTIONED_STATUSES = ["MC", "Warded", "Pending", "NIL"];
const isMedicalStatusCatchAll = s => !!s && !PARADE_SECTIONED_STATUSES.includes(s);
// A medical record counts as "kept in camp" for the parade when the recruit is
// consuming it in camp (the record's inCamp flag) OR a commander manually booked
// them IN today (the day-scoped force-in override). Either way they're present in
// camp, so an MC/Warded belongs under MEDICAL STATUS, never ATTC.
const medKeptInCamp = (m, dateIso) =>
  m.inCamp === true || isForcedIn(STATE.roster.find(r => r.id === m.d4), dateIso || todayISO());
// A record belongs in MEDICAL STATUS if its status is a catch-all restriction
// (LD/Excuse/custom) OR it's a kept-in-camp MC/Warded (pulled out of ATTC but
// still needing to show its status). Shared by the parade state and the
// standalone Medical Status List so the two never diverge.
const isMedicalStatusRecord = (m, dateIso) =>
  isMedicalStatusCatchAll(m.status) || (medKeptInCamp(m, dateIso) && (m.status === "MC" || m.status === "Warded"));

// "2026-05-20" → "200526" — battalion uses DDMMYY everywhere.
function toDDMMYY(iso) {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return m[3] + m[2] + m[1].slice(2);
}

// R/N formatting per chat convention. Commanders are rank+name, no 4D.
// Recruits are "REC <NAME> C<4D>" — the C prefix marks Cougar in the
// battalion-wide parade state.
function paradeRN(d4) {
  const r = STATE.roster.find(x => x.id === d4);
  if (!r) return d4;
  const name = (r.name || "").toUpperCase();
  if (r.role === "Commander") return [r.rank, name].filter(Boolean).join(" ");
  // Strip any existing C prefix on the id before re-adding it — some sheets
  // store the recruit 4D as "C1415" already, which would round-trip to
  // "CC1415" otherwise.
  const bareId = String(r.id).replace(/^C/i, "");
  return `REC ${name} C${bareId}`;
}

// Duration label per chat samples ("Duration: 180526 - 010626"). Pending /
// NIL records have no end date; emit a single-day note instead.
function paradeDuration(record) {
  const s = displayDateToISO(record.startDate || record.date || "");
  const e = displayDateToISO(record.endDate || "");
  if (s && e) return `${toDDMMYY(s)} - ${toDDMMYY(e)}`;
  if (s) return toDDMMYY(s);
  return "";
}

// Day count for the status line ("Status: 5D MC"). Inclusive of both ends.
function paradeStatusLabel(record, dateIso) {
  const s = displayDateToISO(record.startDate || "");
  const e = displayDateToISO(record.endDate || "");
  if (!record.status) return "";
  // A kept-in-camp MC/Warded reads "2D MC (consume in camp)" for a record flagged
  // inCamp, or "(kept in camp)" when a commander manually booked them in today.
  // The underlying status stays "MC".
  const suffix = record.inCamp ? " (consume in camp)"
    : (isForcedIn(STATE.roster.find(r => r.id === record.d4), dateIso || todayISO()) ? " (kept in camp)" : "");
  if (!s || !e) return record.status + suffix;
  const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
  return (days > 0 ? `${days}D ${record.status}` : record.status) + suffix;
}

// Group medical entries by d4 so a person with multiple active statuses
// appears under one S/N with stacked sub-entries (matches the BENJAMIN
// C4110 sample in the chat).
// ── Borderline MC returnees ──────────────────────────────
// When an MC ends on day N, on day N+1 the system says the recruit is back
// (medStatusActive returns false), but they might not have booked back in
// before parade time. The PDS opts each one in/out via checkboxes in the
// FP/LP report modal. Map of d4 → true means "still ATTC despite the
// medical record having ended". Cleared on modal open and on date change.
let _paradeOverrides = {};

function findBorderlineReturnees(dateIso) {
  if (!dateIso) return [];
  const y = new Date(dateIso); y.setDate(y.getDate() - 1);
  const yIso = y.toISOString().slice(0, 10);
  return STATE.medical.filter(m =>
    (m.status === "MC" || m.status === "Warded") && !m.inCamp &&
    displayDateToISO(m.endDate || "") === yIso
  );
}

function toggleBorderline(d4, checked, type) {
  if (checked) _paradeOverrides[d4] = true;
  else delete _paradeOverrides[d4];
  regenerateReport(type);
}

// recordFilter is either an allowlist array (status ∈ list) or a predicate
// receiving the whole record (m => boolean) — the record form lets a section
// key off flags like inCamp, not just the status string (MEDICAL STATUS folds
// in consume-in-camp MCs, ATTC excludes them).
function buildMedicalSection(label, dateIso, recordFilter) {
  const matchRecord = typeof recordFilter === "function"
    ? recordFilter
    : m => recordFilter.includes(m.status);
  let matches = STATE.medical.filter(m =>
    medStatusActive(m, dateIso) && matchRecord(m, dateIso)
  );

  // ATTC gets the PDS-confirmed borderline returnees folded in so they
  // render with the same Reason/Status/Duration block as everyone else.
  // Other sections aren't affected by overrides.
  if (label === "ATTC") {
    const existingD4s = new Set(matches.map(m => m.d4));
    findBorderlineReturnees(dateIso)
      .filter(m => _paradeOverrides[m.d4] && !existingD4s.has(m.d4))
      .forEach(m => matches.push(m));
  }
  const byD4 = {};
  matches.forEach(m => { (byD4[m.d4] = byD4[m.d4] || []).push(m); });
  // Collapse same-status duplicates per recruit (a re-issued MC) to the most
  // recent record so it prints once, with the newest dates.
  Object.keys(byD4).forEach(d4 => { byD4[d4] = dedupeActiveRecordsByFamily(byD4[d4]); });
  // Order recruits by their most-severe status (MC/Warded > LD > Excuse > …) so
  // MEDICAL STATUS lists a consume-in-camp MC above LD/Excuse entries. Stable for
  // ties; harmless for ATTC/REPORT SICK where every entry shares one severity.
  const groupRank = d4 => Math.max(...byD4[d4].map(m => medSeverityRank(m.status)));
  const peopleIds = Object.keys(byD4).sort((a, b) => groupRank(b) - groupRank(a));

  if (!peopleIds.length) {
    return `${label}:\n\nS/N:\nR/N:\nReason:`;
  }

  const blocks = peopleIds.map((d4, idx) => {
    const records = byD4[d4];
    const sn = String(idx + 1).padStart(2, "0");
    const rn = paradeRN(d4);
    // Use the first record's reason as the headline — multi-status entries
    // typically share an underlying cause (per BENJAMIN sample).
    const reason = records[0].reason || "";
    // Location line only renders for report-sick-outside cases (external
    // clinic/hospital). In-camp report sicks leave it blank → omitted entirely.
    const location = records.map(r => r.location).find(v => v && String(v).trim()) || "";
    const locationLine = location ? `\nLocation: ${location}` : "";

    if (records.length === 1) {
      const r = records[0];
      return `S/N: ${sn}\nR/N: ${rn}\nReason: ${reason}${locationLine}\nStatus: ${paradeStatusLabel(r, dateIso)}\nDuration: ${paradeDuration(r)}`;
    }
    // Multi-status: stack numbered Status + Duration pairs under one R/N.
    const subStatuses = records.map((r, i) =>
      `${i + 1}. ${paradeStatusLabel(r, dateIso)}\nDuration: ${paradeDuration(r)}`
    ).join("\n");
    return `S/N: ${sn}\nR/N: ${rn}\nReason: ${reason}${locationLine}\nStatus received:\n${subStatuses}`;
  });

  return `${label}: ${String(peopleIds.length).padStart(2, "0")}\n\n${blocks.join("\n\n")}`;
}

// Parse an appointment's time field to "minutes since midnight" so we can
// compare it against the parade time. Handles "0930", "09:30", "0700-2100"
// (uses the END of a range — appt still ongoing if range covers parade
// time). Returns Infinity for unparseable input so the row is shown by
// default (safer than hiding it silently).
function apptEndMinutes(timeStr) {
  const s = String(timeStr || "").replace(/\s/g, "");
  const range = s.match(/(\d{1,4}):?(\d{0,2})\s*[-–]\s*(\d{1,4}):?(\d{0,2})/);
  if (range) {
    const hh = String(range[3]).padStart(4, "0").slice(0, 2);
    const mm = (range[4] || String(range[3]).padStart(4, "0").slice(2, 4)).padStart(2, "0");
    return parseInt(hh, 10) * 60 + parseInt(mm, 10);
  }
  const single = s.match(/(\d{3,4})/);
  if (single) {
    const padded = single[1].padStart(4, "0");
    return parseInt(padded.slice(0, 2), 10) * 60 + parseInt(padded.slice(2, 4), 10);
  }
  return Infinity;
}

function paradeTimeMinutes(timeStr) {
  const padded = String(timeStr || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
  return parseInt(padded.slice(0, 2), 10) * 60 + parseInt(padded.slice(2, 4), 10);
}

// The upcoming appointments a parade state will list: the parade date plus all
// future dates. The time-of-day cutoff only applies on the parade day itself —
// a same-day appt that's already passed is dropped, but a future-dated one
// always shows regardless of its time. Sorted chronologically (date, then time).
// Shared by the report generator and the in/out-of-camp tick checklist.
function upcomingParadeAppointments(dateIso, paradeTime) {
  const paradeMins = paradeTimeMinutes(paradeTime);
  return STATE.appointments
    .filter(a => !a.resolved)
    .filter(a => {
      const iso = displayDateToISO(a.date) || "";
      if (!iso || iso < dateIso) return false;
      if (iso === dateIso) return apptEndMinutes(a.time) >= paradeMins;
      return true;
    })
    .sort((a, b) => {
      const ai = displayDateToISO(a.date) || "";
      const bi = displayDateToISO(b.date) || "";
      if (ai !== bi) return ai < bi ? -1 : 1;
      return apptEndMinutes(a.time) - apptEndMinutes(b.time);
    });
}

// Today's out-of-camp appointments — the candidates for the parade modal's
// Book Out / Book In checklist. Whether each recruit is actually out of camp is
// now the PERSISTENT booked-out flag (isBookedOut), shared with the dashboard —
// not a per-parade tick.
function outsideApptsForParade(dateIso) {
  return STATE.appointments.filter(a =>
    !a.resolved && a.outOfCamp && displayDateToISO(a.date) === dateIso
  );
}

function buildAppointmentSection(dateIso, paradeTime) {
  const upcoming = upcomingParadeAppointments(dateIso, paradeTime);
  if (!upcoming.length) return `MEDICAL APPT:\n\nS/N:\nR/N:\nReason:\nLocation:\nDate:\nTime:`;
  const blocks = upcoming.map((a, idx) => {
    const sn = String(idx + 1).padStart(2, "0");
    return `S/N: ${sn}\nR/N: ${paradeRN(a.d4)}\nReason: ${a.reason || ""}\nLocation: ${a.location || ""}\nDate: ${toDDMMYY(displayDateToISO(a.date))}\nTime: ${fmtHrs(a.time)}`;
  });
  return `MEDICAL APPT: ${String(upcoming.length).padStart(2, "0")}\n\n${blocks.join("\n\n")}`;
}

function buildOthersSection(dateIso) {
  // Single source of truth — same map the dashboard uses. OTHERS lists leave +
  // manual book-outs; medical (MC/Warded) lives in the ATTC/MEDICAL STATUS
  // sections, so it's excluded here.
  const map = outOfCampMap(dateIso);
  const entries = [];
  for (const [d4, info] of map) {
    if (info.kind === "medical") continue;
    if (info.kind === "leave") {
      const l = STATE.leave.find(x => x.d4 === d4 && (() => {
        const s = displayDateToISO(x.startDate), e = displayDateToISO(x.endDate);
        return s && e && s <= dateIso && dateIso <= e;
      })());
      const dur = l ? paradeDuration(l) : "";
      entries.push({ d4, reason: info.reason, extra: dur ? `\nDuration: ${dur}` : "" });
    } else {  // bookedout — appointment-driven, or ad-hoc out of camp
      // If they're booked out for an out-of-camp appointment today, render the
      // full appointment format: "<reason> (MA)" + Location / Date / Time.
      const appt = STATE.appointments.find(a =>
        a.d4 === d4 && !a.resolved && a.outOfCamp && displayDateToISO(a.date) === dateIso
      );
      if (appt) {
        const locLine = appt.location ? `\nLocation: ${appt.location}` : "";
        entries.push({
          d4,
          reason: (appt.reason || "Appointment") + " (MA)",
          extra: `${locLine}\nDate: ${toDDMMYY(displayDateToISO(appt.date))}\nTime: ${fmtHrs(appt.time)}`
        });
      } else {
        entries.push({ d4, reason: info.reason, extra: "" });
      }
    }
  }
  if (!entries.length) return `OTHERS:\n\nS/N:\nR/N:\nReason:\nDuration:`;
  const blocks = entries.map((e, idx) => {
    const sn = String(idx + 1).padStart(2, "0");
    return `S/N: ${sn}\nR/N: ${paradeRN(e.d4)}\nReason: ${e.reason}${e.extra}`;
  });
  return `OTHERS: ${String(entries.length).padStart(2, "0")}\n\n${blocks.join("\n\n")}`;
}

// Strength block — TOTAL is the entire roster (recruits + commanders); CURRENT
// is TOTAL minus everyone OUT OF CAMP today. "Out of camp" is the single shared
// computation (outOfCampMap: active MC/Warded + active leave + manual book-outs)
// so this ALWAYS matches the dashboard "In Camp" number for the same date.
function buildStrengthBlock(dateIso) {
  const all = STATE.roster;
  const recruits = all.filter(r => r.role !== "Commander");
  const commanders = all.filter(r => r.role === "Commander");

  const awaySet = new Set(outOfCampMap(dateIso).keys());
  // Union in borderline MC returnees the PDS confirmed still-out for this parade.
  findBorderlineReturnees(dateIso)
    .filter(m => _paradeOverrides[m.d4])
    .forEach(m => awaySet.add(m.d4));
  const isAway = r => awaySet.has(r.id);

  // Per-platoon recruit breakdown.
  const recruitPlatoons = {};
  recruits.forEach(r => {
    const p = getPlt(r) || "?";
    (recruitPlatoons[p] = recruitPlatoons[p] || { total: 0, away: 0 }).total++;
    if (isAway(r)) recruitPlatoons[p].away++;
  });
  const pltKeys = Object.keys(recruitPlatoons).filter(k => k !== "?").sort();
  const pltLines = pltKeys.map(p => {
    const { total, away } = recruitPlatoons[p];
    return `PLATOON ${p}: ${total - away}/${total}`;
  }).join("\n");

  const totalAway = all.filter(isAway).length;
  const cmdAway = commanders.filter(isAway).length;

  return [
    `TOTAL STRENGTH: ${all.length}`,
    `CURRENT STRENGTH: ${all.length - totalAway}`,
    pltLines,
    `COMMANDERS: ${commanders.length - cmdAway}/${commanders.length}`
  ].filter(Boolean).join("\n");
}

function generateParadeStateText(type, dateIso, time) {
  const dateStr = toDDMMYY(dateIso);
  const header = (type === "FP" ? "FIRST" : "LAST") + " PARADE STATE";
  const sections = [
    buildStrengthBlock(dateIso),
    // ATTC = MC/Warded physically AWAY. Kept-in-camp MC/Warded (consume-in-camp OR
    // a manual same-day Book In) are excluded here and fall through to MEDICAL
    // STATUS below, so anyone counted in camp is never listed as away.
    buildMedicalSection("ATTC", dateIso, (m, d) => (m.status === "MC" || m.status === "Warded") && !medKeptInCamp(m, d)),
    buildMedicalSection("REPORT SICK", dateIso, m => m.status === "Pending"),
    buildMedicalSection("MEDICAL STATUS", dateIso, isMedicalStatusRecord),
    buildAppointmentSection(dateIso, time),
    buildOthersSection(dateIso)
  ];
  return `COUGAR COMPANY\n${header}\nDATE: ${dateStr} @ ${fmtHrs(time)}\n\n${SEP}\n\n${sections.join(`\n\n${SEP}\n\n`)}\n\n${SEP}`;
}

function generateMedicalStatusText(dateIso, time) {
  const dateStr = toDDMMYY(dateIso);
  const heading = `${dateStr}(latest version as of ${dateStr} @${fmtHrs(time)})`;
  const body = buildMedicalSection("MEDICAL STATUS", dateIso, isMedicalStatusRecord);
  return `${heading}\n\n${body}`;
}

// MSK snapshot — one entry per active (non-cleared) case. Reason is the
// latest injury description; Last visit is the most recent physio log
// date for that recruit (or N/A if no exercises logged yet).
// 4D rendered without the "C" prefix per the user's preferred format.
function generateMSKReportText(dateIso, time) {
  const byD4 = {};
  STATE.msk.forEach(m => { (byD4[m.d4] = byD4[m.d4] || []).push(m); });

  const tsOf = r => String(r.timestamp || "");
  const cases = Object.entries(byD4)
    .map(([d4, rows]) => ({ d4, rows, allCleared: rows.every(r => r.cleared) }))
    .filter(c => !c.allCleared);

  const dateStr = toDDMMYY(dateIso);
  const heading = `MSK: ${String(cases.length).padStart(2, "0")} (as of ${dateStr} @${fmtHrs(time)})`;

  if (!cases.length) return `${heading}\n\nNo active MSK cases.`;

  const rnNoC = d4 => {
    const r = STATE.roster.find(x => x.id === d4);
    if (!r) return d4;
    const name = (r.name || "").toUpperCase();
    if (r.role === "Commander") return [r.rank, name].filter(Boolean).join(" ");
    const bareId = String(r.id).replace(/^C/i, "");
    return `REC ${name} ${bareId}`;
  };

  const blocks = cases.map((c, idx) => {
    const sn = String(idx + 1).padStart(2, "0");
    const injuries = c.rows.filter(r => (r.type || "").toLowerCase().includes("report"));
    const exercises = c.rows.filter(r => (r.type || "").toLowerCase().includes("log") || (r.type || "").toLowerCase().includes("exercise"));
    const latestInjury = [...injuries].sort((a, b) => tsOf(a) < tsOf(b) ? 1 : -1)[0];
    const reason = latestInjury?.description || "";
    const latestExercise = [...exercises].sort((a, b) => tsOf(a) < tsOf(b) ? 1 : -1)[0];
    let lastVisit = "N/A";
    if (latestExercise) {
      const d = latestExercise.physioDate || latestExercise.timestamp || "";
      const iso = displayDateToISO(d);
      lastVisit = iso ? toDDMMYY(iso) : d;
    }
    return `S/N: ${sn}\nR/N: ${rnNoC(c.d4)}\nReason: ${reason}\nLast visit: ${lastVisit}`;
  });

  return `${heading}\n\n${blocks.join("\n\n")}`;
}

function openReportModal(type) {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultTime = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const titleLabel = type === "FP" ? "First Parade State"
    : type === "LP" ? "Last Parade State"
    : type === "MSK" ? "MSK Report"
    : type === "CONDUCT" ? "Per-Conduct Chat Format"
    : "Medical Status List";

  // Borderline overrides are scoped to a single modal session — clearing here
  // avoids stale ticks leaking from a previous open. (Out-of-camp is now the
  // persistent booked-out flag, shared with the dashboard — no session state.)
  _paradeOverrides = {};

  // The borderline checklist is only meaningful for FP/LP. MED/MSK/CONDUCT
  // reports skip the section + date onchange wiring entirely.
  const isParade = type === "FP" || type === "LP";
  const isConduct = type === "CONDUCT";
  const dateExtra = isParade
    ? `value="${defaultDate}" required onchange="onParadeDateChange('${type}')"`
    : isConduct
      ? `value="${defaultDate}" required onchange="renderConductPicker(); regenerateReport('CONDUCT')"`
      : `value="${defaultDate}" required`;
  const timeExtra = isConduct
    ? `value="${defaultTime}" maxlength="4" pattern="[0-9]{4}" required onchange="renderConductPicker(); regenerateReport('CONDUCT')"`
    : isParade
      ? `value="${defaultTime}" maxlength="4" pattern="[0-9]{4}" required onchange="onParadeTimeChange('${type}')"`
      : `value="${defaultTime}" maxlength="4" pattern="[0-9]{4}" required`;

  openModal("Generate " + titleLabel, `
    <form onsubmit="event.preventDefault(); regenerateReport('${type}'); return false">
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px">
          ${isConduct
            ? `Pick a logged conduct (filtered by date/time) → message generates from the saved attendance + conductDetail rows. Tap <strong>Copy to Clipboard</strong> when ready and paste into WhatsApp.`
            : `Adjust date/time → tap <strong>Regenerate</strong>. The textarea is editable for last-minute tweaks (e.g. "latest version as of…", manual corrections). Tap <strong>Copy to Clipboard</strong> when ready and paste into WhatsApp.`}
        </div>
        <div class="form-row">
          ${formField("rep-date", "Date", "date", "", dateExtra)}
          ${formField("rep-time", "Time (HHMM)", "text", "0700", timeExtra)}
        </div>
        ${isParade ? `<div id="borderline-section"></div>` : ""}
        ${isParade ? `<div id="appt-camp-section"></div>` : ""}
        ${isConduct ? `<div id="rep-conduct-picker"></div>` : ""}
        <button type="submit" class="btn">↻ Regenerate</button>
        <textarea id="rep-text" rows="20" spellcheck="false" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.45;resize:vertical;white-space:pre"></textarea>
        <button type="button" id="rep-copy-btn" class="btn btn-success" onclick="copyReportToClipboard()">📋 Copy to Clipboard</button>
      </div>
    </form>
  `);
  // Stash the report type so regenerate from the date/time onchange knows
  // which composer to call.
  document.getElementById("rep-text").dataset.type = type;
  if (isParade) renderBorderlineSection(defaultDate, type);
  if (isParade) renderApptCampSection(defaultDate, type);
  if (isConduct) renderConductPicker();
  regenerateReport(type);
}

// Renders the Conduct picker dropdown inside the CONDUCT report modal.
// Lists every attendance row whose date matches (time is best-effort filter).
// Picking a conduct triggers regenerateReport('CONDUCT') so the textarea
// updates in place.
function renderConductPicker() {
  const host = document.getElementById("rep-conduct-picker");
  if (!host) return;
  const dateIso = gv("rep-date");
  const time = gv("rep-time") || "";
  const date = isoToDisplayDate(dateIso);
  // Filter by date; if time is set, prefer matches but include all on the date.
  const matches = STATE.attendance
    .filter(a => a.date === date)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const exactMatch = matches.find(a => (a.time || "") === time);
  const selectedId = exactMatch ? exactMatch.id : (matches[0]?.id || "");
  if (!matches.length) {
    host.innerHTML = `<div style="font-size:11px;color:var(--orange);background:#D2992222;border:1px solid #D2992244;border-radius:6px;padding:6px 10px">No conducts logged on ${date || dateIso}. Log one first via the Attendance tab.</div>`;
    return;
  }
  host.innerHTML = `
    <div class="form-group">
      <label>Conduct</label>
      <select id="rep-conduct-id" onchange="regenerateReport('CONDUCT')" style="padding:7px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;width:100%">
        ${matches.map(a => `<option value="${a.id}" ${a.id === selectedId ? "selected" : ""}>${a.time || "----"} · ${escapeAttr(conductName(a.conductId) || "(unknown)")} (${a.participating}/${a.total})</option>`).join("")}
      </select>
    </div>
  `;
}

// Date change → re-render the date-scoped checklists + regenerate the textarea.
function onParadeDateChange(type) {
  _paradeOverrides = {};
  renderBorderlineSection(gv("rep-date"), type);
  renderApptCampSection(gv("rep-date"), type);
  regenerateReport(type);
}

// Time change only affects the MEDICAL APPT section's parade-time cutoff.
function onParadeTimeChange(type) {
  regenerateReport(type);
}

// Book-out checklist toggle (parade modal). Writes the PERSISTENT booked-out
// flag (shared with the dashboard) rather than a session-only tick, so finalising
// who's out at parade time also corrects the live strength board everywhere.
function toggleApptCamp(d4, checked, reason, type) {
  bookOutToggle(d4, checked, reason);   // bookOutToggle already re-renders + syncs
  renderApptCampSection(gv("rep-date"), type);
  regenerateReport(type);
}

// Book Out / Book In checklist for today's OUTSIDE appointments. Each checkbox
// reflects and toggles the recruit's PERSISTENT booked-out flag — ticking marks
// them out of camp (drops from current strength + the dashboard), unticking
// books them back in. Empty when there are no outside appointments today.
function renderApptCampSection(dateIso, type) {
  const section = document.getElementById("appt-camp-section");
  if (!section) return;
  const appts = outsideApptsForParade(dateIso);
  if (!appts.length) { section.innerHTML = ""; return; }
  const rows = appts.map(a => {
    const r = STATE.roster.find(x => x.id === a.d4);
    const checked = r && isBookedOut(r, dateIso) ? "checked" : "";
    const reason = "Appt: " + (a.reason || "appointment");
    return `<label style="display:flex;align-items:center;gap:8px;font-size:11px;padding:4px 6px;cursor:pointer;border-radius:4px" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <input type="checkbox" ${checked} onchange="toggleApptCamp('${a.d4}', this.checked, ${JSON.stringify(reason)}, '${type}')" style="width:14px;height:14px;cursor:pointer">
      <span>${paradeRN(a.d4)} — ${escapeAttr(a.reason || "")} (${fmtHrs(a.time)})</span>
    </label>`;
  }).join("");
  section.innerHTML = `<div style="font-size:11px;background:#58A6FF11;border:1px solid #58A6FF44;border-radius:6px;padding:8px 10px">
    <div style="color:var(--accent);font-weight:600;margin-bottom:4px">📅 Outside appointments today (${appts.length}) — tick = booked OUT of camp</div>
    <div style="color:var(--muted);margin-bottom:6px">Tick once the recruit has LEFT camp; untick when they book back in. This updates the live strength board for everyone.</div>
    ${rows}
  </div>`;
}

// Renders the borderline checklist for the given date. Empty section when
// no recently-ended MCs exist (no noise on normal days).
function renderBorderlineSection(dateIso, type) {
  const section = document.getElementById("borderline-section");
  if (!section) return;
  const candidates = findBorderlineReturnees(dateIso);
  if (!candidates.length) { section.innerHTML = ""; return; }
  const rows = candidates.map(m => {
    const checked = _paradeOverrides[m.d4] ? "checked" : "";
    const endShort = toDDMMYY(displayDateToISO(m.endDate || "")) || m.endDate || "";
    return `<label style="display:flex;align-items:center;gap:8px;font-size:11px;padding:4px 6px;cursor:pointer;border-radius:4px" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <input type="checkbox" ${checked} onchange="toggleBorderline('${m.d4}', this.checked, '${type}')" style="width:14px;height:14px;cursor:pointer">
      <span>${paradeRN(m.d4)} — ${m.status} ended ${endShort}</span>
    </label>`;
  }).join("");
  section.innerHTML = `<div style="font-size:11px;background:#D2992211;border:1px solid #D2992244;border-radius:6px;padding:8px 10px">
    <div style="color:var(--orange);font-weight:600;margin-bottom:4px">⚠ Borderline returnees (${candidates.length}) — MC/Warded ended yesterday</div>
    <div style="color:var(--muted);margin-bottom:6px">Tick anyone who hasn't actually booked back in yet. They'll be added to ATTC.</div>
    ${rows}
  </div>`;
}

function regenerateReport(type) {
  const dateIso = gv("rep-date");
  const time = gv("rep-time") || "0700";
  let text;
  if (type === "MED") text = generateMedicalStatusText(dateIso, time);
  else if (type === "MSK") text = generateMSKReportText(dateIso, time);
  else if (type === "CONDUCT") {
    const id = +gv("rep-conduct-id") || null;
    text = id ? buildConductChatFormat(id) : "Pick a conduct from the dropdown above.";
  } else text = generateParadeStateText(type, dateIso, time);
  document.getElementById("rep-text").value = text;
}

async function copyReportToClipboard() {
  const ta = document.getElementById("rep-text");
  const btn = document.getElementById("rep-copy-btn");
  const text = ta.value;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = "✓ Copied!";
      setTimeout(() => { btn.textContent = original; }, 1800);
    }
  } catch {
    // Fallback: select all in the textarea so the user can manually Cmd+C.
    ta.focus(); ta.select();
    alert("Copy blocked — text is selected, press Cmd+C / Ctrl+C to copy.");
  }
}

// ─── FITNESS REPORTS (email to recruits) ────────────────
// Builds a personalized HTML report per recruit with their Polar trends,
// conduct attendance, and an auto-picked encouragement line. Charts are
// rendered to off-screen canvases and base64-embedded so the email is
// fully self-contained (no external image hosting needed).

// Renders a Chart.js config to a base64 JPEG synchronously by disabling
// animation. JPEG (not PNG) because MailApp.sendEmail caps the htmlBody
// at 200KB and base64-encoded PNGs of these charts blow past that with
// 3+ charts. JPEG at 0.85 quality is ~5× smaller with no visible loss
// on line/bar charts.
//
// Trick: paint the white background AFTER Chart.js renders, using
// destination-over so the fill sits UNDER the existing chart pixels.
// Painting before doesn't work — Chart.js clears the canvas on draw.
function renderChartPNG(chartConfig, width = 500, height = 230) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const chart = new Chart(canvas, {
    ...chartConfig,
    options: {
      ...(chartConfig.options || {}),
      animation: false,
      responsive: false,
      maintainAspectRatio: false
    }
  });
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  chart.destroy();
  return jpeg;
}

// Compute polar-derived metrics (efficiency, workload) for a list of
// raw STATE.polar rows. Returns rows enriched + sorted ascending by date.
function computeFitnessMetrics(rows) {
  return rows.map(p => {
    const avg = +p.avgHr || 0, max = +p.maxHr || 0, cal = +p.calories || 0, dur = +p.duration || 0;
    return {
      date: p.date, conduct: conductName(p.conductId),
      iso: displayDateToISO(p.date) || "",
      avgHr: avg, maxHr: max, calories: cal, duration: dur,
      efficiency: avg ? +(cal / avg).toFixed(2) : 0,
      workload: avg * dur
    };
  }).filter(p => p.iso).sort((a, b) => a.iso < b.iso ? -1 : 1);
}

// Counts how many distinct PT conducts (date+conductId tuples) fell inside
// [startIso, endIso]. A conduct is considered "PT" when at least one recruit
// has a Polar/LMS entry for it — the Polar class summary photo is the
// authoritative signal that the session involved actual PT. Lecture-style
// or admin "conducts" (e.g. lectures, IPPT registration sessions) get
// attendance rows but no Polar data, so they're excluded from the denominator.
// This makes "Conducts attended X / Y" reflect the recruit's PT participation
// rather than every administrative gathering.
function countCompanyConductsInWindow(startIso, endIso) {
  // Set of "iso|conductId" keys that have at least one Polar entry in window.
  const ptKeys = new Set();
  STATE.polar.forEach(p => {
    if (!p.conductId) return;
    const iso = displayDateToISO(p.date);
    if (iso && iso >= startIso && iso <= endIso) ptKeys.add(`${iso}|${p.conductId}`);
  });
  // Intersect with the attendance log so we count only conducts the company
  // actually logged (avoids counting one-off polar entries that lack a real
  // attendance row).
  const tuples = new Set();
  STATE.attendance.forEach(a => {
    const iso = displayDateToISO(a.date);
    if (!iso || iso < startIso || iso > endIso || !a.conductId) return;
    const key = `${iso}|${a.conductId}`;
    if (ptKeys.has(key)) tuples.add(key);
  });
  return tuples.size;
}

// MC-days overlapping window — sum of (end - start + 1) clamped to window.
function countMCDaysInWindow(d4, startIso, endIso) {
  let days = 0;
  STATE.medical
    .filter(m => m.d4 === d4 && (m.status === "MC" || m.status === "Warded"))
    .forEach(m => {
      const s = displayDateToISO(m.startDate || "");
      const e = displayDateToISO(m.endDate || "");
      if (!s || !e) return;
      const lo = s < startIso ? startIso : s;
      const hi = e > endIso ? endIso : e;
      if (lo > hi) return;
      days += Math.round((new Date(hi) - new Date(lo)) / 86400000) + 1;
    });
  return days;
}

// Composes the full HTML email body for one recruit. Returns:
//   { htmlForEmail, htmlForPreview, inlineImages }
// htmlForEmail uses <img src="cid:..."> refs paired with `inlineImages`
// (Gmail blocks data: URIs in img src — cid: works fine).
// htmlForPreview uses inline data: URIs so it can render in an <iframe>.
// inlineImages is { cid_name: base64_string_without_prefix } passed to
// API.sendEmail along with htmlForEmail.
function buildFitnessReportHTML(d4, startIso, endIso) {
  const r = STATE.roster.find(x => x.id === d4);
  if (!r) return `<p>Recruit ${d4} not found.</p>`;

  // Pull every per-recruit data slice inside the window.
  const polar = computeFitnessMetrics(
    STATE.polar.filter(p => p.d4 === d4).filter(p => {
      const iso = displayDateToISO(p.date);
      return iso && iso >= startIso && iso <= endIso;
    })
  );
  const totalCoyConducts = countCompanyConductsInWindow(startIso, endIso);

  // Conducts in this window where this recruit was logged as not
  // participating. ReportSick is excluded — it happens mid-day, after the
  // conduct, so the recruit was present for the actual PT itself.
  const conductDetailRows = STATE.conductDetail.filter(c => {
    if (c.d4 !== d4) return false;
    const iso = displayDateToISO(c.date);
    return iso && iso >= startIso && iso <= endIso;
  });
  const skippedRows = conductDetailRows.filter(c => c.type === "PX" || c.type === "RSI" || c.type === "Fallout");
  const missedCount = skippedRows.length;
  const missedBreakdown = ["PX", "RSI", "Fallout"]
    .map(t => ({ t, n: skippedRows.filter(m => m.type === t).length }))
    .filter(x => x.n > 0)
    .map(x => `${x.n} ${x.t}`).join(" · ") || "none";

  // Conducts attended = total minus those they were absent from.
  // Polar classes joined = how many of those conducts they wore the watch for.
  const conductsAttended = Math.max(0, totalCoyConducts - missedCount);
  const attendanceRate = totalCoyConducts ? Math.round((conductsAttended / totalCoyConducts) * 100) : 0;
  const polarJoined = polar.length;
  const polarRate = totalCoyConducts ? Math.round((polarJoined / totalCoyConducts) * 100) : 0;
  // Report Sick = days the recruit was sent to MO mid-day after a conduct
  // (ReportSick conductDetail entries). Deduped by date because a single
  // recruit can fall out of multiple conducts on the same day (e.g. MC2,
  // gym ori, SC3) and get logged in each conduct's Report Sick list — but
  // they only went to MO once that day, so it's one event.
  const reportSickCount = new Set(
    conductDetailRows.filter(c => c.type === "ReportSick").map(c => c.date)
  ).size;
  // IPPT history: ALL attempts for the recruit, not just within the window.
  // The point of IPPT in a fitness report is to show fitness trajectory —
  // limiting to the window hides whether the recruit is on an improving
  // arc or plateauing. Sort by date so the chart reads left-to-right as
  // time progresses; fall back to attempt# when dates are missing.
  const ippts = STATE.ippt.filter(i => i.d4 === d4)
    .sort((a, b) => {
      const ai = displayDateToISO(a.date) || "";
      const bi = displayDateToISO(b.date) || "";
      if (ai !== bi) return ai < bi ? -1 : 1;
      return (+a.attempt || 0) - (+b.attempt || 0);
    });

  // Auto-encouragement: pick strongest positive trend.
  let encouragement;
  if (polar.length >= 2) {
    const first = polar[0], last = polar[polar.length - 1];
    const avgHrDelta = first.avgHr ? ((last.avgHr - first.avgHr) / first.avgHr) : 0;
    const effDelta = first.efficiency ? ((last.efficiency - first.efficiency) / first.efficiency) : 0;
    if (avgHrDelta < -0.05) {
      const drop = first.avgHr - last.avgHr;
      encouragement = `Your average HR has dropped <strong>${drop} bpm</strong> since ${first.date} — that's your heart working smarter, not harder. Real fitness gains.`;
    } else if (effDelta > 0.1) {
      encouragement = `Your cardio efficiency improved by <strong>${Math.round(effDelta * 100)}%</strong> in this window — every session is paying off.`;
    } else if (attendanceRate >= 90) {
      encouragement = `You showed up to <strong>${attendanceRate}%</strong> of conducts in this window. Consistency is the #1 driver of fitness — keep it going.`;
    }
  }
  if (!encouragement) {
    encouragement = `Every session counts. Small daily gains add up — keep showing up.`;
  }

  // Charts — each gets a unique cid so the email can use <img src="cid:..">
  // while the preview iframe uses the equivalent data: URI inline.
  const labels = polar.map(p => p.date.split(" ").slice(0, 2).join(" "));
  const charts = [];
  const inlineImages = {};
  let cidCounter = 0;
  const addChart = (entry, config) => {
    const cid = `chart_${cidCounter++}`;
    const dataUrl = renderChartPNG(config);
    inlineImages[cid] = dataUrl.split("base64,")[1] || "";
    charts.push({ ...entry, cid, dataUrl });
  };

  if (polar.length) {
    addChart({
      emoji: "❤", title: "Heart Rate Trend",
      caption: "Your average and peak heart rate across each session. As you get fitter, your average HR for the same workload drops — your heart pumps more blood per beat, so it doesn't have to work as hard. A steady downward trend in the blue line over weeks is the clearest signal of improving cardio fitness."
    }, {
      type: "line",
      data: { labels, datasets: [
        { label: "Avg HR", data: polar.map(p => p.avgHr), borderColor: "#58A6FF", backgroundColor: "#58A6FF22", tension: 0.3, pointRadius: 3 },
        { label: "Max HR", data: polar.map(p => p.maxHr), borderColor: "#F85149", backgroundColor: "#F8514922", tension: 0.3, pointRadius: 3 }
      ] },
      options: { plugins: { legend: { position: "bottom" } }, scales: { y: { title: { display: true, text: "bpm" } } } }
    });
    addChart({
      emoji: "⚡", title: "Cardio Efficiency",
      caption: "Calories burned per heartbeat (kcal ÷ avg HR). The higher this number, the more useful work your body produces per beat. When this line trends upward, your cardiovascular system is becoming more efficient — that's the kind of fitness gain that translates directly to faster runs, longer endurance, and lower 2.4 km times."
    }, {
      type: "line",
      data: { labels, datasets: [{ label: "Efficiency", data: polar.map(p => p.efficiency), borderColor: "#39D2C0", backgroundColor: "#39D2C033", tension: 0.3, fill: true, pointRadius: 3 }] },
      options: { plugins: { legend: { display: false } } }
    });
    addChart({
      emoji: "💪", title: "Cardiac Workload per Session",
      caption: "Total stress on your heart per session (avg HR × duration in minutes). This is the volume of training you're putting in. The shape of the bars matters more than the height — consistent, regular bars build aerobic base. Big spikes followed by long gaps don't. Showing up matters more than going hard."
    }, {
      type: "bar",
      data: { labels, datasets: [{ data: polar.map(p => p.workload), backgroundColor: "#BC8CFF44", borderColor: "#BC8CFF", borderWidth: 1 }] },
      options: { plugins: { legend: { display: false } } }
    });
  }
  // IPPT history table — one row per attempt with per-station score breakdown.
  // Inline HTML <table> (not a chart image) so it renders as text in both
  // email and preview, and so the reader can read the reps/time/points
  // directly. Per-station points are recomputed from the scoring tables on
  // the fly using the recruit's current age — keeps historical entries
  // consistent if scoring tiers ever change.
  const awardColorMap = { "Gold★": "#BC8CFF", "Gold": "#D29922", "Silver": "#8B949E", "Pass": "#1A7F37", "Fail": "#F85149" };
  const ipptRows = ippts.map(i => {
    const calc = calculateIPPTScore(r.age, i.pushups, i.situps, i.runTime);
    const puPts = calc ? calc.pushupScore : "—";
    const suPts = calc ? calc.situpScore : "—";
    const runPts = calc ? calc.runScore : "—";
    const total = +i.score || (calc ? calc.total : 0);
    const award = ipptAward(total);
    const awardColor = awardColorMap[award] || "#6E7681";
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:12px;color:#6E7681;white-space:nowrap">${i.date || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:12px;text-align:center">${i.attempt || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:12px;text-align:center"><strong>${i.pushups ?? "—"}</strong> <span style="color:#8B949E">·</span> <span style="color:#1F6FEB;font-weight:600">${puPts}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:12px;text-align:center"><strong>${i.situps ?? "—"}</strong> <span style="color:#8B949E">·</span> <span style="color:#1F6FEB;font-weight:600">${suPts}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:12px;text-align:center"><strong>${i.runTime || "—"}</strong> <span style="color:#8B949E">·</span> <span style="color:#1F6FEB;font-weight:600">${runPts}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:14px;text-align:center;font-weight:700;color:#161B22">${total}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #E1E4E8;font-size:11px;text-align:center;font-weight:700;color:${awardColor}">${award}</td>
    </tr>`;
  }).join("");
  const ipptTableHTML = ippts.length ? `
    <h2 style="font-size:16px;color:#161B22;margin:24px 0 4px">🏃 IPPT History <span style="font-size:11px;color:#6E7681;font-weight:400">(${ippts.length} attempt${ippts.length === 1 ? "" : "s"})</span></h2>
    <p style="font-size:12px;color:#6E7681;margin:0 0 10px;line-height:1.5">Every IPPT attempt logged. IPPT is the litmus test for overall fitness — the trend across attempts tells you more than any single score. Numbers shown as <strong>reps/time</strong> · <span style="color:#1F6FEB;font-weight:600">points</span>.</p>
    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #E1E4E8;border-radius:6px;overflow:hidden;margin-bottom:8px">
      <thead>
        <tr style="background:#F6F8FA">
          <th style="padding:8px 10px;text-align:left;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">Date</th>
          <th style="padding:8px 10px;text-align:center;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">#</th>
          <th style="padding:8px 10px;text-align:center;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">Push-ups</th>
          <th style="padding:8px 10px;text-align:center;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">Sit-ups</th>
          <th style="padding:8px 10px;text-align:center;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">2.4km Run</th>
          <th style="padding:8px 10px;text-align:center;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">Total</th>
          <th style="padding:8px 10px;text-align:center;font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E1E4E8">Award</th>
        </tr>
      </thead>
      <tbody>${ipptRows}</tbody>
    </table>
    <p style="font-size:10px;color:#8B949E;margin:0 0 16px;line-height:1.5">Tiers: ≥61 Pass · ≥75 Silver · ≥85 Gold · ≥90 Gold★ (NDU / Commando / Guards)</p>
  ` : "";

  const startNice = isoToDisplayDate(startIso);
  const endNice = isoToDisplayDate(endIso);
  const bareId = String(r.id).replace(/^C/i, "");
  const recHeader = `REC ${(r.name || "").toUpperCase()} ${bareId}`;

  // Two parallel chart blocks — same layout/captions, different image src.
  const noChartsBlock = `<p style="background:#FFF8E1;border:1px solid #FFE082;padding:12px;border-radius:6px;color:#5D4037;font-size:13px">No Polar sessions logged in this window — we'd love to see you in the next one.</p>`;
  const chartsBlockForEmail = charts.length
    ? charts.map(c => `
        <h2 style="font-size:16px;color:#161B22;margin:24px 0 4px">${c.emoji} ${c.title}</h2>
        <img src="cid:${c.cid}" alt="${c.title}" style="display:block;max-width:100%;height:auto;border-radius:6px;border:1px solid #E1E4E8" />
        <p style="font-size:13px;color:#6E7681;margin:6px 0 0;line-height:1.5">${c.caption}</p>
      `).join("")
    : noChartsBlock;
  const chartsBlockForPreview = charts.length
    ? charts.map(c => `
        <h2 style="font-size:16px;color:#161B22;margin:24px 0 4px">${c.emoji} ${c.title}</h2>
        <img src="${c.dataUrl}" alt="${c.title}" style="display:block;max-width:100%;height:auto;border-radius:6px;border:1px solid #E1E4E8" />
        <p style="font-size:13px;color:#6E7681;margin:6px 0 0;line-height:1.5">${c.caption}</p>
      `).join("")
    : noChartsBlock;

  const wrapper = (chartsBlock) => `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F6F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#161B22">
  <div style="max-width:640px;margin:0 auto;padding:24px;background:#FFFFFF">

    <div style="background:linear-gradient(135deg,#1F6FEB,#58A6FF);color:#fff;padding:20px;border-radius:10px;margin-bottom:20px">
      <div style="font-size:12px;letter-spacing:2px;opacity:.85">🐆 COUGAR COY</div>
      <div style="font-size:22px;font-weight:700;margin-top:2px">Fitness Report</div>
      <div style="font-size:13px;opacity:.9;margin-top:8px">${recHeader}</div>
      <div style="font-size:12px;opacity:.8">${startNice} → ${endNice}</div>
    </div>

    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:8px;margin-bottom:8px">
      <tr>
        <td style="background:#F6F8FA;border:1px solid #E1E4E8;border-radius:8px;padding:14px;text-align:center;width:25%">
          <div style="font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px">Conducts attended</div>
          <div style="font-size:24px;font-weight:700;color:#1A7F37;margin-top:4px">${conductsAttended}/${totalCoyConducts}</div>
          <div style="font-size:11px;color:#6E7681">${attendanceRate}% present</div>
        </td>
        <td style="background:#F6F8FA;border:1px solid #E1E4E8;border-radius:8px;padding:14px;text-align:center;width:25%">
          <div style="font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px">Polar classes joined</div>
          <div style="font-size:24px;font-weight:700;color:#1F6FEB;margin-top:4px">${polarJoined}/${totalCoyConducts}</div>
          <div style="font-size:11px;color:#6E7681">${polarRate}% with HR data</div>
        </td>
        <td style="background:#F6F8FA;border:1px solid #E1E4E8;border-radius:8px;padding:14px;text-align:center;width:25%">
          <div style="font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px">Conducts missed</div>
          <div style="font-size:24px;font-weight:700;color:#F85149;margin-top:4px">${missedCount}</div>
          <div style="font-size:10px;color:#6E7681;line-height:1.4">${missedBreakdown}</div>
        </td>
        <td style="background:#F6F8FA;border:1px solid #E1E4E8;border-radius:8px;padding:14px;text-align:center;width:25%">
          <div style="font-size:10px;color:#6E7681;text-transform:uppercase;letter-spacing:.5px">Report Sick</div>
          <div style="font-size:24px;font-weight:700;color:#D29922;margin-top:4px">${reportSickCount}</div>
          <div style="font-size:11px;color:#6E7681">in window</div>
        </td>
      </tr>
    </table>

    ${chartsBlock}

    ${ipptTableHTML}

    <div style="background:linear-gradient(135deg,#3FB95011,#39D2C022);border:1px solid #3FB95044;border-radius:10px;padding:18px;margin-top:24px">
      <div style="font-size:13px;font-weight:700;color:#1A7F37;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">🎯 Keep it up</div>
      <div style="font-size:14px;color:#161B22;line-height:1.55">${encouragement}</div>
      <div style="font-size:13px;color:#6E7681;margin-top:14px;font-style:italic">Stay strong. Stay healthy.<br>— Cougar Coy</div>
    </div>

    <div style="font-size:10px;color:#8B949E;text-align:center;margin-top:20px;padding-top:14px;border-top:1px solid #E1E4E8">
      This is an automated fitness report generated from your Polar HR data and conduct attendance records.
    </div>
  </div>
</body></html>`;

  return {
    htmlForEmail: wrapper(chartsBlockForEmail),
    htmlForPreview: wrapper(chartsBlockForPreview),
    inlineImages
  };
}

// Opens the report modal with date pickers, recruit picker, preview,
// test send, and bulk send. Fetches sender identity + quota on open so
// the user knows exactly which Gmail account emails will come from.
function openFitnessReportModal() {
  const today = todayISO();
  const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth() - 1);
  const monthAgoIso = monthAgo.toISOString().slice(0, 10);
  const recipients = filteredRoster().filter(r => r.role !== "Commander" && r.email);
  const skipped = filteredRoster().filter(r => r.role !== "Commander" && !r.email).length;
  const scopeNote = isFilterActive() ? ` in ${filterLabel()}` : "";

  // Recruit options for the preview/test dropdown — include any recruit
  // with non-empty email in the current scope.
  const recruitOptions = recipients.length
    ? recipients.map(r => `<option value="${r.id}">${displayPersonLabel(r.id)} — ${r.email}</option>`).join("")
    : `<option value="">(no recruits with email in scope)</option>`;

  openModal("📊 Email Fitness Reports", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.55">
        Sends one personalized report per recruit. Each contains their Polar trends, conduct attendance, and an auto-picked encouragement line. Recruits never see anyone else's data.
      </div>

      <div id="sender-info" style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px">
        🔍 Checking sender identity…
      </div>

      <div class="form-row">
        ${formField("rep-start", "Start date", "date", "", `value="${monthAgoIso}" required`)}
        ${formField("rep-end", "End date", "date", "", `value="${today}" required`)}
      </div>

      <div class="form-group">
        <label>Preview / Test recipient</label>
        <select id="rep-preview-d4" class="topbar-select" style="width:100%">${recruitOptions}</select>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="previewFitnessReport()" ${recipients.length ? "" : "disabled"}>👁 Preview</button>
        <input id="rep-test-email" type="email" placeholder="your@email.com" style="flex:1;min-width:160px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px">
        <button class="btn" onclick="sendTestReport()" ${recipients.length ? "" : "disabled"}>📨 Send test</button>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-top:-4px">"Send test" sends the selected recruit's report to YOUR address (above) — no recruit gets emailed. Use this to verify the full pipeline.</div>

      <hr style="border:none;border-top:1px solid var(--border);margin:4px 0">

      <div style="font-size:12px;color:var(--muted)" id="bulk-send-summary"></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer">
        <input id="rep-include-sent" type="checkbox" onchange="updateBulkSendSummary()" style="margin:0">
        Include recruits who already received a report on this device (re-send)
      </label>
      <button class="btn btn-success" onclick="sendAllReports()" ${recipients.length ? "" : "disabled"}>📨 Send to filtered recipients →</button>

      <div id="fitness-report-progress" style="display:none;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px"></div>

      <hr style="border:none;border-top:1px solid var(--border);margin:4px 0">

      <details style="font-size:11px;color:var(--muted)">
        <summary style="cursor:pointer;font-weight:600;color:var(--text);padding:4px 0">📋 Sent log — ${Object.keys(STATE.fitnessSent).length} recruit${Object.keys(STATE.fitnessSent).length === 1 ? "" : "s"} marked as sent (per-device)</summary>
        <div style="margin-top:8px;line-height:1.6">
          The bulk send remembers who's already been emailed in this browser's localStorage. On a new device, paste the JSON from your old device below to seed it — otherwise the bulk send won't know to skip them.
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn" onclick="exportFitnessSentToClipboard()">📋 Copy sent log JSON</button>
          <button class="btn" onclick="openImportFitnessSentModal()">📥 Import sent log</button>
          <button class="btn btn-danger" onclick="if(confirm('Clear the sent log on THIS device? Future bulk sends won\\'t skip anyone.')) { clearFitnessSent(); openFitnessReportModal(); }">🗑 Clear sent log</button>
        </div>
      </details>
    </div>`);

  // Initial summary fill — needs STATE.fitnessSent to be loaded, which it is.
  updateBulkSendSummary();

  // Async: fetch sender identity + quota. Three possible outcomes:
  //  1. Both succeed → show sender + quota
  //  2. Sender blank (no userinfo scope) → show generic "from your owner
  //     account" line + quota
  //  3. Quota errors (no send_mail scope yet) → show clear setup steps
  //     so the user knows how to grant the email permission
  API.getEmailInfo().then(info => {
    const el = document.getElementById("sender-info");
    if (!el) return;
    if (info.error) {
      el.innerHTML = `⚠ Could not reach Apps Script (${info.error})`;
      el.style.color = "var(--red)";
      return;
    }
    if (info.quotaError) {
      el.style.background = "#F8514922";
      el.style.borderColor = "#F8514944";
      el.style.color = "var(--text)";
      el.innerHTML = `⚠ <strong style="color:var(--red)">Email permission not granted yet</strong> — Apps Script can't access Gmail.<br><br>
        <strong>One-time setup (1 min):</strong><br>
        1. Open the Apps Script editor (Extensions → Apps Script from your sheet)<br>
        2. In the function dropdown, pick <code>sendEmailHelper</code><br>
        3. Click <strong>Run</strong> (the play button) — it'll fail because no recipient, but Google will prompt you to <strong>Authorize</strong> Gmail send permission<br>
        4. Grant the permission → close the editor → reopen this modal<br><br>
        Alternative: add <code>"oauthScopes": ["https://www.googleapis.com/auth/script.send_mail"]</code> to <code>appsscript.json</code> and redeploy.`;
      return;
    }
    const fromLine = info.senderEmail
      ? `from <strong style="color:var(--accent)">${info.senderEmail}</strong>`
      : `from your Apps Script owner account (check the Apps Script editor — top right)`;
    el.innerHTML = `📧 Emails sent ${fromLine} · Display name: "Cougar Coy Training" · Daily quota: <strong>${info.remainingQuota}</strong>`;
  }).catch(e => {
    const el = document.getElementById("sender-info");
    if (el) el.innerHTML = `⚠ Sender check failed: ${e.message}`;
  });
}

// Renders the selected recruit's report in a secondary modal so the user
// can sanity-check the layout + numbers before sending. Writes HTML
// directly into the iframe document because our email HTML contains
// single quotes that can't be safely embedded in a srcdoc attribute.
function previewFitnessReport() {
  const startIso = gv("rep-start");
  const endIso = gv("rep-end");
  if (!startIso || !endIso) { alert("Pick a start and end date first."); return; }
  const d4 = gv("rep-preview-d4");
  if (!d4) { alert("Pick a recruit to preview."); return; }
  const recruit = STATE.roster.find(r => r.id === d4);
  if (!recruit) { alert("Recruit not found."); return; }
  const { htmlForPreview } = buildFitnessReportHTML(d4, startIso, endIso);

  openModal("Preview — " + displayPersonLabel(d4), `
    <iframe id="preview-iframe" style="width:100%;height:600px;border:1px solid var(--border);border-radius:6px;background:#fff"></iframe>
    <div style="font-size:11px;color:var(--muted);margin-top:8px">Sample for ${displayPersonLabel(d4)}${recruit.email ? ` (${recruit.email})` : ""}. Close this to go back.</div>
  `);
  document.querySelector(".modal")?.classList.add("wide");

  setTimeout(() => {
    const iframe = document.getElementById("preview-iframe");
    if (!iframe) return;
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(htmlForPreview);
    doc.close();
  }, 50);
}

// Sends the SELECTED recruit's report to a custom email address — typically
// the sergeant's own inbox. No recruit actually receives anything. Use
// this to verify the rendering + email deliverability before bulk-sending.
async function sendTestReport() {
  const startIso = gv("rep-start");
  const endIso = gv("rep-end");
  if (!startIso || !endIso) { alert("Pick a start and end date first."); return; }
  const d4 = gv("rep-preview-d4");
  if (!d4) { alert("Pick a recruit to use as the sample report."); return; }
  const testEmail = (gv("rep-test-email") || "").trim();
  if (!testEmail || !/.+@.+\..+/.test(testEmail)) { alert("Enter a valid test email address."); return; }

  const subject = `[TEST] Cougar Fitness Report — ${displayPersonLabel(d4)}`;
  const { htmlForEmail, inlineImages } = buildFitnessReportHTML(d4, startIso, endIso);

  const progress = document.getElementById("fitness-report-progress");
  progress.style.display = "block";
  progress.innerHTML = `Sending test to <strong>${testEmail}</strong>…`;

  try {
    const res = await API.sendEmail(testEmail, subject, htmlForEmail, inlineImages);
    if (res.error) {
      progress.innerHTML = `<span style="color:var(--red)">⚠ Test failed: ${res.error}</span>`;
    } else {
      progress.innerHTML = `<span style="color:var(--green)">✓ Test sent to ${testEmail}.</span> Check your inbox (and spam folder). Quota left: ${res.remainingQuota}`;
    }
  } catch (e) {
    progress.innerHTML = `<span style="color:var(--red)">⚠ Test failed: ${e.message}</span>`;
  }
}

// Computes the actual send queue given current scope + the "include already
// sent" checkbox. Shared between the live summary line and the send loop so
// the count under the button always matches what the loop will do.
function computeFitnessSendQueue() {
  const includeSent = document.getElementById("rep-include-sent")?.checked;
  const all = filteredRoster().filter(r => r.role !== "Commander" && r.email);
  const sentMap = STATE.fitnessSent || {};
  const skipNoEmail = filteredRoster().filter(r => r.role !== "Commander" && !r.email).length;
  if (includeSent) return { queue: all, skipAlreadySent: 0, skipNoEmail, total: all.length };
  const queue = all.filter(r => !sentMap[r.id]);
  return { queue, skipAlreadySent: all.length - queue.length, skipNoEmail, total: all.length };
}

// Renders the "X recruits will be emailed (Y skipped...)" line under the
// bulk button. Called on open + whenever the include-sent checkbox changes.
function updateBulkSendSummary() {
  const el = document.getElementById("bulk-send-summary");
  if (!el) return;
  const { queue, skipAlreadySent, skipNoEmail, total } = computeFitnessSendQueue();
  const scopeNote = isFilterActive() ? ` in ${filterLabel()}` : "";
  let msg = `Bulk send to <strong style="color:var(--accent)">${queue.length}</strong> recruit${queue.length === 1 ? '' : 's'}${scopeNote}`;
  const notes = [];
  if (skipAlreadySent) notes.push(`${skipAlreadySent} skipped (already sent on this device)`);
  if (skipNoEmail) notes.push(`${skipNoEmail} skipped (no email on file)`);
  if (notes.length) msg += ` <span style="color:var(--dim)">(${notes.join(" · ")})</span>`;
  el.innerHTML = msg + ".";
}

// Sequential send loop — fires one email at a time so we can read the
// remaining quota after each call and abort cleanly when it hits 0. Records
// each successful send in STATE.fitnessSent so a future run skips them.
async function sendAllReports() {
  const startIso = gv("rep-start");
  const endIso = gv("rep-end");
  if (!startIso || !endIso) { alert("Pick a start and end date first."); return; }
  const { queue, skipAlreadySent } = computeFitnessSendQueue();
  if (!queue.length) {
    alert(skipAlreadySent
      ? `All ${skipAlreadySent} eligible recruits already received a report on this device. Tick "Include recruits who already received a report" to re-send.`
      : "No recruits with email in current scope.");
    return;
  }
  if (!confirm(`Send fitness reports to ${queue.length} recruit${queue.length === 1 ? "" : "s"}? This cannot be undone.${skipAlreadySent ? `\n\n(${skipAlreadySent} already-sent recruits will be skipped.)` : ""}`)) return;

  const progress = document.getElementById("fitness-report-progress");
  progress.style.display = "block";
  let sent = 0, failed = 0, skippedQuota = 0, lastQuota = "?";

  const startNice = isoToDisplayDate(startIso);
  const endNice = isoToDisplayDate(endIso);
  const subject = `Your Cougar Fitness Report — ${startNice} → ${endNice}`;

  for (let i = 0; i < queue.length; i++) {
    const r = queue[i];
    progress.innerHTML = `Sending ${i + 1}/${queue.length} — currently <strong>${displayPersonLabel(r.id)}</strong><br><span style="color:var(--muted)">✓ ${sent} sent · ⚠ ${failed} failed · quota left: ${lastQuota}</span>`;
    try {
      const { htmlForEmail, inlineImages } = buildFitnessReportHTML(r.id, startIso, endIso);
      const res = await API.sendEmail(r.email, subject, htmlForEmail, inlineImages);
      if (res.error) {
        failed++;
        if (res.remainingQuota === 0) {
          skippedQuota = queue.length - i - 1;
          break;
        }
      } else {
        sent++;
        markFitnessSent(r.id);  // Persist so future runs skip this recruit.
        lastQuota = res.remainingQuota ?? "?";
        if (res.remainingQuota === 0 && i < queue.length - 1) {
          skippedQuota = queue.length - i - 1;
          break;
        }
      }
    } catch (e) {
      failed++;
    }
  }

  updateBulkSendSummary();
  progress.innerHTML = `<strong style="color:var(--green)">✓ Done.</strong> ${sent} sent · ${failed} failed${skippedQuota ? ` · ${skippedQuota} not sent (daily quota hit — retry tomorrow)` : ""} · quota left: ${lastQuota}`;
}

// Copies the per-device sent map to the clipboard as pretty JSON so it can
// be pasted into another device's import modal. Used when the user switches
// laptops mid-cohort or when seeding a fresh browser cache.
async function exportFitnessSentToClipboard() {
  const json = JSON.stringify(STATE.fitnessSent, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    alert(`Copied ${Object.keys(STATE.fitnessSent).length} sent-log entries to clipboard. Paste into the import modal on the other device.`);
  } catch (e) {
    // Fallback: show in a textarea so the user can copy manually.
    openModal("Sent log JSON (copy manually)", `
      <p style="font-size:11px;color:var(--muted);margin-bottom:8px">Clipboard access denied. Copy this JSON manually and paste into the import modal on the other device.</p>
      <textarea readonly style="width:100%;height:320px;font-family:var(--mono);font-size:11px;padding:8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:4px" onclick="this.select()">${escapeAttr(json)}</textarea>
    `);
  }
}

function openImportFitnessSentModal() {
  openModal("Import sent log", `
    <p style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.5">
      Paste the JSON exported from your other device. Entries are merged into this device's existing log (more-recent timestamp wins per d4), so importing is non-destructive.
    </p>
    <textarea id="fitness-import-textarea" placeholder='{ "1101": "2026-05-27T14:40:25.296Z", ... }' style="width:100%;height:280px;font-family:var(--mono);font-size:11px;padding:8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:4px"></textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-success" onclick="confirmImportFitnessSent()">Merge into sent log</button>
    </div>
  `);
}

function confirmImportFitnessSent() {
  const raw = document.getElementById("fitness-import-textarea")?.value || "";
  const result = importFitnessSent(raw);
  if (!result.ok) { alert("Import failed: " + result.error); return; }
  closeModal();
  alert(`Imported. ${result.added} new entries added, ${result.updated} updated. Total now: ${result.total}.`);
  openFitnessReportModal();
}

// ─── CONDUCT REGISTRY MIGRATION ──────────────────────────
// Promotes legacy free-text `conduct` strings on attendance/polar/conductDetail
// records into a stable `conductId` referencing STATE.conducts. Runs once on
// the first launch after the refactor ships (detected by an empty registry
// alongside any record that still carries a string `conduct` field).

// True if there's legacy data that hasn't been migrated yet.
function needsConductMigration() {
  if ((STATE.conducts || []).length > 0) return false;
  const hasLegacy = (arr) => (arr || []).some(r => typeof r?.conduct === "string" && r.conduct.trim());
  return hasLegacy(STATE.attendance) || hasLegacy(STATE.polar) || hasLegacy(STATE.conductDetail);
}

// In-memory working state for the review modal. Each group:
//   { gid: "g0", canonical: "Orientation Run", variants: [{name, count}, …], count, key }
// gid is a temporary id used only by modal event handlers — the real
// conductId is assigned at commit time.
let _conductMigrationGroups = null;

// Group every unique conduct string across attendance / polar / conductDetail
// by normalizeConductKey. For each bucket, pick the most-frequent variant
// as the proposed canonical name (ties broken by longest, since the longer
// variant usually has the full punctuation/capitalization). Sorted by
// total usage descending so heavy-traffic conducts surface first in the modal.
function buildConductRegistryProposal() {
  const buckets = new Map();
  const accumulate = (arr) => (arr || []).forEach(r => {
    const raw = r?.conduct;
    if (typeof raw !== "string" || !raw.trim()) return;
    const key = normalizeConductKey(raw);
    if (!buckets.has(key)) buckets.set(key, new Map());
    const variants = buckets.get(key);
    variants.set(raw, (variants.get(raw) || 0) + 1);
  });
  accumulate(STATE.attendance);
  accumulate(STATE.polar);
  accumulate(STATE.conductDetail);

  const out = [];
  for (const [key, variants] of buckets) {
    const sorted = [...variants.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    const canonical = sorted[0][0];
    const total = sorted.reduce((s, [, n]) => s + n, 0);
    out.push({
      key,
      canonical,
      variants: sorted.map(([name, count]) => ({ name, count })),
      count: total
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

// Called from bootstrap on launch and as a manual fallback from the Conducts
// admin tab. Opens the review modal only if there's actually legacy data to
// migrate; otherwise no-op.
function maybeRunConductMigration() {
  if (!needsConductMigration()) return;
  openConductReviewModal();
}

function openConductReviewModal() {
  const proposal = buildConductRegistryProposal();
  if (proposal.length === 0) {
    alert("No legacy conducts to migrate.");
    return;
  }
  _conductMigrationGroups = proposal.map((p, i) => ({ ...p, gid: "g" + i }));
  renderConductReviewModal();
}

function renderConductReviewModal() {
  const groups = _conductMigrationGroups;
  const body = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.5">
      Each entry below becomes one conduct in the registry with a stable ID. Records
      using any variant beneath get repointed to that ID. Spaces are shown as · so
      hidden whitespace differences are visible.
    </p>
    <div id="conduct-review-list" style="display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow-y:auto">
      ${groups.map(g => `
        <div class="card" style="padding:10px 12px;background:var(--surface2)" data-gid="${g.gid}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <input type="text" value="${escapeAttr(g.canonical)}" oninput="updateConductGroupName('${g.gid}', this.value)" style="flex:1;font-weight:600;font-size:13px;padding:5px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text)">
            <span style="font-size:11px;color:var(--muted);white-space:nowrap">${g.count} rec${g.count === 1 ? "" : "s"}</span>
            <button class="btn btn-icon btn-danger" title="Drop this conduct (records using it will have an empty conductId)" onclick="dropConductGroup('${g.gid}')">✕</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;font-size:11px">
            ${g.variants.map(v => {
              const visible = escapeAttr(v.name).replace(/ /g, '·');
              const enc = encodeURIComponent(v.name);
              return `
                <div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--surface);border-radius:3px">
                  <code style="flex:1;font-family:var(--mono);color:var(--text);font-size:11px">"${visible}"</code>
                  <span style="color:var(--muted);min-width:28px;text-align:right">${v.count}×</span>
                  <button class="btn btn-icon" title="Split this variant into its own new conduct" onclick="splitConductVariant('${g.gid}', decodeURIComponent('${enc}'))">⤴</button>
                  <select onchange="if (this.value) { moveConductVariant('${g.gid}', decodeURIComponent('${enc}'), this.value); this.value=''; }" style="font-size:10px;padding:2px 4px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:3px">
                    <option value="">Merge →</option>
                    ${groups.filter(o => o.gid !== g.gid).map(o => `<option value="${o.gid}">${escapeAttr(o.canonical).slice(0, 40)}</option>`).join("")}
                  </select>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `).join("")}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <span style="font-size:11px;color:var(--muted)">${groups.length} conduct${groups.length === 1 ? "" : "s"} · ${groups.reduce((s, g) => s + g.count, 0)} records</span>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="closeModal()">Review later</button>
        <button class="btn btn-success" onclick="commitConductMigration()">Commit migration</button>
      </div>
    </div>
  `;
  openModal(`Review conducts (${groups.length})`, body);
}

function updateConductGroupName(gid, name) {
  const g = _conductMigrationGroups.find(x => x.gid === gid);
  if (g) g.canonical = name;
}

function dropConductGroup(gid) {
  if (!confirm("Drop this conduct? Records using its variants will have an empty conductId after migration.")) return;
  _conductMigrationGroups = _conductMigrationGroups.filter(g => g.gid !== gid);
  renderConductReviewModal();
}

function splitConductVariant(gid, variantName) {
  const g = _conductMigrationGroups.find(x => x.gid === gid);
  if (!g) return;
  const idx = g.variants.findIndex(v => v.name === variantName);
  if (idx === -1) return;
  const v = g.variants.splice(idx, 1)[0];
  g.count -= v.count;
  const maxN = _conductMigrationGroups.reduce((m, x) => Math.max(m, parseInt(x.gid.slice(1), 10) || 0), -1);
  _conductMigrationGroups.push({ gid: "g" + (maxN + 1), canonical: v.name, variants: [v], count: v.count, key: normalizeConductKey(v.name) });
  if (g.variants.length === 0) _conductMigrationGroups = _conductMigrationGroups.filter(x => x.gid !== gid);
  renderConductReviewModal();
}

function moveConductVariant(fromGid, variantName, toGid) {
  const from = _conductMigrationGroups.find(x => x.gid === fromGid);
  const to = _conductMigrationGroups.find(x => x.gid === toGid);
  if (!from || !to) return;
  const idx = from.variants.findIndex(v => v.name === variantName);
  if (idx === -1) return;
  const v = from.variants.splice(idx, 1)[0];
  from.count -= v.count;
  const dup = to.variants.find(x => x.name === v.name);
  if (dup) dup.count += v.count;
  else to.variants.push(v);
  to.count += v.count;
  if (from.variants.length === 0) _conductMigrationGroups = _conductMigrationGroups.filter(x => x.gid !== fromGid);
  renderConductReviewModal();
}

async function commitConductMigration() {
  const groups = _conductMigrationGroups;
  if (!groups || groups.length === 0) { closeModal(); return; }

  // Validate: every group needs a non-empty canonical name.
  const blank = groups.find(g => !g.canonical || !g.canonical.trim());
  if (blank) { alert("One or more conducts have an empty name. Fill them in or drop them, then commit again."); return; }

  // Assign final ids; build name→id and key→id maps for rewriting records.
  const registry = groups.map((g, i) => ({ id: "c" + String(i + 1).padStart(3, "0"), name: g.canonical.trim() }));
  const nameToId = new Map();
  const keyToId = new Map();
  groups.forEach((g, i) => {
    g.variants.forEach(v => nameToId.set(v.name, registry[i].id));
    keyToId.set(g.key, registry[i].id);
  });

  // Repoint every record: lookup by exact variant name first (preserves any
  // user-driven re-grouping done in the modal), then fall back to normalized
  // key (covers records that share a key with a known variant but had a
  // string we didn't see — defensive).
  const rewrite = (arr) => (arr || []).forEach(r => {
    if (typeof r.conduct !== "string") return;
    const id = nameToId.get(r.conduct) || keyToId.get(normalizeConductKey(r.conduct)) || "";
    r.conductId = id;
    delete r.conduct;
  });
  rewrite(STATE.attendance);
  rewrite(STATE.polar);
  rewrite(STATE.conductDetail);

  STATE.conducts = registry;
  // Backfill LMS counts now that polar/attendance can finally join on
  // conductId. Before this migration the LMS column was likely stale on rows
  // where the conduct string had any drift between the two layers.
  const lmsChanged = recomputeAttendanceLmsFromPolar().length;
  saveLocal();
  closeModal();
  render();

  // The sheet push is part of the atomic migration — not optional. If we
  // skipped it, future appendRow/appendMany on PolarFlow / Attendance /
  // ConductDetail would write into the OLD schema (which still has a
  // `conduct` column, not `conductId`), silently dropping the conductId
  // values. Push all four tabs via autoSync so the indicator + dirty-
  // tracking handle any failure — user can retry from the sidebar.
  if (STATE.apiUrl) {
    autoSync("Conducts", { type: "replace", data: STATE.conducts });
    autoSync("Attendance", { type: "replace", data: STATE.attendance });
    autoSync("PolarFlow", { type: "replace", data: STATE.polar });
    autoSync("ConductDetail", { type: "replace", data: STATE.conductDetail });
  }
  alert(`Migrated ${registry.length} conduct${registry.length === 1 ? "" : "s"} and syncing to the Google Sheet.\n${lmsChanged ? `Backfilled LMS on ${lmsChanged} attendance row${lmsChanged === 1 ? "" : "s"} from Polar data.\n` : ""}\nConducts tab created; Attendance / PolarFlow / ConductDetail now use the conductId column.\n\nWatch the sidebar sync indicator — if any push fails, click "Retry now" to re-send.`);
}

// ─── CONDUCT REGISTRY CRUD ───────────────────────────────
// Create a new conduct from any UI that has access to a name string. If a
// conduct with the same normalized name already exists, returns its id
// (idempotent) so the calling form can just select the existing entry.
function createConduct(name) {
  const clean = String(name || "").trim();
  if (!clean) return "";
  const existing = conductIdByName(clean);
  if (existing) return existing;
  const id = nextConductId();
  const entry = { id, name: clean };
  STATE.conducts.push(entry);
  saveLocal();
  // Auto-push the new row — the original bug fix. Other devices pulling
  // immediately after will resolve the new conductId to its name instead
  // of showing `[c00X?]` placeholders.
  autoSync("Conducts", { type: "append", row: entry });
  return id;
}

// Groups of conducts that share the same id (data corruption from the old
// max+1 id scheme). Returns [{ id, conducts: [refs…] }] for ids used >1 time.
function duplicateConductIdGroups() {
  const byId = {};
  (STATE.conducts || []).forEach(c => { (byId[c.id] = byId[c.id] || []).push(c); });
  return Object.keys(byId)
    .filter(id => byId[id].length > 1)
    .map(id => ({ id, conducts: byId[id] }));
}

// Repair modal: for each shared id, the user picks which conduct KEEPS the id
// (and therefore the records logged under it — they're ambiguous, so only the
// owner the user knows about can claim them). The other conducts in the group
// get fresh unique ids and start empty.
function openFixConductIdsModal() {
  const groups = duplicateConductIdGroups();
  if (!groups.length) { alert("No duplicate conduct ids — nothing to fix."); return; }
  const blocks = groups.map((g, gi) => {
    const u = countConductUsage(g.id);
    const usage = `${u.attendance} attendance · ${u.polar} polar · ${u.detail} detail (${u.total} record${u.total === 1 ? "" : "s"})`;
    const opts = g.conducts.map((c, ci) => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;background:var(--surface2);margin-bottom:4px">
        <input type="radio" name="dup-${gi}" value="${ci}" ${ci === 0 ? "checked" : ""} style="width:14px;height:14px">
        <span style="font-weight:600">${escapeAttr(c.name)}</span>
      </label>`).join("");
    return `<div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:700;margin-bottom:2px">Shared id <span class="mono" style="color:var(--accent)">${g.id}</span></div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">${usage} — these stay with the conduct you pick:</div>
      ${opts}
    </div>`;
  }).join("");
  openModal("Fix duplicate conduct ids", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.55">
        ${groups.length} id${groups.length === 1 ? " is" : "s are"} shared by multiple conducts, so their records resolve to the wrong name. Pick which conduct keeps each id (and its existing records); the others get fresh, empty ids. Records can't be auto-split — if some belong to a renamed conduct, re-point them after via <strong>Merge</strong> or by editing.
      </div>
      ${blocks}
      <button type="button" class="btn btn-primary" onclick="applyConductIdFixes()">Fix ids</button>
    </div>`);
}

function applyConductIdFixes() {
  const groups = duplicateConductIdGroups();
  let reassigned = 0;
  groups.forEach((g, gi) => {
    const sel = document.querySelector(`input[name="dup-${gi}"]:checked`);
    const keepIdx = sel ? +sel.value : 0;
    g.conducts.forEach((c, ci) => {
      if (ci === keepIdx) return;   // this one keeps the original id + records
      c.id = nextConductId();        // others get a fresh, unique, empty id
      reassigned++;
    });
  });
  saveLocal();
  closeModal();
  render();
  // Ids changed on existing rows, so a full rewrite (not per-row upsert) is the
  // safe way to persist — upsert would append new rows and orphan the old ones.
  if (STATE.apiUrl) pushTab("Conducts", STATE.conducts);
  alert(`Reassigned ${reassigned} conduct id${reassigned === 1 ? "" : "s"}.\nRecords stayed with the conduct you chose; the rest now have fresh, empty ids.`);
}

function renameConduct(id, newName) {
  const c = STATE.conducts.find(x => x.id === id);
  if (!c) return;
  const clean = String(newName || "").trim();
  if (!clean) { alert("Conduct name cannot be empty."); return; }
  const conflict = STATE.conducts.find(x => x.id !== id && normalizeConductKey(x.name) === normalizeConductKey(clean));
  if (conflict) { alert(`"${clean}" already exists (${conflict.id}). Use Merge instead.`); return; }
  c.name = clean;
  saveLocal();
  autoSync("Conducts", { type: "upsert", row: c });
  render();
}

// Merges one conduct into another: every record pointing to fromId is
// repointed to toId, then fromId is removed from the registry. Used both
// from the admin tab and indirectly from migration edits.
async function mergeConductInto(fromId, toId) {
  if (fromId === toId) return;
  let from = STATE.conducts.find(x => x.id === fromId);
  let to = STATE.conducts.find(x => x.id === toId);
  if (!from || !to) return;
  if (!confirm(`Merge "${from.name}" → "${to.name}"?\n\nAll records currently using "${from.name}" will be repointed to "${to.name}", and "${from.name}" will be removed from the registry.\n\nThis touches every record across Attendance, ConductDetail, and PolarFlow — those tabs will be re-pushed.`)) return;
  // Refresh the tabs this rewrites so the bulk replaces carry a current baseRev
  // (won't be rejected as stale) and repoint the very latest rows.
  if (STATE.apiUrl && STATE.authToken && API.pullTabs) {
    try {
      const pull = API.pullTabs(["Conducts", "Attendance", "ConductDetail", "PolarFlow"]);
      if (typeof setPullInFlight === "function") setPullInFlight(pull);
      await pull;
    } catch (e) { /* proceed on local data; the server OCC still guards */ }
  }
  // Re-resolve after the pull — another device may have merged/renamed already.
  from = STATE.conducts.find(x => x.id === fromId);
  to = STATE.conducts.find(x => x.id === toId);
  if (!from || !to) { render(); return; }
  const repoint = (arr) => (arr || []).forEach(r => { if (r.conductId === fromId) r.conductId = toId; });
  repoint(STATE.attendance);
  repoint(STATE.polar);
  repoint(STATE.conductDetail);
  STATE.conducts = STATE.conducts.filter(x => x.id !== fromId);
  saveLocal();
  // Surgical delete on the registry, full replace on the affected child
  // tabs (mergeConductInto rewrites N rows per tab — full replace is the
  // honest "this is a bulk rewrite" signal).
  autoSync("Conducts", { type: "delete", id: fromId });
  autoSync("Attendance", { type: "replace", data: STATE.attendance });
  autoSync("ConductDetail", { type: "replace", data: STATE.conductDetail });
  autoSync("PolarFlow", { type: "replace", data: STATE.polar });
  render();
}

function deleteConduct(id) {
  const c = STATE.conducts.find(x => x.id === id);
  if (!c) return;
  const usage = countConductUsage(id);
  if (usage.total > 0) {
    alert(`"${c.name}" is still used by ${usage.total} record${usage.total === 1 ? "" : "s"} (${usage.attendance} attendance, ${usage.polar} polar, ${usage.detail} detail). Merge it into another conduct first, or delete the records.`);
    return;
  }
  if (!confirm(`Delete "${c.name}"? It has no records using it.`)) return;
  STATE.conducts = STATE.conducts.filter(x => x.id !== id);
  saveLocal();
  autoSync("Conducts", { type: "delete", id });
  render();
}

function countConductUsage(id) {
  const attendance = STATE.attendance.filter(r => r.conductId === id).length;
  const polar = STATE.polar.filter(r => r.conductId === id).length;
  const detail = STATE.conductDetail.filter(r => r.conductId === id).length;
  return { attendance, polar, detail, total: attendance + polar + detail };
}

// ─── CONDUCT PICKER (form widget) ────────────────────────
// Renders the conduct <select> used by attendance / conductDetail / polar
// staging forms. Selecting "+ New conduct" prompts for a name inline, creates
// the registry entry, and selects its id. The hidden input mirrors the
// current id so form submit handlers can read it via gv(inputId).
//
//   conductPicker({ inputId, selectedId, onChange })
//     inputId:    DOM id of the hidden input that stores the conductId
//     selectedId: pre-selected conductId (e.g. when editing an existing row)
//     onChange:   optional JS expression run after selection changes
//                 (use to update derived form fields like inferred time)
function conductPicker({ inputId, selectedId = "", onChange = "" }) {
  const opts = getAllConducts();
  const onChangeJS = `handleConductPickerChange('${inputId}', this); ${onChange}`;
  return `
    <input type="hidden" id="${inputId}" value="${escapeAttr(selectedId)}">
    <select onchange="${onChangeJS}" style="width:100%;padding:7px 10px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:13px">
      <option value="" ${selectedId ? "" : "selected"}>— pick a conduct —</option>
      ${opts.map(c => `<option value="${c.id}" ${c.id === selectedId ? "selected" : ""}>${escapeAttr(c.name)}</option>`).join("")}
      <option value="__new__">+ New conduct…</option>
    </select>
  `;
}

// Companion to conductPicker(). When the user picks "+ New conduct…" we
// prompt for a name, create the registry entry, and select it inline. We
// avoid a full render() here so any modal currently open (e.g. attendance
// form) doesn't get torn down mid-edit.
function handleConductPickerChange(inputId, selectEl) {
  const hidden = document.getElementById(inputId);
  if (!hidden) return;
  if (selectEl.value === "__new__") {
    const name = (prompt("New conduct name:") || "").trim();
    if (!name) {
      selectEl.value = hidden.value || "";
      return;
    }
    const id = createConduct(name);
    hidden.value = id;
    // Patch this select inline so the new option appears + is selected.
    // Other pickers on the page will refresh next time the user opens them.
    const existingOpt = [...selectEl.options].find(o => o.value === id);
    if (!existingOpt) {
      const newOpt = document.createElement("option");
      newOpt.value = id;
      newOpt.textContent = name;
      const newConductOpt = [...selectEl.options].find(o => o.value === "__new__");
      if (newConductOpt) selectEl.insertBefore(newOpt, newConductOpt);
      else selectEl.appendChild(newOpt);
    }
    selectEl.value = id;
  } else {
    hidden.value = selectEl.value;
  }
}

// Normalize any date string to ISO ("2026-05-17") so the polar↔attendance
// join works regardless of which format each side was stored in. The two
// sides accumulate different formats over time:
//   - Form-entered attendance:    "17 May 2026" (display, via isoToDisplayDate)
//   - CSV-imported polar:         "2026-05-17" (raw from CSV, untouched)
//   - Photo-extracted polar:      "17 May 2026" (display, via isoToDisplayDate)
//   - Sheet-pulled rows:          either, depending on how the cell was stored
// Returning ISO from every path means joins compare apples to apples.
function dateJoinKey(d) {
  const s = String(d || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const iso = displayDateToISO(s);
  if (iso) return iso;
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  return s;
}

// Builds the conduct-matching key for a record. Prefers conductId (post-
// migration source of truth); falls back to a normalized conduct-name key
// for records that still carry a legacy `conduct` string. Returns "" when
// neither is present so the caller can skip those rows.
function conductJoinKey(rec) {
  if (rec.conductId) return "id:" + rec.conductId;
  if (typeof rec.conduct === "string" && rec.conduct.trim()) return "name:" + normalizeConductKey(rec.conduct);
  return "";
}

// Writes the unique-d4 count from STATE.polar into STATE.attendance[].lms
// for every matching (date, conduct) pair. The Polar class summary photo
// IS the LMS roster for that conduct — same screen, same count — so we
// treat Polar entries as the source of truth for LMS participation. The
// joiner is tolerant of (a) different date formats on each side, and (b)
// records that haven't migrated to conductId yet (falls back to normalized
// conduct-string matching). Returns the number of attendance rows whose
// lms value actually changed.
function recomputeAttendanceLmsFromPolar() {
  const polarByConduct = {};
  STATE.polar.forEach(p => {
    const ck = conductJoinKey(p);
    if (!ck) return;
    const k = `${dateJoinKey(p.date)}|${ck}`;
    (polarByConduct[k] = polarByConduct[k] || new Set()).add(padD4(p.d4));
  });
  const changedRows = [];
  STATE.attendance.forEach(a => {
    if ("polar" in a) delete a.polar;
    const ck = conductJoinKey(a);
    if (!ck) return;
    const count = polarByConduct[`${dateJoinKey(a.date)}|${ck}`]?.size;
    if (count == null) return;
    if ((+a.lms || 0) !== count) {
      a.lms = count;
      changedRows.push(a);
    }
  });
  if (changedRows.length) saveLocal();
  // Returns the attendance rows whose LMS changed (truthy .length lets callers
  // also use it as a count). Pull callers ignore the return; the polar-import
  // caller upserts these rows individually (merge-safe) rather than a full replace.
  return changedRows;
}

// Human label for a polar/attendance key — used in the diagnostic alert
// so the user can read mismatched entries without decoding "id:c003".
function describeJoinKey(k) {
  const [d, ck] = k.split("|");
  if (ck?.startsWith("id:")) {
    const id = ck.slice(3);
    return `${d} — ${conductName(id) || `(unknown id ${id})`}`;
  }
  if (ck?.startsWith("name:")) {
    return `${d} — "${ck.slice(5)}" (unmigrated legacy string)`;
  }
  return `${d} — ?`;
}

// Manual trigger from the Attendance tab header. Surfaces matched/unmatched
// counts so the user can diagnose why a recompute didn't move some rows.
function refreshLmsFromPolar() {
  const polarKeys = new Set();
  let polarSkipped = 0;
  STATE.polar.forEach(p => {
    const ck = conductJoinKey(p);
    if (!ck) { polarSkipped++; return; }
    polarKeys.add(`${dateJoinKey(p.date)}|${ck}`);
  });
  const attendanceKeys = new Set();
  let attendanceSkipped = 0;
  STATE.attendance.forEach(a => {
    const ck = conductJoinKey(a);
    if (!ck) { attendanceSkipped++; return; }
    attendanceKeys.add(`${dateJoinKey(a.date)}|${ck}`);
  });
  const unmatched = [...polarKeys].filter(k => !attendanceKeys.has(k));
  const matched = [...polarKeys].filter(k => attendanceKeys.has(k));
  const changed = recomputeAttendanceLmsFromPolar().length;
  render();

  let msg = changed
    ? `✓ Updated LMS on ${changed} attendance row${changed === 1 ? "" : "s"} from Polar data.`
    : `No LMS values changed.`;
  msg += `\n\nDiagnostic:`;
  msg += `\n  • Polar (date, conduct) pairs: ${polarKeys.size} unique${polarSkipped ? ` (+ ${polarSkipped} polar rows skipped: no conductId or conduct name)` : ""}`;
  msg += `\n  • Attendance (date, conduct) pairs: ${attendanceKeys.size} unique${attendanceSkipped ? ` (+ ${attendanceSkipped} attendance rows skipped: no conductId or conduct name)` : ""}`;
  msg += `\n  • Matched: ${matched.length} · Unmatched (polar with no attendance row): ${unmatched.length}`;
  if (unmatched.length) {
    const preview = unmatched.slice(0, 8).map(describeJoinKey).join("\n  • ");
    msg += `\n\nUnmatched Polar entries:\n  • ${preview}${unmatched.length > 8 ? `\n  • …and ${unmatched.length - 8} more` : ""}`;
  }
  if (polarSkipped > 0 || attendanceSkipped > 0) {
    msg += `\n\n⚠️ Skipped rows mean the conduct registry migration hasn't completed for them. Run it from the Conducts tab if needed.`;
  }
  if (changed) msg += `\n\n→ Click "Push to Sheet" on the Attendance tab to sync the updated LMS counts back to the Google Sheet.`;
  alert(msg);
}

// ─── LOG CONDUCT WIZARD ───────────────────────────────
// Single-modal wizard that captures one conduct's full attendance + every
// non-participating row in one shot. Replaces the two-form input flow
// (openAttendanceForm + openConductDetailForm) as the primary entry point —
// the legacy forms still open for single-row edits via the table actions.
//
// State shape:
//   _logConduct = {
//     attendanceId,            // null for new, attendance row id for edit
//     date,                    // ISO "2026-05-29"
//     time,                    // "0730" — empty until conduct picked
//     conductId,               // c001 etc.
//     program,                 // "PTP" / "BMT" / "Combined" — part of the key
//     totalOverride,           // null = derive from roster, else explicit number
//     remarks,                 // free text
//     status: [                // pre-existing-status checklist
//       { d4, statusTag, reason, notParticipating }
//     ],
//     rsi:        [{ d4, reason }],   // reported sick at FP (no participation)
//     fallout:    [{ d4, reason }],   // dropped out mid-conduct, didn't go to MO
//     reportSick: [{ d4, reason }]    // dropped out mid-conduct AND went to MO
//   }
let _logConduct = null;

// Default program for a NEW conduct: honour the active topbar program scope if
// one is set, else "Combined". Editing an existing conduct loads the row's own
// program instead (see openLogConductWizard).
function defaultWizardProgram() {
  return STATE.filterProgram || PROGRAM_COMBINED;
}

// Open the wizard. Pass an attendance row id to load it in edit mode.
function openLogConductWizard(attendanceId) {
  const a = attendanceId ? STATE.attendance.find(x => x.id === attendanceId) : null;
  _logConduct = {
    attendanceId: a?.id || null,
    date: a ? displayDateToISO(a.date) || todayISO() : todayISO(),
    time: a?.time || "",
    conductId: a?.conductId || "",
    program: a ? progKey(a) : defaultWizardProgram(),
    totalOverride: a ? a.total : null,
    remarks: a?.remarks || "",
    status: [],
    rsi: [],
    fallout: [],
    reportSick: [],
    // Original conductDetail row ids loaded into the wizard on edit. Save
    // diffs against the new set and deletes any id that's no longer present,
    // so the surgical sheet sync only touches rows that actually changed
    // (vs full-tab replace which would risk clobbering parallel edits).
    originalDetailIds: []
  };
  // Edit mode: pre-load every conductDetail row matching this attendance's
  // (date, time, conductId, program). Status personnel auto-rebuild already
  // handles marking PX rows correctly via the existing-PX lookup.
  if (a) {
    const matchDetails = STATE.conductDetail.filter(d =>
      d.date === a.date && (d.time || "") === (a.time || "") && d.conductId === a.conductId && progKey(d) === progKey(a)
    );
    matchDetails.forEach(d => {
      // RSI is intentionally skipped — the wizard doesn't manage RSI anymore.
      // Legacy RSI rows pass through untouched on save (see saveLogConductWizard).
      if (d.type !== "RSI") _logConduct.originalDetailIds.push(d.id);
      if (d.type === "Fallout") _logConduct.fallout.push({ d4: d.d4, reason: d.reason || "" });
      else if (d.type === "ReportSick") _logConduct.reportSick.push({ d4: d.d4, reason: d.reason || "" });
    });
  }
  rebuildLogConductStatus();
  renderLogConductWizard();
}

// Pull orphaned conductDetail rows into the wizard when logging a conduct that
// already has detail rows for the chosen (date, time, conduct) but NO attendance
// summary row — e.g. after a duplicate-id split left detail behind. Without this,
// saving would wipe those rows; with it, they're loaded so the save reconstructs
// them and just adds the missing summary. Re-evaluated whenever the tuple changes.
function maybeLoadOrphanDetail() {
  const w = _logConduct;
  if (!w || w.attendanceId) return;            // edit mode loads its own detail
  if (!w.conductId || !w.date) return;
  const displayDate = isoToDisplayDate(w.date);
  const time = pad4Time(w.time || "");
  const program = w.program || PROGRAM_COMBINED;
  const key = `${displayDate}|${time}|${w.conductId}|${program}`;
  if (key === w._orphanKey) return;            // already evaluated this exact tuple

  // Don't clobber rows the user typed by hand. Safe to replace only when the
  // lists are empty, or were themselves auto-loaded (we own them — _orphanKey set).
  const userTyped = (w.fallout.length || w.reportSick.length) && w._orphanKey == null;
  if (userTyped) { w._orphanKey = key; return; }

  w.fallout = [];
  w.reportSick = [];
  w.originalDetailIds = [];
  w._orphanKey = key;
  w._recoveredCount = 0;

  // Only recover when there's no attendance summary for this tuple — that's the
  // orphan case. If a summary exists, the user should be editing it instead.
  const hasAttendance = STATE.attendance.some(a =>
    a.date === displayDate && (a.time || "") === time && a.conductId === w.conductId && progKey(a) === program
  );
  if (hasAttendance) return;

  STATE.conductDetail
    .filter(d => d.date === displayDate && (d.time || "") === time && d.conductId === w.conductId && progKey(d) === program)
    .forEach(d => {
      if (d.type === "RSI") return;            // wizard doesn't manage RSI
      w.originalDetailIds.push(d.id);
      if (d.type === "Fallout") w.fallout.push({ d4: d.d4, reason: d.reason || "" });
      else if (d.type === "ReportSick") w.reportSick.push({ d4: d.d4, reason: d.reason || "" });
      w._recoveredCount++;                     // counts PX too (reflected via status checklist)
    });
}

// Re-evaluate the wizard against its current (date, time, conduct): recover any
// orphaned detail, then rebuild the medical-status checklist.
function wizRefreshFromTuple() {
  maybeLoadOrphanDetail();
  rebuildLogConductStatus();
}

// Rebuilds the Status Personnel checklist from STATE.medical for the current
// date. Preserves any user edits (notParticipating + reason) when possible:
// if a d4 was already in the previous state list, carry over the flags.
function rebuildLogConductStatus() {
  if (!_logConduct) return;
  const prevByD4 = {};
  (_logConduct.status || []).forEach(s => { prevByD4[s.d4] = s; });
  // Seed "notParticipating" + reasons from existing PX conductDetail rows for
  // the current (date, time, conduct). Covers BOTH edit mode AND orphan recovery
  // (detail rows present but no attendance summary row yet), so re-opening shows
  // the correct ticks either way.
  const program = _logConduct.program || PROGRAM_COMBINED;
  let existingPxByD4 = {};
  if (_logConduct.conductId) {
    const dDate = isoToDisplayDate(_logConduct.date);
    const dTime = pad4Time(_logConduct.time || "");
    STATE.conductDetail
      .filter(d => d.date === dDate && (d.time || "") === dTime && d.conductId === _logConduct.conductId && progKey(d) === program && d.type === "PX")
      .forEach(d => { existingPxByD4[d.d4] = d.reason || ""; });
  }
  // True when there are existing detail rows backing this wizard (edit mode, or
  // orphaned detail loaded for recovery) — then PX ticks come from those rows
  // rather than the per-status default.
  const hasExistingDetail = !!_logConduct.attendanceId || (_logConduct.originalDetailIds || []).length > 0;
  const dateIso = _logConduct.date;
  // Commanders are not tracked in conduct attendance — exclude them. Also scope
  // to the selected program's platoons so a PTP conduct only lists PTP recruits
  // on status (Combined lists everyone).
  const programD4s = new Set(recruitsInProgram(program).map(r => r.id));
  const effective = currentMedicalEffectiveAll(dateIso)
    .filter(({ d4 }) => !isCommander(d4) && programD4s.has(d4));
  _logConduct.status = effective.map(({ d4, statuses }) => {
    // Pick the most-severe active status as the canonical tag/reason.
    const top = statuses[0];
    const prev = prevByD4[d4];
    // A status can mean "still does the conduct" (e.g. a finger injury). Default
    // to participating only when EVERY active status participates; any
    // restrictive status (MC/LD/Excuse/…) defaults the recruit to not-
    // participating. The user can always override per conduct.
    const defaultNP = statuses.some(s => !statusParticipates(s.tag));
    return {
      d4,
      // Concatenate every active status so the user sees "MC + Excuse Heavy Load"
      statusTag: statuses.map(s => s.tag).join(" + "),
      reason: prev ? prev.reason : (existingPxByD4[d4] ?? top.record.reason ?? ""),
      // First-time defaults from the per-status participation flag. When backed
      // by existing detail rows (edit or recovery), honor whether a PX row exists.
      notParticipating: prev ? prev.notParticipating
        : (hasExistingDetail ? (d4 in existingPxByD4) : defaultNP)
    };
  }).sort((a, b) => a.d4.localeCompare(b.d4));
}

// Builds the modal HTML and opens it. Re-rendering is full-replace; row-level
// mutations that wouldn't change focus or scroll position update DOM directly
// (e.g. count totals) instead of re-rendering.
function renderLogConductWizard() {
  if (!_logConduct) return;
  const w = _logConduct;
  const title = w.attendanceId ? "Edit Conduct" : "Log Conduct";
  const dateVal = w.date || todayISO();
  const totals = computeLogConductTotals();

  const editNotice = w.attendanceId
    ? `<div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin-bottom:4px">Editing existing conduct. Saving replaces all child rows for this (date, time, conduct) tuple.</div>`
    : (w._recoveredCount
      ? `<div style="font-size:11px;color:var(--accent);background:#58A6FF11;border:1px solid #58A6FF44;border-radius:6px;padding:6px 10px;margin-bottom:4px">↩ Recovered ${w._recoveredCount} existing detail row${w._recoveredCount === 1 ? "" : "s"} for this conduct/date that had no attendance summary. Saving keeps them and adds the missing summary.</div>`
      : "");

  const statusRows = w.status.length ? w.status.map(s => `
    <div class="lc-wiz-status-row" style="display:grid;grid-template-columns:18px 48px minmax(0,1.4fr) minmax(80px,auto) minmax(0,1fr);gap:8px;align-items:center;padding:6px 10px;border-radius:6px;background:var(--surface);border:1px solid var(--border);box-sizing:border-box">
      <input type="checkbox" ${s.notParticipating ? "checked" : ""} onchange="wizToggleStatusNP('${s.d4}', this.checked)" style="width:16px;height:16px;cursor:pointer" title="Tick = not participating">
      <span class="mono" style="font-weight:700;color:var(--accent);font-size:12px">${displayId(s.d4)}</span>
      <span style="font-size:12px;min-width:0;line-height:1.3" title="${escapeAttr(getName(s.d4))}">${escapeAttr(getName(s.d4))}</span>
      <span style="font-size:10px;color:var(--orange);font-weight:600;line-height:1.4;background:#D2992222;border:1px solid #D2992244;border-radius:10px;padding:3px 9px;white-space:normal;justify-self:start" title="${escapeAttr(s.statusTag)}">${escapeAttr(s.statusTag)}</span>
      <input type="text" value="${escapeAttr(s.reason)}" placeholder="reason (optional)" oninput="wizUpdateStatusReason('${s.d4}', this.value)" style="min-width:0;width:100%;padding:5px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;font-size:11px;box-sizing:border-box">
    </div>
  `).join("") : `<div style="color:var(--muted);font-size:11px;padding:8px 10px;background:var(--surface);border:1px dashed var(--border);border-radius:6px;text-align:center">No recruits on medical status for this date.</div>`;

  const sectionList = (key, label, helpText, color) => {
    const rows = (w[key] || []).map((row, i) => `
      <div class="lc-wiz-bulk-row" style="display:grid;grid-template-columns:28px minmax(0,1fr) minmax(0,1fr) 32px;gap:8px;align-items:center;padding:8px 10px;border-radius:6px;background:var(--surface);border:1px solid var(--border);box-sizing:border-box">
        <span class="mono" style="color:var(--muted);font-size:12px;font-weight:700">${String(i + 1).padStart(2, "0")}</span>
        <div style="min-width:0">${rosterSelect(`wiz-${key}-d4-${i}`, true, row.d4, "Recruit", { onchange: `wizUpdateRowD4('${key}', ${i}, this.value)` })}</div>
        <input type="text" value="${escapeAttr(row.reason)}" placeholder="reason" oninput="wizUpdateRowReason('${key}', ${i}, this.value)" style="min-width:0;width:100%;padding:7px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font:inherit;font-size:12px;box-sizing:border-box">
        <button type="button" class="btn btn-icon btn-danger" onclick="wizRemoveRow('${key}', ${i})" title="Remove" style="padding:4px 8px">✕</button>
      </div>
    `).join("");
    return `<div class="card" style="padding:12px 14px;margin-bottom:10px;background:var(--surface2);border-radius:8px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <strong style="color:${color};font-size:13px">${label}</strong> <span style="color:var(--muted);font-size:11px">(${w[key].length})</span>
          <div style="font-size:10px;color:var(--dim);margin-top:2px;line-height:1.45">${helpText}</div>
        </div>
        <button type="button" class="btn" style="font-size:12px;padding:6px 12px;white-space:nowrap" onclick="wizAddRow('${key}')">+ Add</button>
      </div>
      ${rows ? `<div style="display:flex;flex-direction:column;gap:6px">${rows}</div>` : ""}
    </div>`;
  };

  const html = `
    <div style="display:flex;flex-direction:column;gap:12px">
      ${editNotice}

      <div class="card" style="padding:10px 12px;background:var(--surface2)">
        <div class="lc-wiz-header" style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:8px">
          <div class="form-group">
            <label>Date</label>
            <input type="date" id="wiz-date" value="${dateVal}" min="2020-01-01" max="2099-12-31" required onchange="wizSetDate(this.value)" style="padding:7px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px">
          </div>
          <div class="form-group">
            <label>Time (HHMM)</label>
            <input type="text" id="wiz-time" value="${escapeAttr(w.time)}" placeholder="0730" maxlength="4" pattern="[0-9]{4}" oninput="wizSetTime(this.value)" style="padding:7px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px">
          </div>
          <div class="form-group">
            <label>Conduct</label>
            ${conductPicker({ inputId: "wiz-conductId", selectedId: w.conductId, onChange: `wizSetConductId(document.getElementById('wiz-conductId').value)` })}
          </div>
        </div>
        <div class="form-group" style="margin-top:8px;margin-bottom:0">
          <label>Program</label>
          <div class="lc-wiz-program" style="display:flex;gap:6px;flex-wrap:wrap">
            ${[...STATE.programs.map(p => p.key), PROGRAM_COMBINED].map(key => {
              const active = (w.program || PROGRAM_COMBINED) === key;
              const col = programColor(key);
              return `<button type="button" onclick="wizSetProgram('${escapeAttr(key)}')" style="flex:1;min-width:90px;padding:8px 10px;border-radius:6px;border:1px solid ${active ? col : "var(--border)"};background:${active ? col + "22" : "var(--surface)"};color:${active ? col : "var(--muted)"};font-weight:${active ? 700 : 500};font-size:12px;cursor:pointer">${escapeAttr(programLabel(key))}</button>`;
            }).join("")}
          </div>
          <div style="font-size:10px;color:var(--dim);margin-top:4px;line-height:1.45">Which training program this conduct is for. PTP/BMT scope the status list + total strength to that program's platoons; Combined = both programs together.</div>
        </div>
      </div>

      <div class="card" style="padding:12px 14px;margin-bottom:10px;background:var(--surface2);border-radius:8px">
        <div style="margin-bottom:8px">
          <strong style="color:var(--accent);font-size:13px">⚕️ Status Personnel</strong> <span style="color:var(--muted);font-size:11px">(${w.status.length} on status today)</span>
          <div style="font-size:10px;color:var(--dim);margin-top:2px;line-height:1.45">Tick to mark as not participating. Untick if a status-personnel is actually participating in this conduct.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">${statusRows}</div>
      </div>

      ${sectionList("reportSick", "📋 Report Sick", "Dropped out mid-conduct AND went to MO afterward. Auto-creates a Pending Medical row — update with MC/LD/etc. once MO clears.", "var(--orange)")}
      ${sectionList("fallout", "💤 Fallout", "Dropped out mid-conduct, did NOT go to MO.", "var(--purple)")}

      <div id="wiz-overlap-warning"></div>

      <div class="card" style="padding:12px 14px;background:var(--surface2);border-radius:8px">
        <div class="lc-wiz-stats-top" style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;align-items:end">
          <div class="form-group" style="grid-column:span 2;margin:0">
            <label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Total Str</label>
            <input type="number" id="wiz-total" min="0" max="999" step="1" value="${totals.total}" oninput="wizSetTotalOverride(this.value)" style="width:100%;padding:7px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:15px;font-weight:700;box-sizing:border-box">
          </div>
          <div class="stat" style="text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 8px"><label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Status</label><div id="wiz-stat-status" class="val" style="font-size:20px;font-weight:700;color:var(--accent);margin-top:2px">${totals.statusCount}</div></div>
          <div class="stat" style="text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 8px"><label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Rpt Sick</label><div id="wiz-stat-reportSick" class="val" style="font-size:20px;font-weight:700;color:var(--orange);margin-top:2px">${totals.reportSickCount}</div></div>
          <div class="stat" style="grid-column:span 2;text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 8px"><label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Fallout</label><div id="wiz-stat-fallout" class="val" style="font-size:20px;font-weight:700;color:var(--purple);margin-top:2px">${totals.falloutCount}</div></div>
        </div>
        <div class="lc-wiz-stats-bot" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:8px">
          <div class="stat" style="text-align:center;background:var(--surface);border:1px solid var(--green);border-radius:6px;padding:10px"><label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Participating <span style="color:var(--dim);text-transform:none">(auto)</span></label><div id="wiz-stat-participating" class="val" style="font-size:26px;font-weight:700;color:var(--green);margin-top:2px">${totals.participating}</div></div>
          <div class="stat" style="text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px"><label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">LMS <span style="color:var(--dim);text-transform:none">(after save)</span></label><div class="val" style="font-size:26px;font-weight:700;color:var(--muted);margin-top:2px">—</div></div>
        </div>
        <div class="form-group" style="margin-top:12px">
          <label style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Remarks <span style="color:var(--dim);text-transform:none">(optional)</span></label>
          <textarea id="wiz-remarks" rows="2" maxlength="500" placeholder="Any data inconsistencies, recruit flags…" oninput="_logConduct.remarks = this.value" style="padding:8px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:12px;resize:vertical;width:100%;box-sizing:border-box">${escapeAttr(w.remarks)}</textarea>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
        <button type="button" class="btn btn-success" onclick="saveLogConductWizard()">💾 Save${w.attendanceId ? "" : " + Copy chat"}</button>
      </div>
    </div>
  `;
  openModal(title, html);
  // Wider modal — five-column status rows + bulk-add sections need the room.
  document.querySelector(".modal")?.classList.add("wide");
  updateLogConductOverlapWarning();
}

// === Wizard mutation handlers ===========================================

function wizSetDate(v) {
  _logConduct.date = v;
  wizRefreshFromTuple();
  renderLogConductWizard();
}
function wizSetTime(v) {
  // oninput (per keystroke) — don't re-render here or the field loses focus.
  // Recovery still triggers via the conduct pick (which infers the time) and
  // the date change; an explicit time edit is reconciled on the next of those.
  _logConduct.time = v;
}
function wizSetConductId(v) {
  _logConduct.conductId = v;
  if (v && !_logConduct.time) {
    const inferred = inferTimeForConduct(v);
    if (inferred) _logConduct.time = inferred;
  }
  wizRefreshFromTuple();
  renderLogConductWizard();
}
function wizSetProgram(v) {
  _logConduct.program = v || PROGRAM_COMBINED;
  // Different program → different roster scope, so the derived Total Str changes.
  // Drop any manual override so it re-derives from the new program's headcount.
  _logConduct.totalOverride = null;
  // Force orphan-recovery to re-evaluate against the new program key.
  _logConduct._orphanKey = null;
  wizRefreshFromTuple();
  renderLogConductWizard();
}
function wizSetTotalOverride(v) {
  const n = +v;
  _logConduct.totalOverride = Number.isFinite(n) && n >= 0 ? n : null;
  recomputeLogConductFooter();
}
function wizToggleStatusNP(d4, checked) {
  const row = _logConduct.status.find(s => s.d4 === d4);
  if (row) row.notParticipating = !!checked;
  recomputeLogConductFooter();
}
function wizUpdateStatusReason(d4, v) {
  const row = _logConduct.status.find(s => s.d4 === d4);
  if (row) row.reason = v;
}
function wizAddRow(section) {
  _logConduct[section].push({ d4: "", reason: "" });
  renderLogConductWizard();
}
function wizRemoveRow(section, idx) {
  _logConduct[section].splice(idx, 1);
  renderLogConductWizard();
}
function wizUpdateRowD4(section, idx, v) {
  if (!_logConduct[section][idx]) return;
  _logConduct[section][idx].d4 = v;
  updateLogConductOverlapWarning();
}
function wizUpdateRowReason(section, idx, v) {
  if (!_logConduct[section][idx]) return;
  _logConduct[section][idx].reason = v;
}

// === Totals / overlap helpers ===========================================

function computeLogConductTotals() {
  const w = _logConduct;
  const statusCount = w.status.filter(s => s.notParticipating).length;
  const rsiCount = w.rsi.length;
  const falloutCount = w.fallout.length;
  const reportSickCount = w.reportSick.length;
  // Default total: recruits in this conduct's program (commanders excluded —
  // they don't typically appear in conduct attendance numbers). Combined =
  // every recruit; PTP/BMT = only that program's platoons.
  const defaultTotal = recruitsInProgram(w.program).length;
  const total = w.totalOverride != null ? w.totalOverride : defaultTotal;
  const participating = Math.max(0, total - statusCount - rsiCount - falloutCount - reportSickCount);
  return { total, statusCount, rsiCount, falloutCount, reportSickCount, participating };
}

// Updates just the totals strip without re-rendering the entire modal —
// avoids losing focus on text inputs during typing.
function recomputeLogConductFooter() {
  const t = computeLogConductTotals();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("wiz-stat-status", t.statusCount);
  set("wiz-stat-fallout", t.falloutCount);
  set("wiz-stat-reportSick", t.reportSickCount);
  set("wiz-stat-participating", t.participating);
  const totalInput = document.getElementById("wiz-total");
  if (totalInput && _logConduct.totalOverride == null) totalInput.value = t.total;
}

function updateLogConductOverlapWarning() {
  const el = document.getElementById("wiz-overlap-warning");
  if (!el) return;
  const w = _logConduct;
  const falloutSet = new Set(w.fallout.map(r => r.d4).filter(Boolean));
  const overlap = w.reportSick.map(r => r.d4).filter(d => d && falloutSet.has(d));
  if (!overlap.length) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div style="background:#D2992222;border:1px solid #D2992266;border-radius:6px;padding:10px 12px;font-size:11px;color:var(--orange);line-height:1.55">
      <strong>⚠ Overlap detected:</strong> the following recruit${overlap.length === 1 ? " is" : "s are"} in BOTH Fallout AND Report Sick:
      <div style="margin-top:4px;color:var(--text);font-weight:600">${overlap.map(d => `${displayId(d)} ${getName(d)}`).join(" · ")}</div>
      <div style="margin-top:4px;color:var(--muted);font-weight:400">Per convention: Report Sick = Fallout → went to MO. They shouldn't both contain the same recruit. You can save anyway — this is just a heads-up.</div>
    </div>
  `;
}

// === Save logic =========================================================

async function saveLogConductWizard() {
  const w = _logConduct;
  if (!w.conductId) { alert("Pick a conduct first."); return; }
  if (!w.date) { alert("Pick a date first."); return; }
  // Validate every list row has a recruit selected.
  const bad = ["fallout", "reportSick"].flatMap(k =>
    w[k].map((r, i) => r.d4 ? null : `${k} row ${i + 1}`).filter(Boolean)
  );
  if (bad.length) {
    alert(`Some rows have no recruit picked:\n  • ${bad.join("\n  • ")}\nPick a recruit or remove the row.`);
    return;
  }

  const totals = computeLogConductTotals();
  const displayDate = isoToDisplayDate(w.date);
  const time = pad4Time(w.time || "");

  const program = w.program || PROGRAM_COMBINED;

  // Build the attendance row.
  const attendanceEntry = {
    id: w.attendanceId || nextId(),
    date: displayDate,
    time,
    conductId: w.conductId,
    program,
    total: totals.total,
    participating: totals.participating,
    lms: 0,  // recomputed from polar below
    px: totals.statusCount,
    fallout: totals.falloutCount,
    remarks: w.remarks || ""
  };

  // Build conductDetail rows. PX rows = only status entries marked
  // "notParticipating" (the rest are participating despite their status).
  const detailRows = [];
  w.status.filter(s => s.notParticipating).forEach(s => {
    detailRows.push({ id: nextId(), date: displayDate, time, conductId: w.conductId, program, d4: s.d4, type: "PX", reason: s.reason || "" });
  });
  w.fallout.forEach(r => detailRows.push({ id: nextId(), date: displayDate, time, conductId: w.conductId, program, d4: r.d4, type: "Fallout", reason: r.reason || "" }));
  w.reportSick.forEach(r => detailRows.push({ id: nextId(), date: displayDate, time, conductId: w.conductId, program, d4: r.d4, type: "ReportSick", reason: r.reason || "" }));

  // Auto-create a "Pending" Medical row for each Report Sick that doesn't
  // already have a medical entry on this date. Pending = waiting for MO
  // outcome; sergeants update the status later when MO issues MC/LD/etc.
  // We skip when a row already exists for (d4, date) so re-saves don't
  // duplicate, and so a sergeant who already manually fixed the status
  // (e.g. "Pending" → "2D LD") isn't reverted back to Pending.
  const newMedicalRows = [];
  w.reportSick.forEach(r => {
    if (!r.d4) return;
    const existing = STATE.medical.find(m => m.d4 === r.d4 && m.date === displayDate);
    if (existing) return;
    newMedicalRows.push({
      id: nextId(),
      d4: r.d4,
      date: displayDate,
      reason: r.reason || "",
      status: "Pending",
      startDate: displayDate,
      endDate: ""
    });
  });
  STATE.medical.push(...newMedicalRows);

  // Commit: replace the attendance row + every PX/Fallout/ReportSick
  // conductDetail row for this (date, time, conductId, program). Scoping the
  // delete to program is what keeps two programs' sessions of the SAME conduct
  // at the SAME time from wiping each other. Legacy RSI rows are preserved
  // untouched — the wizard no longer manages RSI (the chat workflow moved away
  // from it), but historical rows shouldn't be silently deleted.
  if (w.attendanceId) {
    const idx = STATE.attendance.findIndex(a => a.id === w.attendanceId);
    if (idx >= 0) STATE.attendance[idx] = attendanceEntry;
    else STATE.attendance.push(attendanceEntry);
  } else {
    STATE.attendance.push(attendanceEntry);
  }
  STATE.conductDetail = STATE.conductDetail.filter(d =>
    !(d.date === displayDate && (d.time || "") === time && d.conductId === w.conductId && progKey(d) === program && d.type !== "RSI")
  );
  STATE.conductDetail.push(...detailRows);

  // LMS sync from polar.
  recomputeAttendanceLmsFromPolar();
  saveLocal();

  const savedId = attendanceEntry.id;
  const isNew = !w.attendanceId;
  // Compute the obsolete child rows BEFORE we null out the wizard state:
  // originalDetailIds are the ConductDetail row ids that were loaded when
  // the wizard opened. Any that aren't in the new detailRows set need to
  // be surgically deleted from the sheet (they've already been removed
  // from local STATE by the filter above).
  const newDetailIds = new Set(detailRows.map(r => r.id));
  const obsoleteIds = (w.originalDetailIds || []).filter(id => !newDetailIds.has(id));
  _logConduct = null;
  closeModal();
  render();

  // Auto-push everything: attendance upsert, surgical delete of obsolete
  // detail rows, appendMany new detail/medical rows. Each fires through
  // autoSync so the indicator + dirty-tracking handle failures.
  if (STATE.apiUrl) {
    autoSync("Attendance", { type: "upsert", row: attendanceEntry });
    for (const id of obsoleteIds) {
      autoSync("ConductDetail", { type: "delete", id });
    }
    if (detailRows.length) {
      autoSync("ConductDetail", { type: "appendMany", rows: detailRows });
    }
    if (newMedicalRows.length) {
      autoSync("Medical", { type: "appendMany", rows: newMedicalRows });
    }
  }

  if (isNew) {
    try { await copyConductChatFormat(savedId, /*silent*/ true); } catch (e) { /* clipboard denied */ }
    const medMsg = newMedicalRows.length
      ? `\n\n${newMedicalRows.length} Pending Medical row${newMedicalRows.length === 1 ? "" : "s"} auto-created — update the status on the Medical tab once MO clears.`
      : "";
    alert(`Saved & syncing. ${detailRows.length} conduct-detail row${detailRows.length === 1 ? "" : "s"} created.${medMsg}\n\nChat-format message copied to clipboard${navigator.clipboard ? "" : " (or shown in fallback prompt)"}.`);
  } else {
    const obsoleteNote = obsoleteIds.length ? ` ${obsoleteIds.length} removed.` : "";
    const medNote = newMedicalRows.length
      ? `\n\n${newMedicalRows.length} new Pending Medical row${newMedicalRows.length === 1 ? "" : "s"} added.`
      : "";
    alert(`Saved & syncing. ${detailRows.length} conduct-detail row${detailRows.length === 1 ? "" : "s"} total.${obsoleteNote}${medNote}`);
  }
}

// === Chat-format generator ==============================================

// Returns the WhatsApp parade-state message for the given attendance row.
// Matches the format observed in the May 15–29 chat (Total/Participating/
// Status/Report sick/Fallout, then per-section S/N + R/N + Reason blocks).
function buildConductChatFormat(attendanceId) {
  const a = STATE.attendance.find(x => x.id === attendanceId);
  if (!a) return "";
  const date = displayDateToISO(a.date);
  const ddmmyy = toDDMMYY(date);
  const time = pad4Time(a.time || "") || "0000";
  const conductLabel = conductName(a.conductId) || "(unknown conduct)";
  const program = progKey(a);
  const details = STATE.conductDetail.filter(d =>
    d.date === a.date && (d.time || "") === (a.time || "") && d.conductId === a.conductId && progKey(d) === program
  );
  const byType = {
    PX: details.filter(d => d.type === "PX"),
    ReportSick: details.filter(d => d.type === "ReportSick"),
    Fallout: details.filter(d => d.type === "Fallout"),
    RSI: details.filter(d => d.type === "RSI")
  };

  const section = (label, rows, includeStatusBlock) => {
    if (!rows.length) return `${label}:\n`;
    const blocks = rows.map((d, i) => {
      const sn = String(i + 1).padStart(2, "0");
      const rn = paradeRN(d.d4);
      let block = `S/N: ${sn}\nR/N: ${rn}\nReason: ${d.reason || ""}`;
      if (includeStatusBlock) {
        // Pull the recruit's active medical record on this date for status +
        // duration. Collapse same-status duplicates to the most recent first.
        const med = dedupeActiveRecordsByFamily(
          STATE.medical.filter(m => m.d4 === d.d4 && medStatusActive(m, date))
        ).sort((x, y) => medSeverityRank(medStatusTag(y, date)?.tag) - medSeverityRank(medStatusTag(x, date)?.tag));
        if (med.length === 1) {
          block += `\nStatus: ${paradeStatusLabel(med[0], date)}\nDuration: ${paradeDuration(med[0])}`;
        } else if (med.length > 1) {
          const sub = med.map((r, j) => `${j + 1}. ${paradeStatusLabel(r, date)}\n    Duration: ${paradeDuration(r)}`).join("\n");
          block += `\nStatus received:\n${sub}`;
        }
      }
      return block;
    });
    return `${label}: ${String(rows.length).padStart(2, "0")}\n\n${blocks.join("\n\n")}`;
  };

  const header = `${ddmmyy} ${fmtHrs(time)} ${conductLabel} (${programLabel(program)})\nTotal strength: ${a.total}\nParticipating: ${a.participating}\nStatus: ${String(byType.PX.length).padStart(2, "0")}\nReport sick: ${String(byType.ReportSick.length).padStart(2, "0")}\nFallout: ${String(byType.Fallout.length).padStart(2, "0")}`;

  const parts = [header];
  parts.push(section("STATUS", byType.PX, /*includeStatusBlock*/ true));
  if (byType.ReportSick.length) parts.push(section("REPORT SICK", byType.ReportSick, false));
  if (byType.Fallout.length) parts.push(section("FALLOUT", byType.Fallout, false));
  if (byType.RSI.length) parts.push(section("RSI", byType.RSI, false));
  return parts.join("\n\n");
}

// Copies the chat-format message for the attendance row to the clipboard.
// silent=true skips the success alert (used by the post-save flow which
// already shows its own message).
async function copyConductChatFormat(attendanceId, silent) {
  const text = buildConductChatFormat(attendanceId);
  if (!text) { alert("Couldn't find that conduct."); return; }
  try {
    await navigator.clipboard.writeText(text);
    if (!silent) alert("Chat-format message copied to clipboard. Paste into WhatsApp.");
  } catch (e) {
    // Fallback modal with selectable textarea — Safari / blocked clipboard.
    openModal("Chat-format message (copy manually)", `
      <p style="font-size:11px;color:var(--muted);margin-bottom:8px">Clipboard access denied. Tap inside the box to select all, then Cmd/Ctrl+C.</p>
      <textarea readonly rows="22" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;line-height:1.45;white-space:pre" onclick="this.select()">${escapeAttr(text)}</textarea>
    `);
  }
}

// ─── POLAR PHOTO IMPORT (AI extract) ───────────────────
// Drop / pick photos of Polar class summary screens — group them by
// conduct so the conduct + date + time are entered once per conduct,
// not per photo. Batch-analyze via Claude (proxied through Apps Script).
// Each photo → many recruit rows appended to STATE.polar + pushed to the
// sheet via appendMany. No inline review (per user choice).

let _polarStagedGroups = [];  // [{id, conduct, date, time, photos: [{id, dataUrl, base64, mediaType, status, added?, notes?}]}]
let _polarGroupCounter = 0;
let _polarPhotoCounter = 0;

// Down-sample an image File to <500KB JPEG via canvas. Anthropic accepts
// up to 5MB/image but smaller payloads = faster round-trips + cheaper.
function resizeImageForUpload(file, maxWidth = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const ratio = img.width > maxWidth ? maxWidth / img.width : 1;
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        // Return both the full data URL (for preview) and the bare base64
        // (for API payload — backend strips the data: prefix anyway).
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ dataUrl, base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Add an empty conduct group. Date defaults to today; time auto-fills
// when the user types/picks a conduct name (via inferTimeForConduct).
function addPolarGroup() {
  _polarStagedGroups.push({
    id: ++_polarGroupCounter,
    conductId: "",
    date: todayISO(),
    time: "",
    photos: []
  });
  render();
}

function removePolarGroup(id) {
  _polarStagedGroups = _polarStagedGroups.filter(g => g.id !== id);
  render();
}

// Inline edit handler from the group card. When conductId changes, auto-fill
// both date and time from historical data so the user doesn't have to
// re-enter them. Date prefers the most-recent attendance/detail entry for
// the conduct that doesn't yet have polar coverage (i.e. the session the
// user is probably importing photos for); time uses the most-frequently-
// logged time across conductDetail + polar. The user can still override
// either field manually after.
function updatePolarGroup(id, field, value) {
  const g = _polarStagedGroups.find(g => g.id === id);
  if (!g) return;
  g[field] = value;
  if (field === "conductId" && value) {
    let touched = false;
    const inferredDate = inferDateForConduct(value);
    if (inferredDate) { g.date = inferredDate; touched = true; }
    if (!g.time) {
      const inferredTime = inferTimeForConduct(value);
      if (inferredTime) { g.time = inferredTime; touched = true; }
    }
    if (touched) render();
  }
}

// Add photos to a specific group. Resizes each to <500KB JPEG for upload.
async function addPolarPhotosToGroup(groupId, files) {
  const g = _polarStagedGroups.find(x => x.id === groupId);
  if (!g || !files || !files.length) return;
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const { dataUrl, base64, mediaType } = await resizeImageForUpload(file);
      g.photos.push({
        id: ++_polarPhotoCounter,
        dataUrl, base64, mediaType,
        status: "ready"
      });
    } catch (e) {
      alert("Couldn't read " + file.name + ": " + e.message);
    }
  }
  render();
}

function removePolarPhotoFromGroup(groupId, photoId) {
  const g = _polarStagedGroups.find(x => x.id === groupId);
  if (!g) return;
  g.photos = g.photos.filter(p => p.id !== photoId);
  render();
}

async function analyzeAndPushPolarPhotos() {
  // Flatten groups into a queue while validating each group has the
  // required conduct + date set. Empty groups (no photos yet) are silently
  // skipped — user might be staging an upcoming conduct.
  const queue = [];
  _polarStagedGroups.forEach(g => {
    if (!g.photos.length) return;
    g.photos.forEach(p => queue.push({ group: g, photo: p }));
  });
  if (!queue.length) {
    alert("Add at least one photo to a conduct group before analyzing.");
    return;
  }
  const missingConduct = _polarStagedGroups.filter(g => g.photos.length && !g.conductId);
  if (missingConduct.length) {
    alert(`Pick a conduct on ${missingConduct.length} group(s) before analyzing.`);
    return;
  }

  // Pre-build the valid-d4 list once (recruits only — commanders don't
  // appear in Polar class summary screens).
  const validD4s = STATE.roster
    .filter(r => r.role !== "Commander")
    .map(r => String(r.id).replace(/^C/i, ""));

  const progress = document.getElementById("polar-analyze-progress");
  if (progress) progress.style.display = "block";

  const newRows = [];
  const errors = [];
  let added = 0;
  const totalPhotos = queue.length;

  for (let i = 0; i < queue.length; i++) {
    const { group, photo } = queue[i];
    const groupName = conductName(group.conductId);
    if (progress) progress.innerHTML = `Analyzing ${i + 1}/${totalPhotos} — <strong>${escapeAttr(groupName)}</strong><br><span style="color:var(--muted)">${added} rows added · ${errors.length} errors</span>`;
    photo.status = "analyzing";
    try {
      const res = await API.analyzePhoto(photo.base64, photo.mediaType, validD4s);
      if (res.error) {
        errors.push({ photo: `${groupName} (photo ${i + 1})`, error: res.error });
        photo.status = "error";
        continue;
      }
      const dateDisplay = isoToDisplayDate(group.date);
      const time = pad4Time(group.time || "0730");
      let photoAdded = 0;
      let unverifiedCount = 0;
      (res.recruits || []).forEach(r => {
        const d4 = padD4(String(r.d4 || "").replace(/^C/i, ""));
        if (!d4) return;
        if (r.unverified) unverifiedCount++;
        const entry = {
          id: nextId(),
          d4,
          conductId: group.conductId,
          date: dateDisplay,
          time,
          avgHr: r.avgHR ?? "",
          maxHr: r.maxHR ?? "",
          minHr: "",
          calories: r.calories ?? "",
          trainingLoad: "",
          recovery: "",
          duration: r.duration ?? "",
          distance: ""
        };
        STATE.polar.push(entry);
        newRows.push(entry);
        added++;
        photoAdded++;
      });
      photo.status = "done";
      photo.added = photoAdded;
      photo.unverified = unverifiedCount;
      // Truncation warning: when Claude's self-reported rowCount exceeds the
      // actual extracted recruits, the model dropped rows mid-output (usually
      // long photos). Surface so the user can re-run or accept partial.
      if (res.rowCount != null && +res.rowCount > photoAdded) {
        const missing = +res.rowCount - photoAdded;
        errors.push({
          photo: `${groupName} (photo ${i + 1})`,
          error: `⚠️ Truncated extraction — Claude counted ${res.rowCount} rows in the photo but only extracted ${photoAdded}. ${missing} row${missing === 1 ? "" : "s"} likely missing. Re-run the analysis (Claude may extract differently) or check the photo manually.`
        });
      }
      if (res.notes) photo.notes = res.notes;
    } catch (e) {
      errors.push({ photo: `${groupName} (photo ${i + 1})`, error: e.message });
      photo.status = "error";
    }
  }

  recomputeAttendanceLmsFromPolar();
  saveLocal();

  // Push to sheet in one batch. appendMany only sends new rows — much
  // cheaper than the full pushTab(PolarFlow, STATE.polar) round-trip.
  let sheetPushed = false;
  if (newRows.length && STATE.apiUrl) {
    try {
      await API.post({ action: "appendMany", tab: "PolarFlow", rows: newRows });
      sheetPushed = true;
    } catch (e) {
      errors.push({ photo: "(sheet push)", error: e.message });
    }
  }

  // Summary modal — shows what happened, plus any per-photo errors.
  const errorList = errors.length
    ? `<div style="margin-top:12px"><div style="font-size:11px;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Errors (${errors.length})</div>${errors.map(e => `<div style="font-size:11px;padding:4px 8px;background:#F8514922;border-left:2px solid var(--red);border-radius:3px;margin-bottom:3px"><strong>${escapeAttr(e.photo)}:</strong> ${escapeAttr(e.error)}</div>`).join("")}</div>`
    : "";
  openModal("📸 Photo analysis complete", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="stats-row">
        <div class="stat"><label>Photos processed</label><div class="val">${totalPhotos}</div></div>
        <div class="stat"><label>Rows added</label><div class="val" style="color:var(--green)">${added}</div></div>
        <div class="stat"><label>Errors</label><div class="val" style="color:${errors.length ? 'var(--red)' : 'var(--muted)'}">${errors.length}</div></div>
      </div>
      <div style="font-size:12px;color:var(--muted)">
        ${sheetPushed ? "✓ New rows pushed to the <strong>PolarFlow</strong> sheet." : (newRows.length ? "⚠ Rows added locally but sheet push failed — use <strong>Push All to Sheet</strong> to retry." : "Nothing pushed.")}
      </div>
      ${errorList}
      <button class="btn btn-primary" onclick="closePolarAnalysisModal()">Done</button>
    </div>
  `);
}

// Closes the modal AND clears the staging list (the photos have been
// processed; user gets a clean drop zone).
function closePolarAnalysisModal() {
  _polarStagedGroups = [];
  closeModal();
  render();
}

function importBackup(input) {
  const reader = new FileReader();
  reader.onload = e => { try {
    const d = JSON.parse(e.target.result);
    if (d.roster) STATE.roster = d.roster;
    if (d.medical) STATE.medical = d.medical;
    if (d.attendance) STATE.attendance = d.attendance;
    if (d.ippt) STATE.ippt = d.ippt;
    if (d.rm) STATE.rm = d.rm;
    if (d.soc) STATE.soc = d.soc;
    if (d.polar) STATE.polar = d.polar;
    if (d.conductDetail) STATE.conductDetail = d.conductDetail;
    if (d.appointments) STATE.appointments = d.appointments;
    if (d.leave) STATE.leave = d.leave;
    if (d.msk) STATE.msk = d.msk;
    saveLocal(); render();
  } catch (err) { alert("Import failed: " + err.message); } };
  reader.readAsText(input.files[0]); input.value = "";
}
