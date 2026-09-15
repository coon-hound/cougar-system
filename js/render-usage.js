// ============================================================================
// Usage insights view — renderUsage(el).
//
// This view exists to answer ONE question: what should move to the front of
// the dashboard? So it does not stop at counts. It ranks features by how often
// they are opened, ranks tasks by what they cost in taps, puts the abandonment
// rate next to the cost, and then states the conclusion in plain language —
// "Book Out: used 47x, averages 6 taps — promote to the dashboard". That
// sentence is the entire point of building the telemetry subsystem; the tables
// under it are the evidence for it.
//
// Conventions, matching every other view in js/render.js: one template-literal
// assignment to el.innerHTML, inline onclick handlers calling globals, and the
// existing class vocabulary (.card, .stat, .stats-row, .table-wrap, .badge-*,
// .btn, .empty-state) so the view inherits the design system rather than
// hand-rolling colours.
//
// Collector: js/telemetry.js. Storage and sync design: TELEMETRY-DESIGN.md.
// ============================================================================

// View-local state. Namespaced, because js/*.js share one global scope and a
// duplicate top-level declaration blanks the whole dashboard (CLAUDE.md).
const USAGE_VIEW = {
  scope: "device",     // "device" | "company"
  days: 14,
  company: null,       // { rows, devices } once fetched
  loading: false,
  error: ""            // network failure, shown in the view and nowhere else
};

// ── Controls (inline onclick targets) ───────────────────────────────────────

function usageSetScope(scope) {
  USAGE_VIEW.scope = scope === "company" ? "company" : "device";
  USAGE_VIEW.error = "";
  if (USAGE_VIEW.scope === "company" && !USAGE_VIEW.company) { usageLoadCompany(); return; }
  render();
}

function usageSetWindow(days) {
  USAGE_VIEW.days = +days || 14;
  if (USAGE_VIEW.scope === "company") { USAGE_VIEW.company = null; usageLoadCompany(); return; }
  render();
}

// Company-wide numbers are fetched ON DEMAND, only when someone opens this
// view and asks for them — never on launch and never as part of a pull. A
// failure here is shown in this view and nowhere else: telemetry must never
// surface a sync error to a user going about their day.
async function usageLoadCompany() {
  if (USAGE_VIEW.loading) return;
  USAGE_VIEW.loading = true;
  USAGE_VIEW.error = "";
  render();
  try {
    const res = await API.usageRead({ scope: "company", days: USAGE_VIEW.days });
    if (res && res.ok) USAGE_VIEW.company = { rows: res.rows || [], devices: res.devices || 0 };
    else USAGE_VIEW.error = (res && res.error) || "The server did not return usage data.";
  } catch (e) {
    USAGE_VIEW.error = (e && e.message) || String(e);
  } finally {
    USAGE_VIEW.loading = false;
    render();
  }
}

function usageRefresh() {
  if (USAGE_VIEW.scope === "company") { USAGE_VIEW.company = null; usageLoadCompany(); }
  else render();
}

// Flush this device's pending counters now, so the company view can include
// what just happened instead of waiting for the next timer tick.
async function usageFlushNow() {
  try { await TELEMETRY.flush(false); } catch (_) { /* never the user's problem */ }
  usageRefresh();
}

function usageClearLocal() {
  if (!confirm("Clear the usage counters recorded on THIS device? Anything already flushed to the server is unaffected.")) return;
  TELEMETRY.clearLocal();
  render();
}

// ── Formatting ──────────────────────────────────────────────────────────────

function usageDuration(ms) {
  const s = Math.round((+ms || 0) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function usageAbandonBadge(rate, ended) {
  if (!ended) return `<span style="color:var(--dim)">—</span>`;
  const cls = rate >= 40 ? "badge-red" : rate >= 20 ? "badge-orange" : "badge-green";
  return `<span class="badge ${cls}">${rate}%</span>`;
}

const USAGE_VERDICT_BADGE = {
  promote: "badge-green",
  investigate: "badge-orange",
  keep: "badge-accent"
};

// ── The view ────────────────────────────────────────────────────────────────

function renderUsage(el) {
  const device = USAGE_VIEW.scope === "device";
  const days = TELEMETRY
    ? (device ? TELEMETRY.localDays() : TELEMETRY.daysFromRows((USAGE_VIEW.company || {}).rows))
    : {};
  const summary = TELEMETRY ? TELEMETRY.summarize(days, { days: USAGE_VIEW.days }) : { features: [], views: [], tasks: [], days: 0 };
  const recs = TELEMETRY ? TELEMETRY.recommend(summary) : [];

  const totalClicks = summary.features.reduce((s, f) => s + f.count, 0);
  const totalTasks = summary.tasks.reduce((s, t) => s + t.starts, 0);
  const totalEnded = summary.tasks.reduce((s, t) => s + t.ended, 0);
  const totalAban = summary.tasks.reduce((s, t) => s + t.abandoned, 0);
  const overallAban = totalEnded ? Math.round((totalAban / totalEnded) * 100) : 0;
  const totalTaps = summary.tasks.reduce((s, t) => s + t.cost, 0);
  const hasData = totalClicks > 0 || totalTasks > 0 || summary.views.length > 0;

  const header = `
    <h2 style="font-size:18px;font-weight:700;margin-bottom:4px">Usage Insights</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.55">
      Evidence for what belongs at the top of the dashboard: what gets opened, what it costs in taps,
      and where people give up. No personal data is recorded — only the name of the action, never who it was about.
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
      <div class="filter-role-group" title="Whose usage to show">
        <button class="role-btn ${device ? "active" : ""}" onclick="usageSetScope('device')">This device</button>
        <button class="role-btn ${device ? "" : "active"}" onclick="usageSetScope('company')">Company</button>
      </div>
      <select class="topbar-select" onchange="usageSetWindow(this.value)" title="Window">
        ${[7, 14, 30].map(d => `<option value="${d}" ${d === USAGE_VIEW.days ? "selected" : ""}>Last ${d} days</option>`).join("")}
      </select>
      <button class="btn" onclick="usageRefresh()">↻ Refresh</button>
      <button class="btn" onclick="usageFlushNow()" title="Send this device's counters to the server now">⬆ Flush now</button>
      <button class="btn btn-danger" onclick="usageClearLocal()" style="margin-left:auto">Clear this device</button>
    </div>`;

  // Honest empty states. With no data yet this must SAY so, not render a
  // misleading wall of zeroes that reads like a finding.
  if (!device && USAGE_VIEW.loading) {
    return void (el.innerHTML = header + `<div class="card empty-state"><p>Loading company-wide usage…</p></div>`);
  }
  if (!device && USAGE_VIEW.error) {
    return void (el.innerHTML = header + `
      <div class="card empty-state">
        <p style="margin-bottom:8px">Could not load company-wide usage.</p>
        <p style="font-size:11px;color:var(--dim)">${escapeAttr(USAGE_VIEW.error)}</p>
        <p style="font-size:11px;color:var(--dim);margin-top:8px">This device's own numbers still work offline — switch to <strong>This device</strong>.</p>
        <button class="btn" onclick="usageRefresh()" style="margin-top:10px">Try again</button>
      </div>`);
  }
  if (!hasData) {
    return void (el.innerHTML = header + `
      <div class="card empty-state">
        <p style="margin-bottom:8px"><strong>No usage recorded yet${device ? " on this device" : " for the company"}.</strong></p>
        <p style="font-size:12px;line-height:1.6">
          ${device
            ? "Counters start the moment you use the app — open a few views and log something, then come back."
            : "Nothing has been flushed to the server for this window yet. Devices send their counters in batches, so give it a few minutes of real use."}
        </p>
        <p style="font-size:11px;color:var(--dim);margin-top:10px">A zero here means no measurement, not zero usage. Nothing is inferred from an empty window.</p>
      </div>`);
  }

  const scopeNote = device
    ? `This device only${TELEMETRY ? ` (id <span class="mono">${escapeAttr(TELEMETRY.deviceId())}</span>)` : ""}`
    : `${(USAGE_VIEW.company || {}).devices || 0} device(s) company-wide`;

  el.innerHTML = header + `
    <div class="stats-row">
      <div class="stat"><label>Days measured</label><div class="val">${summary.days}</div></div>
      <div class="stat"><label>Taps recorded</label><div class="val" style="color:var(--accent)">${totalClicks}</div></div>
      <div class="stat"><label>Tasks started</label><div class="val" style="color:var(--teal)">${totalTasks}</div></div>
      <div class="stat"><label>Taps spent on tasks</label><div class="val" style="color:var(--orange)">${totalTaps}</div></div>
      <div class="stat"><label>Abandoned</label><div class="val" style="color:${overallAban >= 30 ? "var(--red)" : "var(--green)"}">${overallAban}%</div></div>
    </div>
    <p style="font-size:11px;color:var(--dim);margin:8px 0 16px">${scopeNote} · last ${USAGE_VIEW.days} days</p>

    ${usageRecommendationCard(recs)}
    ${usageTaskCostCard(summary)}
    <div class="grid-2">
      ${usageViewsCard(summary)}
      ${usageFeaturesCard(summary)}
    </div>`;
}

// The answer, not the data. Anything above the fold in this view should be a
// sentence a product owner can act on without reading a table.
function usageRecommendationCard(recs) {
  if (!recs.length) {
    return `
      <div class="card" style="margin-bottom:16px">
        <h3>What to promote</h3>
        <p style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:6px">
          Not enough completed tasks in this window to make a recommendation worth acting on.
          Recommendations appear once a task has been started a few times, so a single afternoon's use cannot
          reshape the dashboard.
        </p>
      </div>`;
  }
  return `
    <div class="card" style="margin-bottom:16px">
      <h3>What to promote</h3>
      <p style="font-size:11px;color:var(--dim);margin:4px 0 10px">
        High frequency <em>and</em> high tap-cost is what earns a place at the front. A leaky funnel is a different
        problem with a different fix.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${recs.map(r => `
          <div style="display:flex;gap:10px;align-items:baseline;padding:8px 10px;border-radius:8px;background:var(--surface2);border:1px solid var(--border)">
            <span class="badge ${USAGE_VERDICT_BADGE[r.verdict] || "badge-accent"}">${r.verdict}</span>
            <div style="font-size:12px;line-height:1.55">
              <strong>${escapeAttr(r.label)}</strong>: ${escapeAttr(r.why)}.
            </div>
          </div>`).join("")}
      </div>
    </div>`;
}

// Cost, ranked by what it actually costs the company — total taps — with the
// abandonment rate beside it, because a form people back out of is a form with
// a problem and the two findings are read together.
function usageTaskCostCard(summary) {
  if (!summary.tasks.length) {
    return `<div class="card" style="margin-bottom:16px"><h3>Clicks per task</h3>
      <p style="font-size:12px;color:var(--muted);margin-top:6px">No task was started in this window.</p></div>`;
  }
  return `
    <div class="card" style="margin-bottom:16px">
      <h3>Clicks per task · ranked by total taps spent</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <thead><tr>
            <th style="text-align:left">Task</th>
            <th>Started</th><th>Done</th><th>Avg taps</th><th>Total taps</th><th>Abandoned</th><th>Avg time</th>
          </tr></thead>
          <tbody>
            ${summary.tasks.map(t => `
              <tr>
                <td style="text-align:left">${escapeAttr(t.label)}</td>
                <td>${t.starts}</td>
                <td>${t.completed}</td>
                <td style="color:${t.avgClicks >= 6 ? "var(--orange)" : "var(--muted)"}">${t.avgClicks || "—"}</td>
                <td class="mono">${t.cost}</td>
                <td>${usageAbandonBadge(t.abandonRate, t.ended)}</td>
                <td>${t.avgMs ? usageDuration(t.avgMs) : "—"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p style="font-size:11px;color:var(--dim);margin-top:8px">
        Avg taps and abandonment are over <em>finished</em> attempts — a task still open when the app closed
        contributed no tap count, and counting it would understate every cost.
      </p>
    </div>`;
}

function usageViewsCard(summary) {
  if (!summary.views.length) {
    return `<div class="card"><h3>Views opened</h3>
      <p style="font-size:12px;color:var(--muted);margin-top:6px">No view change recorded yet.</p></div>`;
  }
  const max = summary.views[0].opens || 1;
  return `
    <div class="card">
      <h3>Views opened · what people actually go to</h3>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <thead><tr><th style="text-align:left">View</th><th>Opens</th><th>Avg dwell</th><th style="text-align:left">Share</th></tr></thead>
          <tbody>
            ${summary.views.map(v => `
              <tr>
                <td style="text-align:left">${escapeAttr(v.label)}</td>
                <td>${v.opens}</td>
                <td>${usageDuration(v.avgMs)}</td>
                <td style="text-align:left">
                  <div style="height:6px;border-radius:3px;background:var(--accent);width:${Math.max(4, Math.round((v.opens / max) * 100))}%"></div>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function usageFeaturesCard(summary) {
  if (!summary.features.length) {
    return `<div class="card"><h3>Most-used actions</h3>
      <p style="font-size:12px;color:var(--muted);margin-top:6px">No action recorded yet.</p></div>`;
  }
  const top = summary.features.slice(0, 20);
  return `
    <div class="card">
      <h3>Most-used actions · top ${top.length}</h3>
      <p style="font-size:11px;color:var(--dim);margin:4px 0 8px">
        The handler behind each tap. Names only — never the 4D, name or reason it was called with.
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="text-align:left">Action</th><th>Taps</th></tr></thead>
          <tbody>
            ${top.map(f => `<tr><td class="mono" style="text-align:left;font-size:11px">${escapeAttr(f.name)}</td><td>${f.count}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}
