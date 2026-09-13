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
  // the existing "4D — status" header.
  let html = p.role === "Commander"
    ? `<div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.rank ? p.rank + " · " : ""}Commander${p.status ? ` — ${statusBadge(p.status)}` : ""}</div>`
    : `<div style="font-size:12px;color:var(--muted);margin-bottom:12px">${p.id} — ${statusBadge(p.status)}</div>`;

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

  // RSIs stat is clickable when there are records — opens an inline patterns
  // panel below the stats strip with day-of-week, status mix, timeline, reasons.
  const rsClickable = med.length > 0;
  html += `<div class="stats-row"><div class="stat" ${rsClickable ? `onclick="toggleReportSickPatterns('${d4}')" style="cursor:pointer" title="Click to see patterns"` : ""}><label>RSIs ${rsClickable ? '<span style="color:var(--dim);font-size:9px">▾ patterns</span>' : ''}</label><div class="val" style="color:${med.length > 1 ? 'var(--red)' : 'var(--muted)'}">${med.length}</div></div>`;
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
    const cdCount = t => cd.filter(d => d.type === t).length;
    html += `<h4 style="font-size:12px;color:var(--muted);margin:16px 0 8px">Conduct Participation History — <span style="color:var(--red)">${cd.length} missed</span> <span style="color:var(--dim);font-weight:400">(${cdCount("PX")} PX · ${cdCount("RSI")} RSI · ${cdCount("Fallout")} Fallout · ${cdCount("ReportSick")} ReportSick)</span></h4>`;
    html += `<div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:left">Date</th><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:left">Conduct</th><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Type</th><th style="position:sticky;top:0;background:var(--surface2);padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;text-align:left">Reason</th></tr></thead>
        <tbody>
          ${cd.map(d => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 8px;font-size:11px;color:var(--muted);white-space:nowrap">${d.date}${d.time ? ' <span class="mono" style="color:var(--dim)">' + pad4Time(d.time) + '</span>' : ''}</td><td style="padding:6px 8px;font-size:11px">${conductName(d.conductId)}</td><td style="padding:6px 8px;text-align:center">${badge(d.type, cdTypeColor(d.type))}</td><td style="padding:6px 8px;font-size:11px;color:var(--text)">${d.reason || ''}</td></tr>`).join("")}
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


function openMedicalForm(id) {
  const e = id ? STATE.medical.find(x => x.id === id) : null;
  const dateVal = e ? displayDateToISO(e.date) || todayISO() : todayISO();
  const startVal = e ? displayDateToISO(e.startDate) || dateVal : todayISO();
  const endVal = e ? displayDateToISO(e.endDate) || "" : "";
  const selectedStatus = e?.status || "";
  // Status is an enum drawn from the official parade-state vocabulary. Grouped
  // with optgroups so the form makes the severity tiers visually obvious.
  const statusOptions = MED_STATUS_GROUPS.map(g =>
    `<optgroup label="${g.label}">${g.options.map(o => `<option value="${o}" ${o === selectedStatus ? "selected" : ""}>${o}</option>`).join("")}</optgroup>`
  ).join("");
  openModal(e ? "Edit Report Sick Entry" : "Log Report Sick", `
    <form onsubmit="event.preventDefault(); submitMedical(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formField("f-date", "Date Reported Sick", "date", "", `required value="${dateVal}" min="2020-01-01" max="2099-12-31"`)}
        ${formField("f-reason", "Reason", "text", "Fever, sore throat...", `required maxlength="200" value="${escapeAttr(e?.reason)}"`)}
        <div class="form-group">
          <label>Status</label>
          <select id="f-status" required>
            <option value="">Select status...</option>
            ${statusOptions}
          </select>
        </div>
        <div class="form-row">
          ${formField("f-start", "Start (inclusive)", "date", "", `value="${startVal}" min="2020-01-01" max="2099-12-31"`)}
          ${formField("f-end", "End (inclusive)", "date", "", `value="${endVal}" min="2020-01-01" max="2099-12-31"`)}
        </div>
        <div style="font-size:10px;color:var(--muted)">Start and end dates can be left blank for <strong>Pending</strong> (MO outcome unknown) and <strong>NIL</strong> (MO cleared, no status). Required for everything else.</div>
        <button type="submit" class="btn btn-primary">${e ? "Save" : "Submit"}</button>
      </div>
    </form>`);
}
function submitMedical() {
  const editId = +gv("f-entry-id");
  const status = gv("f-status");
  const startIso = gv("f-start");
  const endIso = gv("f-end");
  const noDurationStatuses = ["Pending", "NIL"];
  if (!noDurationStatuses.includes(status) && !endIso) { alert("End date is required for all statuses except Pending and NIL."); return; }
  if (endIso && startIso && endIso < startIso) { alert("End date cannot be before start date."); return; }
  const entry = {
    id: editId || nextId(),
    d4: gv("f-d4"),
    date: isoToDisplayDate(gv("f-date")),
    reason: gv("f-reason"),
    status,
    startDate: isoToDisplayDate(startIso),
    endDate: endIso ? isoToDisplayDate(endIso) : ""
  };
  if (editId) {
    const idx = STATE.medical.findIndex(m => m.id === editId);
    if (idx >= 0) STATE.medical[idx] = entry;
  } else {
    STATE.medical.push(entry);
  }
  if (entry.d4 && entry.status) { const r = STATE.roster.find(x => x.id === entry.d4); if (r) r.status = entry.status; }
  saveLocal(); closeModal(); render();
  if (!editId && STATE.apiUrl) API.appendRow("Medical", entry).catch(() => {});
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
        <div class="form-row">
          ${formField("f-total", "Total Str", "number", "", `required min="0" max="999" step="1"${numVal(e?.total)}`)}
          ${formField("f-part", "Participating", "number", "", `required min="0" max="999" step="1"${numVal(e?.participating)}`)}
          ${formField("f-lms", "LMS Participation", "number", "", `min="0" max="999" step="1" value="${e?.lms ?? 0}"`)}
        </div>
        <div class="form-row">
          ${formField("f-px", "PX (Status personnel)", "number", "", `required min="0" max="999" step="1" value="${e?.px ?? 0}"`)}
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
  if (px + fallout > total) { alert("PX + Fallout cannot exceed total."); return; }
  if (lms > part) { alert("LMS Participation cannot exceed Participating."); return; }
  const entry = {
    id: editId || nextId(),
    date: isoToDisplayDate(gv("f-date")),
    conductId,
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
  if (!editId && STATE.apiUrl) API.appendRow("Attendance", entry).catch(() => {});
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
  if (!editId && STATE.apiUrl) API.appendRow("IPPT", entry).catch(() => {});
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
  if (!editId && STATE.apiUrl) API.appendRow("RouteMarch", entry).catch(() => {});
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
  if (!editId && STATE.apiUrl) API.appendRow("SOC", entry).catch(() => {});
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
  let inserted = 0;
  rawRows.forEach((row, idx) => {
    const rawConduct = rawConductByRowIdx[idx];
    const conductId = conductIdByName(rawConduct) || keyResolutions[normalizeConductKey(rawConduct)] || "";
    STATE.polar.push({
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
    });
    inserted++;
  });
  _polarImportPending = null;
  const lmsChanged = recomputeAttendanceLmsFromPolar();
  saveLocal(); render();
  alert(`Imported ${inserted} Polar rows${lmsChanged ? `\nUpdated LMS on ${lmsChanged} attendance row${lmsChanged === 1 ? "" : "s"}.` : ""}`);
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
        <div class="form-group"><label>Recruit</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formSelect("f-type", "Type", [["PX", "PX (Status personnel)"], ["Fallout", "Fallout"], ["RSI", "RSI (fallout → report-sick)"], ["ReportSick", "Reported Sick (mid-day)"]], true, e?.type || "")}
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
  if (!editId && STATE.apiUrl) API.appendRow("ConductDetail", entry).catch(() => {});
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
  if (!editId && STATE.apiUrl) API.appendRow("Appointments", entry).catch(() => {});
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
  if (!editId && STATE.apiUrl) API.appendRow("Roster", entry).catch(() => {});
}

function openLeaveForm(id) {
  const e = id ? STATE.leave.find(x => x.id === id) : null;
  const startVal = e ? displayDateToISO(e.startDate) || todayISO() : todayISO();
  const endVal = e ? displayDateToISO(e.endDate) || todayISO() : todayISO();
  openModal(e ? "Edit Leave/Out Entry" : "Log Leave / Out", `
    <form onsubmit="event.preventDefault(); submitLeave(); return false">
      <input type="hidden" id="f-entry-id" value="${e ? e.id : ""}">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${e ? editHint : ""}
        <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;line-height:1.6">
          <div style="font-weight:600;color:var(--text);margin-bottom:4px">📋 Pick the type</div>
          <div><strong>Off-in-Lieu</strong> — counts against the commander's quota.</div>
          <div><strong>Leave / Course / Guard Duty / NDP / Other</strong> — tracked but doesn't decrement the off balance.</div>
        </div>
        <div class="form-group"><label>Person</label>${rosterSelect("f-d4", true, e?.d4 || "")}</div>
        ${formSelect("f-type", "Type", [["Off-in-Lieu", "Off-in-Lieu (counts toward quota)"], ["Leave", "Leave"], ["Weekend", "Weekend"], ["Night's Out", "Night's Out (same-day, evening off-camp)"], ["Course", "Course"], ["Guard Duty", "Guard Duty"], ["NDP", "NDP"], ["Other", "Other"]], true, e?.type || "")}
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
function submitLeave() {
  const editId = +gv("f-entry-id");
  const startIso = gv("f-start");
  const endIso = gv("f-end");
  if (endIso < startIso) { alert("End date must be on or after start date."); return; }
  const entry = {
    id: editId || nextId(),
    d4: gv("f-d4"),
    type: gv("f-type"),
    startDate: isoToDisplayDate(startIso),
    endDate: isoToDisplayDate(endIso),
    days: +gv("f-days") || 0,
    reason: gv("f-reason") || ""
  };
  if (editId) {
    const idx = STATE.leave.findIndex(l => l.id === editId);
    if (idx >= 0) STATE.leave[idx] = entry;
  } else {
    STATE.leave.push(entry);
  }
  saveLocal(); closeModal(); render();
  if (!editId && STATE.apiUrl) API.appendRow("Leave", entry).catch(() => {});
}

// ─── PARADE STATE + MEDICAL STATUS GENERATORS ─────────
// Compose the three battalion-format WhatsApp messages (First/Last Parade
// State + standalone Medical Status list) from live STATE. The PDS spec
// previously retyped these by hand from chats; now the dashboard generates
// an editable preview that round-trips to clipboard in one tap.

const SEP = "----------------------------------------------------------------";

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
function paradeStatusLabel(record) {
  const s = displayDateToISO(record.startDate || "");
  const e = displayDateToISO(record.endDate || "");
  if (!record.status) return "";
  if (!s || !e) return record.status;
  const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
  return days > 0 ? `${days}D ${record.status}` : record.status;
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
    (m.status === "MC" || m.status === "Warded") &&
    displayDateToISO(m.endDate || "") === yIso
  );
}

function toggleBorderline(d4, checked, type) {
  if (checked) _paradeOverrides[d4] = true;
  else delete _paradeOverrides[d4];
  regenerateReport(type);
}

function buildMedicalSection(label, dateIso, statusList) {
  let matches = STATE.medical.filter(m =>
    medStatusActive(m, dateIso) && statusList.includes(m.status)
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
  const peopleIds = Object.keys(byD4);

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

    if (records.length === 1) {
      const r = records[0];
      return `S/N: ${sn}\nR/N: ${rn}\nReason: ${reason}\nStatus: ${paradeStatusLabel(r)}\nDuration: ${paradeDuration(r)}`;
    }
    // Multi-status: stack numbered Status + Duration pairs under one R/N.
    const subStatuses = records.map((r, i) =>
      `${i + 1}. ${paradeStatusLabel(r)}\nDuration: ${paradeDuration(r)}`
    ).join("\n");
    return `S/N: ${sn}\nR/N: ${rn}\nReason: ${reason}\nStatus received:\n${subStatuses}`;
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

function buildAppointmentSection(dateIso, paradeTime) {
  const paradeMins = paradeTimeMinutes(paradeTime);
  const todays = STATE.appointments
    .filter(a => !a.resolved)
    .filter(a => displayDateToISO(a.date) === dateIso)
    .filter(a => apptEndMinutes(a.time) >= paradeMins);
  if (!todays.length) return `MEDICAL APPT:\n\nS/N:\nR/N:\nReason:\nLocation:\nDate:\nTime:`;
  const blocks = todays.map((a, idx) => {
    const sn = String(idx + 1).padStart(2, "0");
    return `S/N: ${sn}\nR/N: ${paradeRN(a.d4)}\nReason: ${a.reason || ""}\nLocation: ${a.location || ""}\nDate: ${toDDMMYY(displayDateToISO(a.date))}\nTime: ${pad4Time(a.time) || ""}`;
  });
  return `MEDICAL APPT: ${String(todays.length).padStart(2, "0")}\n\n${blocks.join("\n\n")}`;
}

function buildOthersSection(dateIso) {
  const active = STATE.leave.filter(l => {
    const s = displayDateToISO(l.startDate);
    const e = displayDateToISO(l.endDate);
    return s && e && s <= dateIso && dateIso <= e;
  });
  if (!active.length) return `OTHERS:\n\nS/N:\nR/N:\nReason:`;
  const blocks = active.map((l, idx) => {
    const sn = String(idx + 1).padStart(2, "0");
    // Reason = leave type + optional free text, so the section reads like
    // the chat's "Guard Duty" / "APSC in Gedong till 24th April" entries.
    const reasonParts = [l.type, l.reason].filter(Boolean);
    return `S/N: ${sn}\nR/N: ${paradeRN(l.d4)}\nReason: ${reasonParts.join(" — ")}`;
  });
  return `OTHERS: ${String(active.length).padStart(2, "0")}\n\n${blocks.join("\n\n")}`;
}

// Strength block — TOTAL is the entire roster (recruits + commanders);
// CURRENT is TOTAL minus anyone away today (active MC/Warded + any leave
// covering the date). Per-platoon and commander lines break the count out.
function buildStrengthBlock(dateIso) {
  const all = STATE.roster;
  const recruits = all.filter(r => r.role !== "Commander");
  const commanders = all.filter(r => r.role === "Commander");

  // Anyone away from camp today — physically not present. Union in any
  // borderline returnees the PDS confirmed still-out so CURRENT STRENGTH
  // matches what the ATTC section shows.
  const attcD4s = new Set(STATE.medical
    .filter(m => medStatusActive(m, dateIso) && (m.status === "MC" || m.status === "Warded"))
    .map(m => m.d4));
  findBorderlineReturnees(dateIso)
    .filter(m => _paradeOverrides[m.d4])
    .forEach(m => attcD4s.add(m.d4));
  const othersD4s = new Set(STATE.leave
    .filter(l => {
      const s = displayDateToISO(l.startDate);
      const e = displayDateToISO(l.endDate);
      return s && e && s <= dateIso && dateIso <= e;
    })
    .map(l => l.d4));
  const isAway = r => attcD4s.has(r.id) || othersD4s.has(r.id);

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
    buildMedicalSection("ATTC", dateIso, ["MC", "Warded"]),
    buildMedicalSection("REPORT SICK", dateIso, ["Pending"]),
    buildMedicalSection("MEDICAL STATUS", dateIso, ["LD", "RMJ", "Excuse Heavy Load", "Excuse Kneeling", "Excuse Squatting", "Excuse Uniform", "Excuse RMJ", "Excuse Swimming", "Excuse Prolonged Standing", "Excuse Upper Limb", "Excuse Lower Limb"]),
    buildAppointmentSection(dateIso, time),
    buildOthersSection(dateIso)
  ];
  return `COUGAR COMPANY\n${header}\nDATE: ${dateStr} @ ${time}\n\n${SEP}\n\n${sections.join(`\n\n${SEP}\n\n`)}\n\n${SEP}`;
}

function generateMedicalStatusText(dateIso, time) {
  const dateStr = toDDMMYY(dateIso);
  const heading = `${dateStr}(latest version as of ${dateStr} @${time})`;
  const body = buildMedicalSection("MEDICAL STATUS", dateIso, ["LD", "RMJ", "Excuse Heavy Load", "Excuse Kneeling", "Excuse Squatting", "Excuse Uniform", "Excuse RMJ", "Excuse Swimming", "Excuse Prolonged Standing", "Excuse Upper Limb", "Excuse Lower Limb"]);
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
  const heading = `MSK: ${String(cases.length).padStart(2, "0")} (as of ${dateStr} @${time})`;

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
    : "Medical Status List";

  // Borderline overrides are scoped to a single modal session — clearing
  // here avoids stale ticks leaking from a previous open.
  _paradeOverrides = {};

  // The borderline checklist is only meaningful for FP/LP. MED/MSK reports
  // skip the section + date onchange wiring entirely.
  const isParade = type === "FP" || type === "LP";
  const dateExtra = isParade
    ? `value="${defaultDate}" required onchange="onParadeDateChange('${type}')"`
    : `value="${defaultDate}" required`;

  openModal("Generate " + titleLabel, `
    <form onsubmit="event.preventDefault(); regenerateReport('${type}'); return false">
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 10px">
          Adjust date/time → tap <strong>Regenerate</strong>. The textarea is editable for last-minute tweaks (e.g. "latest version as of…", manual corrections). Tap <strong>Copy to Clipboard</strong> when ready and paste into WhatsApp.
        </div>
        <div class="form-row">
          ${formField("rep-date", "Date", "date", "", dateExtra)}
          ${formField("rep-time", "Time (HHMM)", "text", "0700", `value="${defaultTime}" maxlength="4" pattern="[0-9]{4}" required`)}
        </div>
        ${isParade ? `<div id="borderline-section"></div>` : ""}
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
  regenerateReport(type);
}

// Wipes overrides when the date input changes, re-renders the checklist
// for the new date, then regenerates the textarea.
function onParadeDateChange(type) {
  _paradeOverrides = {};
  renderBorderlineSection(gv("rep-date"), type);
  regenerateReport(type);
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
  const text = type === "MED" ? generateMedicalStatusText(dateIso, time)
    : type === "MSK" ? generateMSKReportText(dateIso, time)
    : generateParadeStateText(type, dateIso, time);
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

// Counts how many distinct company conducts (date+conduct tuples) fell
// inside [startIso, endIso]. Used for the attendance-rate denominator so
// "attended X / Y" reflects the actual training calendar.
function countCompanyConductsInWindow(startIso, endIso) {
  const tuples = new Set();
  STATE.attendance.forEach(a => {
    const iso = displayDateToISO(a.date);
    if (iso && iso >= startIso && iso <= endIso && a.conductId) tuples.add(`${iso}|${a.conductId}`);
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
  // Universe = "polar-tracked conducts": the set of (date, conductId) tuples
  // in the window where at least one company-wide Polar entry exists. Admin
  // sessions / briefings / conducts without watches don't appear here, so
  // they don't dilute either the attended or joined ratio. This makes the
  // report read as "how present were you when training was being measured".
  const polarTrackedTuples = new Set();
  STATE.polar.forEach(p => {
    if (!p.conductId) return;
    const iso = displayDateToISO(p.date);
    if (iso && iso >= startIso && iso <= endIso) polarTrackedTuples.add(`${iso}|${p.conductId}`);
  });
  const totalCoyConducts = polarTrackedTuples.size;

  // Conducts in this window where this recruit was logged as not
  // participating. ReportSick is excluded — it happens mid-day, after the
  // conduct, so the recruit was present for the actual PT itself.
  const conductDetailRows = STATE.conductDetail.filter(c => {
    if (c.d4 !== d4) return false;
    const iso = displayDateToISO(c.date);
    return iso && iso >= startIso && iso <= endIso;
  });
  // Restrict misses to polar-tracked tuples so the math stays consistent with
  // the new denominator. A "missed" entry for a non-polar-tracked conduct
  // would otherwise push conductsAttended below zero or skew the rate.
  const skippedRows = conductDetailRows.filter(c => {
    if (c.type !== "PX" && c.type !== "RSI" && c.type !== "Fallout") return false;
    const iso = displayDateToISO(c.date);
    return iso && c.conductId && polarTrackedTuples.has(`${iso}|${c.conductId}`);
  });
  const missedCount = skippedRows.length;
  const missedBreakdown = ["PX", "RSI", "Fallout"]
    .map(t => ({ t, n: skippedRows.filter(m => m.type === t).length }))
    .filter(x => x.n > 0)
    .map(x => `${x.n} ${x.t}`).join(" · ") || "none";

  // Conducts attended = polar-tracked conducts minus those they were absent from.
  // Polar classes joined = how many of those conducts they wore the watch for.
  const conductsAttended = Math.max(0, totalCoyConducts - missedCount);
  const attendanceRate = totalCoyConducts ? Math.round((conductsAttended / totalCoyConducts) * 100) : 0;
  // Strict polar-joined: only count this recruit's polar entries that map to
  // a tracked tuple. Drops orphan polar rows (missing conductId) so the
  // ratio is always ≤ 1.
  const polarJoined = STATE.polar.filter(p => {
    if (p.d4 !== d4 || !p.conductId) return false;
    const iso = displayDateToISO(p.date);
    return iso && iso >= startIso && iso <= endIso;
  }).length;
  const polarRate = totalCoyConducts ? Math.round((polarJoined / totalCoyConducts) * 100) : 0;
  // Report Sick = times the recruit was sent to MO mid-day after the
  // conduct (ReportSick conductDetail entries). Discrete countable events;
  // more meaningful for a fitness report than raw MC days because it
  // tracks "how often did training have to stop for medical attention."
  const reportSickCount = conductDetailRows.filter(c => c.type === "ReportSick").length;
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
// ─── FITNESS-REPORT SENT LOG (client-side dedup) ─────────
// Gmail caps the script owner at 100 sends/day. When the user has more
// recipients than that, the bulk loop hits quota=0 and bails — we record
// each successful send so the next day they can resume without re-emailing
// anyone. Scoped per report period (start→end) so a May report and a June
// report don't shadow each other.
const FITNESS_SENT_KEY = "cougar-fitness-sent";

function fitnessSentKey(startIso, endIso) {
  return `${startIso}→${endIso}`;
}

function getFitnessSentAll() {
  try { return JSON.parse(localStorage.getItem(FITNESS_SENT_KEY) || "{}"); }
  catch { return {}; }
}

// Returns { d4: sentAtIso, … } for the given period.
function getFitnessSentMap(startIso, endIso) {
  return getFitnessSentAll()[fitnessSentKey(startIso, endIso)] || {};
}

function markFitnessSent(startIso, endIso, d4) {
  const all = getFitnessSentAll();
  const k = fitnessSentKey(startIso, endIso);
  if (!all[k]) all[k] = {};
  all[k][d4] = new Date().toISOString();
  localStorage.setItem(FITNESS_SENT_KEY, JSON.stringify(all));
}

function clearFitnessSent(startIso, endIso) {
  const all = getFitnessSentAll();
  delete all[fitnessSentKey(startIso, endIso)];
  localStorage.setItem(FITNESS_SENT_KEY, JSON.stringify(all));
}

// Refreshes the "X already sent · Y pending" line whenever the user picks
// new dates or after a batch finishes. Also enables/disables the Clear-log
// button. Called from date input oninput and after sendAllReports completes.
function refreshFitnessSentStatus() {
  const el = document.getElementById("fitness-sent-status");
  if (!el) return;
  const startIso = gv("rep-start"), endIso = gv("rep-end");
  if (!startIso || !endIso) { el.innerHTML = ""; return; }
  const allRecipients = filteredRoster().filter(r => r.role !== "Commander" && r.email);
  const sentMap = getFitnessSentMap(startIso, endIso);
  const sentCount = allRecipients.filter(r => sentMap[r.id]).length;
  const pending = allRecipients.length - sentCount;
  const clearBtn = sentCount
    ? ` <button class="btn" style="font-size:10px;padding:2px 8px;margin-left:6px" onclick="confirmClearFitnessSent()">Clear sent log</button>`
    : "";
  el.innerHTML = sentCount
    ? `<span style="color:var(--accent)">✓ ${sentCount} already sent</span> · <strong>${pending} pending</strong> for ${startIso} → ${endIso}${clearBtn}`
    : `<span style="color:var(--muted)">No sends recorded yet for ${startIso} → ${endIso}.</span>`;
}

function confirmClearFitnessSent() {
  const startIso = gv("rep-start"), endIso = gv("rep-end");
  if (!startIso || !endIso) return;
  if (!confirm(`Clear sent log for ${startIso} → ${endIso}? Next bulk send will email everyone in scope again, including recruits who already received it.`)) return;
  clearFitnessSent(startIso, endIso);
  refreshFitnessSentStatus();
}

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
        ${formField("rep-start", "Start date", "date", "", `value="${monthAgoIso}" required oninput="refreshFitnessSentStatus()"`)}
        ${formField("rep-end",   "End date",   "date", "", `value="${today}" required oninput="refreshFitnessSentStatus()"`)}
      </div>
      <div id="fitness-sent-status" style="font-size:11px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;display:flex;align-items:center;flex-wrap:wrap"></div>

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

      <div style="font-size:12px;color:var(--muted)">
        Bulk send to <strong style="color:var(--accent)">${recipients.length}</strong> recruit${recipients.length === 1 ? '' : 's'}${scopeNote}${skipped ? ` <span style="color:var(--dim)">(${skipped} skipped — no email on file)</span>` : ""}.
      </div>
      <button class="btn btn-success" onclick="sendAllReports()" ${recipients.length ? "" : "disabled"}>📨 Send to All Recipients →</button>

      <div id="fitness-report-progress" style="display:none;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px"></div>
    </div>`);

  // Populate the pending/already-sent status now that the modal DOM exists.
  refreshFitnessSentStatus();

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

// Sequential send loop — fires one email at a time so we can read the
// remaining quota after each call and abort cleanly when it hits 0.
// Recipients already recorded in the period's sent log are skipped, so
// hitting quota on day 1 leaves only the un-sent recruits queued for day 2.
async function sendAllReports() {
  const startIso = gv("rep-start");
  const endIso = gv("rep-end");
  if (!startIso || !endIso) { alert("Pick a start and end date first."); return; }
  const allRecipients = filteredRoster().filter(r => r.role !== "Commander" && r.email);
  if (!allRecipients.length) { alert("No recruits with email in current scope."); return; }

  const sentMap = getFitnessSentMap(startIso, endIso);
  const recipients = allRecipients.filter(r => !sentMap[r.id]);
  const alreadySent = allRecipients.length - recipients.length;

  if (!recipients.length) {
    alert(`All ${allRecipients.length} recipients already received the report for ${startIso} → ${endIso}.\n\nUse "Clear sent log" if you need to resend.`);
    return;
  }
  const skippedNote = alreadySent ? `\n(skipping ${alreadySent} already sent for this period)` : "";
  if (!confirm(`Send fitness reports to ${recipients.length} recruits?${skippedNote}\n\nThis cannot be undone.`)) return;

  const progress = document.getElementById("fitness-report-progress");
  progress.style.display = "block";
  let sent = 0, failed = 0, skippedQuota = 0, lastQuota = "?";

  const startNice = isoToDisplayDate(startIso);
  const endNice = isoToDisplayDate(endIso);
  const subject = `Your Cougar Fitness Report — ${startNice} → ${endNice}`;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    progress.innerHTML = `Sending ${i + 1}/${recipients.length} — currently <strong>${displayPersonLabel(r.id)}</strong><br><span style="color:var(--muted)">✓ ${sent} sent · ⚠ ${failed} failed${alreadySent ? ` · ⏭ ${alreadySent} skipped (already sent)` : ""} · quota left: ${lastQuota}</span>`;
    try {
      const { htmlForEmail, inlineImages } = buildFitnessReportHTML(r.id, startIso, endIso);
      const res = await API.sendEmail(r.email, subject, htmlForEmail, inlineImages);
      if (res.error) {
        failed++;
        if (res.remainingQuota === 0) {
          skippedQuota = recipients.length - i - 1;
          break;
        }
      } else {
        sent++;
        // Persist BEFORE checking quota so a 0-quota response after a
        // successful send still records that one.
        markFitnessSent(startIso, endIso, r.id);
        lastQuota = res.remainingQuota ?? "?";
        if (res.remainingQuota === 0 && i < recipients.length - 1) {
          skippedQuota = recipients.length - i - 1;
          break;
        }
      }
    } catch (e) {
      failed++;
    }
  }

  const quotaRetryNote = skippedQuota ? ` · ${skippedQuota} not sent (daily quota hit — retry tomorrow)` : "";
  const skipNote = alreadySent ? ` · ${alreadySent} skipped (already sent earlier)` : "";
  progress.innerHTML = `<strong style="color:var(--green)">✓ Done.</strong> ${sent} sent · ${failed} failed${quotaRetryNote}${skipNote} · quota left: ${lastQuota}`;
  // Refresh the pending/sent indicator so the user sees the new pending count.
  refreshFitnessSentStatus();
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
  const lmsChanged = recomputeAttendanceLmsFromPolar();
  saveLocal();
  closeModal();
  render();

  // The sheet push is part of the atomic migration — not optional. If we
  // skipped it, future appendRow/appendMany on PolarFlow / Attendance /
  // ConductDetail would write into the OLD schema (which still has a
  // `conduct` column, not `conductId`), silently dropping the conductId
  // values. So we push all four tabs immediately and surface any failure.
  try {
    await API.pushTab("Conducts", STATE.conducts);
    await API.pushTab("Attendance", STATE.attendance);
    await API.pushTab("PolarFlow", STATE.polar);
    await API.pushTab("ConductDetail", STATE.conductDetail);
    alert(`Migrated ${registry.length} conduct${registry.length === 1 ? "" : "s"} and synced to the Google Sheet.\n${lmsChanged ? `Backfilled LMS on ${lmsChanged} attendance row${lmsChanged === 1 ? "" : "s"} from Polar data.\n` : ""}\nConducts tab created; Attendance / PolarFlow / ConductDetail now use the conductId column.`);
  } catch (e) {
    alert(`Migrated ${registry.length} conduct${registry.length === 1 ? "" : "s"} locally, BUT the sheet push failed:\n\n${e.message}\n\n⚠️ Until you manually push all four tabs (Conducts, Attendance, PolarFlow, ConductDetail) from each tab header, any new rows appended to the sheet will lose their conductId values. Go to each tab and click Push to Sheet now.`);
  }
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
  STATE.conducts.push({ id, name: clean });
  saveLocal();
  return id;
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
  render();
}

// Merges one conduct into another: every record pointing to fromId is
// repointed to toId, then fromId is removed from the registry. Used both
// from the admin tab and indirectly from migration edits.
function mergeConductInto(fromId, toId) {
  if (fromId === toId) return;
  const from = STATE.conducts.find(x => x.id === fromId);
  const to = STATE.conducts.find(x => x.id === toId);
  if (!from || !to) return;
  if (!confirm(`Merge "${from.name}" → "${to.name}"?\n\nAll records currently using "${from.name}" will be repointed to "${to.name}", and "${from.name}" will be removed from the registry.`)) return;
  const repoint = (arr) => (arr || []).forEach(r => { if (r.conductId === fromId) r.conductId = toId; });
  repoint(STATE.attendance);
  repoint(STATE.polar);
  repoint(STATE.conductDetail);
  STATE.conducts = STATE.conducts.filter(x => x.id !== fromId);
  saveLocal();
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
  let changed = 0;
  STATE.attendance.forEach(a => {
    if ("polar" in a) delete a.polar;
    const ck = conductJoinKey(a);
    if (!ck) return;
    const count = polarByConduct[`${dateJoinKey(a.date)}|${ck}`]?.size;
    if (count == null) return;
    if ((+a.lms || 0) !== count) {
      a.lms = count;
      changed++;
    }
  });
  if (changed) saveLocal();
  return changed;
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
  const changed = recomputeAttendanceLmsFromPolar();
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
