// Bootstrap: handle invite redemption from ?token=…, wire up nav + search,
// load local cache, render, then auto-sync.

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    STATE.nav = btn.dataset.nav;
    render();
    // On mobile, navigating to a new tab should auto-close the slide-out menu
    // so the user isn't left staring at the sidebar overlay.
    closeMobileSidebar();
  });
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
document.getElementById("sidebar-backdrop")?.addEventListener("click", closeMobileSidebar);

document.getElementById("search-input").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  const res = document.getElementById("search-results");
  if (!q) { res.innerHTML = ""; return; }
  // Search respects the global scope filter so results don't show recruits the
  // user has explicitly scoped out of view.
  const matches = filteredRoster().filter(r => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)).slice(0, 5);
  res.innerHTML = matches.map(r => `<button class="btn btn-primary" style="font-size:11px;padding:4px 10px" onclick="openPerson('${r.id}')">${r.id}</button>`).join("");
});

// ── Global platoon/section filter ────────────────────────

function refreshFilterUI() {
  const pltSel = document.getElementById("filter-plt");
  const sectSel = document.getElementById("filter-sect");
  const clearBtn = document.getElementById("filter-clear");
  if (!pltSel || !sectSel) return;

  const platoons = [...new Set(STATE.roster.map(getPlt).filter(v => v !== ""))].sort();
  pltSel.innerHTML = `<option value="">All plts</option>` + platoons.map(p => `<option value="${p}" ${p === String(STATE.filterPlt) ? "selected" : ""}>P${p}</option>`).join("");

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

  clearBtn.addEventListener("click", () => {
    STATE.filterPlt = "";
    STATE.filterSect = "";
    STATE.filterRole = "";
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

// ── Dashboard "Generate Report" dropdown ─────────────────
// The menu is re-rendered every dashboard repaint, so we attach the global
// outside-click listener once at module load. toggle/close fns just flip
// the `.hidden` class on the menu div.
function toggleReportMenu(e) {
  e?.stopPropagation();
  document.getElementById("report-menu")?.classList.toggle("hidden");
}
function closeReportMenu() {
  document.getElementById("report-menu")?.classList.add("hidden");
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("report-menu");
  if (!menu || menu.classList.contains("hidden")) return;
  // Close on outside tap; the wrapper contains both the toggle button and
  // the menu, so checking the wrapper covers both.
  const wrapper = menu.closest(".dropdown-wrapper");
  if (wrapper && !wrapper.contains(e.target)) menu.classList.add("hidden");
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
        setSyncIndicator("● Not authenticated", "var(--red)");
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

  // Keep this tab fresh: poll the cheap revCheck endpoint (~20s while visible +
  // on focus/visibility/online) and pull only changed tabs. STATE.rev was just
  // baselined by the launch pull (awaited above, or in autoSyncOnLaunch's
  // background pull). See js/sync.js.
  if (STATE.authToken && typeof initAutoRefresh === "function") initAutoRefresh();
})();

// On launch, if previous session(s) left dirty tabs (pushes failed offline
// or the tab closed before a retry), offer to retry now. Runs after the
// initial render so the user sees their data before being asked.
function maybeRestoreDirty() {
  if (!STATE.dirty || STATE.dirty.size === 0 || !STATE.authToken) {
    if (typeof refreshSyncIndicator === "function") refreshSyncIndicator();
    return;
  }
  // Wait a moment so the modal stack from migration etc. has cleared.
  setTimeout(() => {
    const tabs = [...STATE.dirty];
    const ok = confirm(
      `${tabs.length} tab${tabs.length === 1 ? " has" : "s have"} unpushed changes from your last session:\n  • ${tabs.join("\n  • ")}\n\nPush now?`
    );
    if (ok && typeof retryAllDirty === "function") retryAllDirty();
    else if (typeof refreshSyncIndicator === "function") refreshSyncIndicator();
  }, 600);
}
