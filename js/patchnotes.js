// "What's New" patch notes. Shown once per version, in a modal on launch.
//
// How it works: APP_VERSION is the current release number (keep it equal to the
// ?v=NNN cache-buster in index.html). We persist the last version a device has
// seen under SEEN_VERSION_KEY. On launch, maybeShowPatchNotes() shows every
// PATCH_NOTES entry newer than what this device last saw, then stamps the
// current version so the same notes never re-appear.
//
// To ship notes for a new release: bump APP_VERSION + the ?v= in index.html,
// then prepend a new entry to PATCH_NOTES (newest first) describing what changed.

const APP_VERSION = 115;

// Its own localStorage key (NOT inside STORAGE_KEY) so a data-cache "Clear cache"
// doesn't wipe it and re-trigger the popup — same convention as DIRTY_KEY /
// CUSTOM_STATUS_KEY in state.js.
const SEEN_VERSION_KEY = "cougar-seen-version";

// Newest first. `v` is the numeric version (matches APP_VERSION when released);
// only entries with v > lastSeen are shown. `items` is a list of plain strings
// (or {t, d} for a titled line with a description).
const PATCH_NOTES = [
  {
    v: 115,
    date: "4 Jul 2026",
    title: "Book a whole group back IN",
    intro: "Book In now works by scope too, mirroring Book Out.",
    items: [
      { t: "↩ Book In by scope", d: "The dashboard's Currently Out of Camp panel has a Book In button - pick a platoon / program / group / combined group (each shows its out-of-camp count) and book them all back in one tap." },
      { t: "🔁 Same rules as one-at-a-time", d: "Clears a manual book-out, or counts an MC/leave recruit present for today (auto-resets tomorrow). Only affects recruits currently out of camp." },
    ],
  },
  {
    v: 114,
    date: "4 Jul 2026",
    title: "Log Leave / Out for a whole group",
    intro: "The Leave / Out form can now cover a slice of the company in one entry, not just one person.",
    items: [
      { t: "👥 Apply to a scope", d: "Pick \"Apply to\" → a platoon, training program, group, or combined group (each shows its recruit count) and one Log creates an entry per recruit." },
      { t: "🙋 Still one-at-a-time when you want", d: "Leave it on \"One person\" for the classic single-recruit entry; editing an entry always stays single." },
    ],
  },
  {
    v: 113,
    date: "3 Jul 2026",
    title: "Book out by group, platoon or program",
    intro: "Booking out and filtering now work on whole slices of the company, not just one recruit at a time.",
    items: [
      { t: "🚪 Scoped book-out", d: "The Book Out picker can book out the whole company, a platoon, a training program, or a group in one tap - recruits already out (MC / leave) are skipped." },
      { t: "⦿ Recruit groups", d: "Create ad-hoc groups that cut across platoons (e.g. Guard Duty) from Roster → ⦿ Groups. Filter the whole app by a group, or book one out on its own." },
      { t: "▣ Combined groups", d: "Mix platoons / programs / groups with + and − to save scopes like \"P4 − Guard Duty\" - tap chips to build, use them as a filter or a book-out scope." },
    ],
  },
  {
    v: 112,
    date: "3 Jul 2026",
    title: "Roster now shows real camp status",
    intro: "The Roster's Camp column used to show a red \"Out\" button on everyone, even recruits who were actually in camp.",
    items: [
      { t: "🏕️ In camp / Out at a glance", d: "Each recruit shows their true camp status - \"In camp\", or \"Out\" with the reason (Medical / Leave / Booked out) - matching the Dashboard exactly." },
      { t: "🔁 Book in / Book out always offers the opposite", d: "The button flips to whatever they're not: an out recruit shows Book In, an in-camp recruit shows Book Out." },
      { t: "💪 Full manual strength control", d: "Book In on someone out on MC/leave counts them present for today (shown as \"In camp · manual\"); Book Out sends anyone out - both reset to their real status the next day." },
      { t: "📋 Parade state stays consistent", d: "Anyone kept in camp is no longer listed under ATTC - their MC/status shows under MEDICAL STATUS marked \"(kept in camp)\" instead." },
    ],
  },
  {
    v: 106,
    date: "2 Jul 2026",
    title: "Welcome to the Cougar Data System",
    intro: "Quick tour of what you can do here. Tap the ☰ menu (phone) or the sidebar (laptop) to switch between sections.",
    items: [
      { t: "📊 Dashboard", d: "Company-wide parade state and fitness at a glance." },
      { t: "👥 Roster & 🔎 Detail", d: "Search any recruit by 4D or name; tap a person for their full medical / IPPT / conduct history." },
      { t: "🏥 Medical & 📅 Leave / Out", d: "Log MCs, statuses, and who's out of camp — this feeds the parade state automatically." },
      { t: "🏃 IPPT · 🥾 Route March · 🪖 SOC", d: "Record and track conduct results and scoring." },
      { t: "🔄 Sync & I/O", d: "Everyone shares one live Google Sheet — changes sync across all devices. Import/export CSV here." },
      "Works on phone and laptop, nothing to install — just open the link.",
    ],
  },
];

// Builds the modal HTML for the given entries (already filtered to what's new).
function renderPatchNotesHtml(entries) {
  return entries.map(function (n) {
    var head =
      '<div style="display:flex;align-items:center;gap:8px;margin:0 0 6px">' +
        '<span class="badge badge-accent">v' + n.v + '</span>' +
        (n.date ? '<span style="color:var(--muted);font-size:12px">' + n.date + '</span>' : '') +
      '</div>' +
      (n.title ? '<h4 style="margin:0 0 4px;color:var(--text)">' + n.title + '</h4>' : '') +
      (n.intro ? '<p style="margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.5">' + n.intro + '</p>' : '');
    var lis = (n.items || []).map(function (it) {
      if (it && typeof it === "object") {
        return '<li style="margin:0 0 8px;line-height:1.5">' +
          '<strong style="color:var(--text)">' + it.t + '</strong>' +
          (it.d ? '<br><span style="color:var(--muted);font-size:13px">' + it.d + '</span>' : '') +
        '</li>';
      }
      return '<li style="margin:0 0 8px;line-height:1.5;color:var(--muted);font-size:13px">' + it + '</li>';
    }).join("");
    return '<div style="margin:0 0 18px">' + head +
      '<ul style="margin:0;padding-left:18px">' + lis + '</ul></div>';
  }).join("") +
  '<div style="text-align:right;margin-top:4px">' +
    '<button class="btn btn-primary" onclick="closeModal()">Got it</button>' +
  '</div>';
}

// Reads the last-seen version for this device (null if never set / unparseable).
function loadSeenVersion() {
  try {
    var raw = localStorage.getItem(SEEN_VERSION_KEY);
    if (raw == null) return null;
    var n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch (e) { return null; }
}

function stampSeenVersion() {
  try { localStorage.setItem(SEEN_VERSION_KEY, String(APP_VERSION)); } catch (e) {}
}

// Shows the "What's New" modal if this device hasn't seen the current version.
// Called at the end of bootstrap(), after the first render().
function maybeShowPatchNotes() {
  if (typeof openModal !== "function") return;   // modal infra must be loaded
  var seen = loadSeenVersion();
  // Brand-new device: show only the latest entry (a welcome / overview), not the
  // full history. Returning devices see every entry newer than what they saw.
  var entries = (seen == null)
    ? PATCH_NOTES.slice(0, 1)
    : PATCH_NOTES.filter(function (n) { return n.v > seen; });
  // Stamp regardless, so a version with no notes still advances the marker.
  stampSeenVersion();
  if (!entries.length) return;
  openModal("What's New", renderPatchNotesHtml(entries));
}
