// Bootstrap: handle invite redemption from ?token=…, wire up nav + search,
// load local cache, render, then auto-sync.

// ── Navigation ───────────────────────────────────────────
// Two controls set STATE.nav: the sidebar (a drawer on a phone) and the
// phone's bottom bar (#tabbar). Neither owns the highlight - render() calls
// syncNavActive() on every paint, so anything that sets STATE.nav (sync.js
// jumping to Sync & I/O, #usage, a deep link) leaves both bars telling the truth.

// The bottom bar's destinations. Any other view lights up More instead.
const TABBAR_NAVS = ["dashboard", "medical", "attendance", "roster"];

function syncNavActive() {
  document.querySelectorAll("#sidebar .nav-btn").forEach(b => b.classList.toggle("active", b.dataset.nav === STATE.nav));
  document.querySelectorAll("#tabbar [data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === STATE.nav));
  document.getElementById("tabbar-more")?.classList.toggle("active", !TABBAR_NAVS.includes(STATE.nav));
}

function goNav(nav) {
  // Tapping the view you are already on takes you back to its top.
  if (STATE.nav === nav) document.getElementById("content")?.scrollTo(0, 0);
  STATE.nav = nav;
  render();
  // On mobile, navigating should close the slide-out menu so the user isn't
  // left staring at the sidebar overlay.
  closeMobileSidebar();
}

// The bar's buttons carry data-tab, not data-nav, so `.nav-btn[data-nav=x]`
// still names exactly one control - the sidebar's.
document.querySelectorAll("#sidebar .nav-btn").forEach(btn => {
  btn.addEventListener("click", () => goNav(btn.dataset.nav));
});
document.querySelectorAll("#tabbar [data-tab]").forEach(btn => {
  btn.addEventListener("click", () => goNav(btn.dataset.tab));
});

// iOS Safari can leave the WINDOW scrolled after the keyboard closes, even
// with body position:fixed, and then a tap lands a few pixels off what is
// painted - worst at the bottom edge, where the tab bar is. The window never
// legitimately scrolls in this app (#content is the scroller), so put it
// back whenever a field loses focus. A no-op everywhere else.
document.addEventListener("focusout", () => {
  setTimeout(() => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }, 50);
});

// ── Mobile sidebar toggle ────────────────────────────────
function openMobileSidebar() {
  document.getElementById("sidebar")?.classList.add("open");
  document.getElementById("sidebar-backdrop")?.classList.remove("hidden");
}
function closeMobileSidebar() {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-backdrop")?.classList.add("hidden");
}
document.getElementById("mobile-nav-toggle")?.addEventListener("click", openMobileSidebar);
document.getElementById("tabbar-more")?.addEventListener("click", openMobileSidebar);
document.getElementById("sidebar-backdrop")?.addEventListener("click", closeMobileSidebar);

// Search matches 4D or name and shows both on each hit: a search by name has
// to say WHO matched, and a commander's 00xx id means nothing to anyone.
function searchMatches(q) {
  q = String(q || "").trim().toLowerCase();
  if (!q) return [];
  // Search respects the global scope filter so results don't show recruits the
  // user has explicitly scoped out of view.
  return filteredRoster().filter(r => r.id.toLowerCase().includes(q) || String(r.name || "").toLowerCase().includes(q)).slice(0, 5);
}
// Opening a hit clears the search, so the results are not still sitting under
// the bar when the card closes.
function clearSearch() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-results").innerHTML = "";
}
document.getElementById("search-input").addEventListener("input", e => {
  const res = document.getElementById("search-results");
  const matches = searchMatches(e.target.value);
  res.innerHTML = matches.map(r => {
    const id = displayId(r.id);
    return `<button class="btn btn-primary" style="font-size:11px;padding:4px 10px" onclick="openPerson('${r.id}'); clearSearch()">${id ? `<span class="mono">${id}</span> ` : ""}${escapeAttr(displayPersonLabel(r.id))}</button>`;
  }).join("");
});
// Enter (Go on a phone keyboard) opens the top hit, so a typed 4D is one
// step from the man's card.
document.getElementById("search-input").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const top = searchMatches(e.target.value)[0];
  if (!top) return;
  e.preventDefault();
  e.target.blur();
  clearSearch();
  openPerson(top.id);
});

// ── Global platoon/section filter ────────────────────────

function refreshFilterUI() {
  const pltSel = document.getElementById("filter-plt");
  const sectSel = document.getElementById("filter-sect");
  const clearBtn = document.getElementById("filter-clear");
  if (!pltSel || !sectSel) return;

  const platoons = [...new Set(STATE.roster.map(getPlt).filter(v => v !== ""))].sort();
  pltSel.innerHTML = `<option value="">All plts</option>` + platoons.map(p => `<option value="${p}" ${p === String(STATE.filterPlt) ? "selected" : ""}>P${p}</option>`).join("");

  // Recruit-group scope — plain groups (value = name) + combined groups (value =
  // "c:<name>"), both derived from the roster/config. Hidden until at least one
  // exists. A stale filter for a now-gone group falls back to "All groups".
  const grpSel = document.getElementById("filter-group");
  if (grpSel) {
    const names = allGroupNames();
    const combined = allCombinedNames();
    const valid = new Set([...names, ...combined.map(n => "c:" + n)]);
    if (STATE.filterGroup && !valid.has(STATE.filterGroup)) { STATE.filterGroup = ""; saveFilter(); }
    grpSel.style.display = (names.length || combined.length) ? "" : "none";
    const grpOpts = names.map(n => `<option value="${escapeAttr(n)}" ${n === STATE.filterGroup ? "selected" : ""}>⦿ ${escapeAttr(n)}</option>`);
    const combOpts = combined.map(n => `<option value="c:${escapeAttr(n)}" ${("c:" + n) === STATE.filterGroup ? "selected" : ""}>▣ ${escapeAttr(n)}</option>`);
    grpSel.innerHTML = `<option value="">All groups</option>` + grpOpts.join("") + combOpts.join("");
    grpSel.classList.toggle("active", !!STATE.filterGroup);
  }

  // Sections depend on platoon selection — "section 2" is ambiguous across
  // platoons, so the section dropdown is disabled until a platoon is picked.
  if (STATE.filterPlt) {
    const sections = [...new Set(STATE.roster.filter(r => getPlt(r) === String(STATE.filterPlt)).map(getSect).filter(v => v !== ""))].sort();
    sectSel.disabled = false;
    sectSel.innerHTML = `<option value="">All sects</option>` + sections.map(s => `<option value="${s}" ${s === String(STATE.filterSect) ? "selected" : ""}>S${s}</option>`).join("");
  } else {
    sectSel.disabled = true;
    sectSel.innerHTML = `<option value="">All sects</option>`;
  }

  pltSel.classList.toggle("active", !!STATE.filterPlt);
  sectSel.classList.toggle("active", !!STATE.filterSect);

  // Reflect the active role on the segmented control — restoring it on reload
  // from STATE.filterRole, which loadFilter() rehydrated.
  document.querySelectorAll("#filter-role-group .role-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.role === (STATE.filterRole || ""));
  });

  if (clearBtn) clearBtn.style.display = isFilterActive() ? "" : "none";

  // Mobile filter toggle button reflects the current scope so the user can
  // see at a glance what's active without opening the popover.
  const toggleBtn = document.getElementById("mobile-filter-toggle");
  if (toggleBtn) {
    const label = isFilterActive() ? filterLabel() : "All";
    toggleBtn.textContent = label;
    toggleBtn.classList.toggle("active", isFilterActive());
  }
}

function initFilterControls() {
  const pltSel = document.getElementById("filter-plt");
  const sectSel = document.getElementById("filter-sect");
  const clearBtn = document.getElementById("filter-clear");
  const panel = document.getElementById("topbar-filters");
  const toggleBtn = document.getElementById("mobile-filter-toggle");

  pltSel.addEventListener("change", () => {
    STATE.filterPlt = pltSel.value;
    // Drop section if it doesn't exist in the new platoon (or platoon cleared).
    if (!STATE.filterPlt) STATE.filterSect = "";
    else {
      const valid = STATE.roster.some(r => getPlt(r) === String(STATE.filterPlt) && getSect(r) === String(STATE.filterSect));
      if (!valid) STATE.filterSect = "";
    }
    saveFilter();
    render();
  });

  sectSel.addEventListener("change", () => {
    STATE.filterSect = sectSel.value;
    saveFilter();
    render();
    // On mobile, close the popover after picking a section — the user is
    // done choosing scope.
    panel?.classList.remove("open");
  });

  document.getElementById("filter-group")?.addEventListener("change", e => {
    STATE.filterGroup = e.target.value;
    saveFilter();
    render();
    panel?.classList.remove("open");
  });

  clearBtn.addEventListener("click", () => {
    STATE.filterPlt = "";
    STATE.filterSect = "";
    STATE.filterRole = "";
    STATE.filterGroup = "";
    saveFilter();
    render();
    panel?.classList.remove("open");
  });

  // Role segmented control — All / Cmdrs / Recs. Persists alongside the
  // platoon/section filter so a user can hop between recruit-only and
  // commander-only views without losing their platoon scope.
  document.querySelectorAll("#filter-role-group .role-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      STATE.filterRole = btn.dataset.role || "";
      saveFilter();
      render();
    });
  });

  // Mobile: toggle the scope popover. Outside-tap also closes it.
  toggleBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    panel?.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!panel?.classList.contains("open")) return;
    if (panel.contains(e.target) || toggleBtn?.contains(e.target)) return;
    panel.classList.remove("open");
  });
}

// ── Dropdown menus (Generate Report, the Roster ⋯ menu) ─────
// Each menu is re-rendered with its view, so the one outside-tap listener is
// attached at module load. toggle/close just flip `.hidden` on the menu div.
function toggleDropdown(id, e) {
  e?.stopPropagation();
  document.querySelectorAll(".dropdown-menu").forEach(m => { if (m.id !== id) m.classList.add("hidden"); });
  document.getElementById(id)?.classList.toggle("hidden");
}
function closeDropdowns() {
  document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
}
function toggleReportMenu(e) { toggleDropdown("report-menu", e); }
function closeReportMenu() { closeDropdowns(); }
document.addEventListener("click", (e) => {
  document.querySelectorAll(".dropdown-menu:not(.hidden)").forEach(menu => {
    // Close on outside tap; the wrapper contains both the toggle button and
    // the menu, so checking the wrapper covers both.
    const wrapper = menu.closest(".dropdown-wrapper");
    if (wrapper && !wrapper.contains(e.target)) menu.classList.add("hidden");
  });
});

// Redeems ?token=… from the URL if present. Returns true if an attempt was
// made (regardless of success); the URL param is scrubbed either way so a
// failed redemption can't sit in the address bar.
async function tryRedeemInviteFromURL() {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("token");
  if (!inviteToken) return false;

  // Scrub immediately so a refresh doesn't retry a doomed redemption.
  history.replaceState({}, document.title, window.location.pathname);

  try {
    const res = await API.redeemInvite(inviteToken);
    if (res && res.ok && res.authToken) {
      setAuthToken(res.authToken);
      // Leaving the sign-in state: replay anything stashed while signed out.
      if (typeof authRestored === "function") authRestored();
      return true;
    }
    alert("Invite link rejected: " + (res?.error || "unknown error") + "\n\nAsk your admin for a new link.");
  } catch (e) {
    alert("Failed to redeem invite: " + e.message);
  }
  return true;
}

(async function bootstrap() {
  const justRedeemed = await tryRedeemInviteFromURL();
  loadLocal();
  loadFilter();
  initFilterControls();

  // Auto-pull on every launch (and right after invite redemption). For users
  // with an empty cache — first launch on this device, or right after
  // redeeming an invite link — block the first render on the pull so they
  // see real data immediately instead of an empty-state flash. For returning
  // users with cached data, render cached now and refresh in the background.
  const cacheEmpty = STATE.roster.length === 0;
  if (STATE.authToken && (cacheEmpty || justRedeemed)) {
    setSyncIndicator("● Loading data…", "var(--orange)");
    try {
      // Mark the pull in-flight so any writes triggered during render
      // (e.g. a migration auto-push) wait until STATE is fresh.
      const pullPromise = (typeof timed === "function")
        ? timed("pull", "pull ALL (first launch)", () => API.pullAll(), true)
        : API.pullAll();
      if (typeof setPullInFlight === "function") setPullInFlight(pullPromise);
      const data = await pullPromise;
      if (typeof refreshSyncIndicator === "function") refreshSyncIndicator();
      else setSyncIndicator(`● Synced ${new Date().toLocaleTimeString()}`, "var(--green)");
      syncLog(`Auto-sync on launch: pulled from ${data.sheetName}`, "var(--green)");
    } catch (e) {
      if (e.name === "AuthError") {
        if (typeof noteAuthFailed === "function") noteAuthFailed();
        else setSyncIndicator("● Not authenticated", "var(--red)");
      } else {
        setSyncIndicator("● Sync failed", "var(--red)");
        syncLog(`Auto-sync failed: ${e.message}`, "var(--red)");
      }
    }
    render();
    maybeRunConductMigration();
    maybeRestoreDirty();
  } else {
    render();
    autoSyncOnLaunch();
    maybeRunConductMigration();
    maybeRestoreDirty();
  }

  if (typeof showSeatingNotice === "function") showSeatingNotice();

  // Ask the backend who this device is signed in as, and whether it may hand
  // out access. Deliberately AFTER the first render: it is one extra round
  // trip and nothing on screen depends on it, so it must not delay the app
  // appearing on a phone with poor signal.
  if (STATE.authToken) refreshIdentity();

  // Keep this tab fresh: poll the cheap revCheck endpoint (~20s while visible +
  // on focus/visibility/online) and pull only changed tabs. STATE.rev was just
  // baselined by the launch pull (awaited above, or in autoSyncOnLaunch's
  // background pull). See js/sync.js.
  if (STATE.authToken && typeof initAutoRefresh === "function") initAutoRefresh();

  // Retry any parade-state snapshots that never reached the ParadeStates
  // sheet (saved offline / push failed). Fire-and-forget — self-guards when
  // there's no apiUrl/auth and never touches the main sync path.
  if (typeof pushPendingParadeSnapshots === "function") pushPendingParadeSnapshots();

  // Last: if this device hasn't seen the current version's patch notes, show
  // them over the freshly-rendered app. Runs after the invite/auth + first
  // render above so it never fights the redemption flow or an empty-state flash.
  if (typeof maybeShowPatchNotes === "function") maybeShowPatchNotes();
})();

// On launch, if previous session(s) left dirty tabs (pushes failed offline
// or the tab closed before a retry), schedule an automatic retry pass. No
// prompt: the red topbar pill already shows the unsaved state and counts
// down to the retry, and the stashed ops replay through the same OCC-guarded
// paths as a manual retry.
function maybeRestoreDirty() {
  if (STATE.dirty && STATE.dirty.size > 0 && STATE.authToken
      && typeof scheduleAutoRetry === "function") {
    scheduleAutoRetry(true);
  }
  if (typeof refreshSyncIndicator === "function") refreshSyncIndicator();
}

// Who is holding this phone, and may they hand out access?
//
// The Access and Change Log tabs are hidden in index.html and revealed only if the BACKEND says
// this token has the capability. That is presentation, not protection: js/* is
// public code, so anyone can unhide the button or call the action directly.
// The Edge Function refuses it either way. Hiding just spares 25 commanders a
// button that would only ever tell them no.
async function refreshIdentity() {
  try {
    const me = await API.whoami();
    if (!me || me.error) return;
    STATE.me = me;
    // Remember what the server said, so an offline launch still knows who is
    // holding this phone and whether they may edit the duty schedule.
    if (typeof cacheIdentity === "function") cacheIdentity(me);
    for (const nav of ["access", "changelog"]) {
      const btn = document.querySelector(`.nav-btn[data-nav="${nav}"]`);
      if (btn && me.canInvite) btn.hidden = false;
    }
    if (STATE.nav === "access" || STATE.nav === "changelog") render();
  } catch {
    // An offline launch or an old backend that has never heard of whoami.
    // Neither is an error worth showing: the app works, the tab stays hidden.
  }
}

// ── Usage insights: a development tool, not a user-facing view ──────────
// The usage record exists to tell whoever is building this app what people
// actually reach for and what it costs them in taps. That is a question for
// development, not something a section commander needs in their sidebar, so
// the view has no nav button. Collection still runs for everyone - that is
// the whole point of measuring real use rather than guessing.
//
// Reach it with #usage in the URL, or call showUsage() from the console.
function showUsage() {
  STATE.nav = "usage";
  render();
  closeMobileSidebar();
}
if (location.hash === "#usage") showUsage();
window.addEventListener("hashchange", () => { if (location.hash === "#usage") showUsage(); });
