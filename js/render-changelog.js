// ============================================================================
// Change log view - renderChangeLog(el). Admin only.
//
// Answers "who put this in, and what did it say before?" from the audit trail
// the Edge Function writes on every mutation (0002/0003 audit, auditLog in
// supabase/functions/api/index.ts). One request's rows share a timestamp, so
// consecutive entries from the same person, tab and moment are folded into one
// card: an upload of 40 Polar rows reads as one event, not 40.
//
// Like Access, the nav button is hidden unless whoami says can_invite, and the
// backend refuses auditLog without it. The hiding is presentation; the refusal
// is the control.
//
// The Sheets backend has no audit trail at all, so this view only works
// against Postgres; anything else shows the backend's own error.
// ============================================================================

// View-local state. Namespaced, because js/*.js share one global scope.
const CHANGELOG_VIEW = {
  entries: null,       // null = not loaded yet
  more: false,         // the last page was full, so older rows may exist
  loading: false,
  error: "",
  tab: "",             // server-side filters
  d4: "",
  person: "",          // client-side: narrows what has been loaded
  failed: false,
  open: new Set(),     // keys of expanded groups
};

const CHANGELOG_PAGE = 100;

// Tabs as the sidebar names them, not as the database does.
const CHANGELOG_TAB_LABEL = {
  Roster: "Roster", Medical: "Medical", Attendance: "Attendance", IPPT: "IPPT",
  RouteMarch: "Route March", SOC: "SOC", PolarFlow: "Polar Flow",
  ConductDetail: "Conduct detail", Appointments: "Appointments",
  Leave: "Out / Leave", MSK: "MSK", Conducts: "Conducts",
  ParadeStates: "Parade states", ReportSick: "Report sick", Config: "Settings",
  Duty: "Duty", Calendar: "Duty calendar", OilRules: "Off-in-lieu rules",
};

// Columns that are bookkeeping, not content. Left out of the "what was
// uploaded" summary so the fields a person actually typed are what shows.
const CHANGELOG_HIDDEN_FIELDS = new Set([
  "id", "d4", "updated_at", "deleted_at", "created_at", "intake", "pid", "_pk",
]);

// ── Loading ─────────────────────────────────────────────────────────────────

async function changelogLoad(older) {
  if (CHANGELOG_VIEW.loading) return;
  CHANGELOG_VIEW.loading = true;
  CHANGELOG_VIEW.error = "";
  if (!older) { CHANGELOG_VIEW.entries = null; CHANGELOG_VIEW.open.clear(); }
  render();
  try {
    const have = CHANGELOG_VIEW.entries || [];
    const res = await API.auditLog({
      limit: CHANGELOG_PAGE,
      before: older && have.length ? have[have.length - 1].id : undefined,
      tab: CHANGELOG_VIEW.tab || undefined,
      d4: CHANGELOG_VIEW.d4 ? padD4(CHANGELOG_VIEW.d4) : undefined,
      failed: CHANGELOG_VIEW.failed,
    });
    if (!res || res.error) throw new Error((res && res.error) || "No response");
    CHANGELOG_VIEW.entries = have.concat(res.entries || []);
    CHANGELOG_VIEW.more = !!res.more;
  } catch (e) {
    if (!CHANGELOG_VIEW.entries) CHANGELOG_VIEW.entries = [];
    CHANGELOG_VIEW.error = e.message || String(e);
  }
  CHANGELOG_VIEW.loading = false;
  if (STATE.nav === "changelog") render();
}

// ── Controls (inline handler targets) ───────────────────────────────────────

function changelogSetFilter(key, value) {
  CHANGELOG_VIEW[key] = value;
  // Who is narrowed locally; everything else changes what the server returns.
  if (key === "person") render();
  else changelogLoad(false);
}

function changelogToggle(key) {
  if (CHANGELOG_VIEW.open.has(key)) CHANGELOG_VIEW.open.delete(key);
  else CHANGELOG_VIEW.open.add(key);
  render();
}

// ── Shaping ─────────────────────────────────────────────────────────────────

// Fold consecutive entries from one request into one group. Every row a batch
// writes is logged inside that batch's transaction, so they share `at` exactly.
function changelogGroups(entries) {
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.at === e.at && last.person === (e.person || "")
        && last.tab === (e.tab || "") && last.ok === e.ok) {
      last.items.push(e);
    } else {
      groups.push({ key: e.id, at: e.at, person: e.person || "", device: e.device || "",
                    tab: e.tab || "", ok: e.ok, items: [e] });
    }
  }
  return groups;
}

function changelogWho(d4, name) {
  if (!d4) return "";
  const r = (STATE.roster || []).find(x => x.id === d4);
  return `${d4} ${name || (r && r.name) || ""}`.trim();
}

function changelogValue(v) {
  if (v === null || v === undefined || v === "") return `<span style="color:var(--dim)">blank</span>`;
  // Encrypted roster columns: log_audit records only whether they moved.
  if (v === "[changed]") return `<span style="color:var(--dim)">changed (hidden)</span>`;
  if (v === "[redacted]") return `<span style="color:var(--dim)">hidden</span>`;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return escapeAttr(s.length > 80 ? s.slice(0, 79) + "…" : s);
}

// One sentence for the card's headline.
function changelogHeadline(g) {
  const tab = CHANGELOG_TAB_LABEL[g.tab] || g.tab;
  const n = g.items.length;
  const first = g.items[0];
  const counts = { added: 0, edited: 0, deleted: 0 };
  for (const e of g.items) if (e.kind) counts[e.kind]++;
  const known = counts.added + counts.edited + counts.deleted;

  if (!g.ok) {
    const why = (first.detail && first.detail.reason) || "refused";
    return `Tried to change ${escapeAttr(tab || "access")} <span class="badge badge-red">${escapeAttr(why)}</span>`;
  }
  if (known) {
    // A single record names its person; a batch says how many it touched.
    if (n === 1) {
      const verb = { added: "Added", edited: "Edited", deleted: "Deleted" }[first.kind];
      const who = changelogWho(first.d4 || (g.tab === "Roster" ? first.row_id : ""), first.name);
      return `${verb} ${escapeAttr(tab)}${who ? ` for <strong>${escapeAttr(who)}</strong>` : ""}`;
    }
    const parts = [];
    if (counts.added) parts.push(`added ${counts.added}`);
    if (counts.edited) parts.push(`edited ${counts.edited}`);
    if (counts.deleted) parts.push(`deleted ${counts.deleted}`);
    const s = parts.join(", ");
    return `${s[0].toUpperCase() + s.slice(1)} ${escapeAttr(tab)} record${known === 1 ? "" : "s"}`;
  }
  // Rows with no before/after image: whole-tab writes, access changes, and
  // anything logged before per-row history existed.
  switch (first.action) {
    case "write": {
      const rows = first.detail && first.detail.rows;
      return `Replaced the whole ${escapeAttr(tab)} tab${rows ? ` (${rows} rows)` : ""}`;
    }
    case "createInvite": return `Gave access to <strong>${escapeAttr(changelogWho(first.row_id))}</strong>`;
    case "reissueAccess": return `Reissued access for <strong>${escapeAttr(changelogWho(first.row_id))}</strong>`;
    case "revokeAccess": return `Removed access for <strong>${escapeAttr(changelogWho(first.row_id))}</strong>`;
    default: return `Saved changes to ${escapeAttr(tab || "the app")}`;
  }
}

// The expanded body: per record, what moved, or what was uploaded / removed.
function changelogItem(e) {
  const who = changelogWho(e.d4 || (e.tab === "Roster" ? e.row_id : ""), e.name);
  const label = who || e.row_id || "";
  let body = "";
  if (e.kind === "edited") {
    body = (e.changes || []).filter(c => c.field !== "updated_at").map(c => `
      <div style="font-size:12px;margin-top:3px"><span class="mono" style="color:var(--muted)">${escapeAttr(c.field)}</span>
        ${changelogValue(c.from)} <span style="color:var(--dim)">→</span> ${changelogValue(c.to)}</div>`).join("")
      || `<div style="font-size:12px;color:var(--dim)">No visible field changed.</div>`;
  } else if (e.record) {
    const fields = Object.entries(e.record)
      // "[redacted]" says only that an encrypted column exists; on an add or a
      // delete that is every one of them, every time, so it is left out.
      .filter(([k, v]) => !CHANGELOG_HIDDEN_FIELDS.has(k) && v !== null && v !== "" && v !== "[redacted]")
      .map(([k, v]) => `<span class="mono" style="color:var(--muted)">${escapeAttr(k)}</span> ${changelogValue(v)}`);
    body = `<div style="font-size:12px;margin-top:3px;line-height:1.6;${e.kind === "deleted" ? "text-decoration:line-through;opacity:.7" : ""}">
      ${fields.join(" · ") || `<span style="color:var(--dim)">empty row</span>`}</div>`;
  }
  const badge = { added: "badge-green", edited: "badge-accent", deleted: "badge-red" }[e.kind];
  return `<div style="padding:8px 0;border-top:1px solid var(--border)">
    <div style="font-size:12px;font-weight:600">
      ${badge ? `<span class="badge ${badge}" style="margin-right:6px">${e.kind}</span>` : ""}${escapeAttr(label)}</div>
    ${body}
  </div>`;
}

function changelogGroupCard(g) {
  const open = CHANGELOG_VIEW.open.has(g.key);
  const time = new Date(g.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const expandable = g.items.some(e => e.kind);
  return `<div class="card" style="padding:12px 14px;margin-bottom:8px">
    <div ${expandable ? `onclick="changelogToggle('${g.key}')" style="cursor:pointer"` : ""}>
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)">
        <span><strong style="color:var(--text)">${escapeAttr(g.person || "(unattributed)")}</strong>${
          g.device ? ` · ${escapeAttr(g.device)}` : ""}</span>
        <span class="mono">${time}</span>
      </div>
      <div style="font-size:14px;margin-top:4px">${changelogHeadline(g)}${
        expandable ? ` <span style="color:var(--dim);font-size:12px">${open ? "▾" : "▸"}</span>` : ""}</div>
    </div>
    ${open ? `<div style="margin-top:8px">${g.items.map(changelogItem).join("")}</div>` : ""}
  </div>`;
}

function changelogDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// ── View ────────────────────────────────────────────────────────────────────

function renderChangeLog(el) {
  if (!STATE.me?.canInvite) {
    el.innerHTML = `<div class="card"><h2>Change Log</h2>
      <p style="color:var(--muted)">This device cannot view the change log.</p></div>`;
    return;
  }
  const V = CHANGELOG_VIEW;
  const all = V.entries || [];
  const people = [...new Set(all.map(e => e.person || "").filter(Boolean))].sort();
  const shown = V.person ? all.filter(e => (e.person || "") === V.person) : all;
  const groups = changelogGroups(shown);

  let lastDay = "";
  const list = groups.map(g => {
    const day = changelogDay(g.at);
    const head = day !== lastDay
      ? `<h3 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">${day}</h3>` : "";
    lastDay = day;
    return head + changelogGroupCard(g);
  }).join("");

  const sel = "width:100%;padding:10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:14px;box-sizing:border-box";
  el.innerHTML = `
    <h2>Change Log</h2>
    <p style="color:var(--muted);margin-top:-6px">Who added, edited or deleted what, newest first. Tap an entry to see the records.</p>

    <div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <select style="${sel}" onchange="changelogSetFilter('person', this.value)" aria-label="Who">
        <option value="">Everyone</option>
        ${people.map(p => `<option value="${escapeAttr(p)}" ${p === V.person ? "selected" : ""}>${escapeAttr(p)}</option>`).join("")}
      </select>
      <select style="${sel}" onchange="changelogSetFilter('tab', this.value)" aria-label="Module">
        <option value="">All modules</option>
        ${Object.entries(CHANGELOG_TAB_LABEL).map(([k, v]) =>
          `<option value="${k}" ${k === V.tab ? "selected" : ""}>${escapeAttr(v)}</option>`).join("")}
      </select>
      <input style="${sel}" inputmode="numeric" placeholder="4D, e.g. 1203" value="${escapeAttr(V.d4)}"
             onchange="changelogSetFilter('d4', this.value.trim())" aria-label="4D">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">
        <input type="checkbox" ${V.failed ? "checked" : ""} onchange="changelogSetFilter('failed', this.checked)">
        Include refused</label>
    </div>

    ${V.error ? `<div class="card" style="border-color:var(--red)"><p style="margin:0">Could not load the change log: ${escapeAttr(V.error)}</p></div>` : ""}
    ${V.entries === null
      ? `<p style="color:var(--muted)">Loading…</p>`
      : groups.length ? list
        : `<div class="card empty-state"><p>No changes match.</p></div>`}
    ${V.entries && V.more ? `
      <button class="btn" style="width:100%;padding:12px;margin-top:4px" onclick="changelogLoad(true)" ${V.loading ? "disabled" : ""}>
        ${V.loading ? "Loading…" : "Load older"}</button>` : ""}`;

  if (V.entries === null && !V.loading) changelogLoad(false);
}
