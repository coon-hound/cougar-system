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

const APP_VERSION = 129;

// Its own localStorage key (NOT inside STORAGE_KEY) so a data-cache "Clear cache"
// doesn't wipe it and re-trigger the popup — same convention as DIRTY_KEY /
// CUSTOM_STATUS_KEY in state.js.
const SEEN_VERSION_KEY = "cougar-seen-version";

// Newest first. `v` is the numeric version (matches APP_VERSION when released);
// only entries with v > lastSeen are shown. `items` is a list of plain strings
// (or {t, d} for a titled line with a description).
const PATCH_NOTES = [
  {
    v: 129,
    date: "2 Sep 2026",
    title: "Statuses show the full picture",
    intro: "When someone's MC is extended, it is logged as a second MC starting the day after the first one ends. The parade state used to report only the first one, so the chat read as if they were back days early. Every status display now shows the whole stretch, plus the date they are actually back.",
    items: [
      { t: "🏥 Extended MC reads as one stretch", d: "MC 020726-030726 followed by MC 040726-050726 now prints \"Status: 4D MC (extended) / Duration: 020726 - 050726\" instead of stopping at 030726. Same for LD, Excuses and any custom status - and for two blocks of the same leave type back to back." },
      { t: "🔙 \"Back <date>\" on the strength board", d: "Currently Out of Camp and the Roster's Camp column now say when each person is due back, worked out across every extension, so nobody has to add up the records themselves." },
      { t: "🩹 Recovery tags wait for the real end", d: "The MC+1 / LD+2 recovery tags no longer fire on the day an extension picks up - they start after the whole stretch ends, and show once instead of once per record." },
      { t: "📅 One absence, listed once", d: "Out today / This week no longer lists the same person twice when their leave continues into next week without a gap." },
    ],
  },
  {
    v: 128,
    date: "22 Jul 2026",
    title: "Simpler conduct message + faster status ticking",
    intro: "The conduct chat message now keeps everyone who dropped out in one Fallout list, and the Log Conduct wizard is quicker to fill in for big lists.",
    items: [
      { t: "📋 Report Sick folds into Fallout", d: "The conduct message no longer has a separate Report Sick section. Anyone who reported sick is listed under Fallout with \"(report sick)\" on their reason, and the Fallout count includes them. \"Pending\" is never shown as a status. (The wizard still has separate Report Sick / Fallout inputs - only the copied message changed.)" },
      { t: "✓ Select / deselect all on status", d: "Under the Status Personnel filters there's now Set all: ✓ Not participating / Participating. Filter to a status type first (MC, LD, Excuse …) and it flips just that group." },
      { t: "➕ Add button follows you down", d: "Fallout and Report Sick now have a + Add / + Add group at the bottom of the list too, so you don't have to scroll back up to add another person. Adding a row no longer jumps the view to the top." },
    ],
  },
  {
    v: 127,
    date: "12 Jul 2026",
    title: "Faster saving + never lose a change",
    intro: "Booking out a whole platoon or group used to save one person at a time and could take a minute. Now the whole group saves in one go, and if a save ever fails the app keeps trying on its own.",
    items: [
      { t: "⚡ Group actions save in one shot", d: "Book out / book in a platoon, program or group, or log group leave, and every person is sent together in a single save instead of one slow request each. A 40-person book-out that took ~a minute now finishes in seconds." },
      { t: "🔁 Saves that retry themselves", d: "If a save fails (bad signal, server busy), the app now retries automatically in the background - the status pill shows a countdown - instead of just sitting on \"unsaved\" until you tap Retry." },
      { t: "🔐 Clear \"Sign in again\" prompt", d: "If your access link has expired, the pill now says Sign in again and points you to the Sync tab, instead of looping on Retry forever. Your unsaved changes are kept and pushed once you sign back in." },
      { t: "💾 Unsaved changes survive a refresh", d: "Close the tab or reload with changes still pending and they're remembered exactly, then pushed automatically - no more redoing a bulk edit." },
    ],
  },
  {
    v: 126,
    date: "11 Jul 2026",
    title: "Compare parade states",
    intro: "See exactly what changed between two parade states - who went out, who came back, and what moved - instead of eyeballing two WhatsApp messages.",
    items: [
      { t: "🔀 Compare with previous", d: "In the First/Last Parade modal, tap ⇄ Compare with previous: pick an earlier parade state (or paste one in - other formats work best-effort) and get a card-by-card diff: strength deltas, newly listed, no longer listed, and changes like REPORT SICK → ATTC or an extended MC." },
      { t: "📸 Snapshots save on Copy", d: "Every time you copy a First/Last Parade state it is archived automatically (including your manual edits) to a shared ParadeStates history, so any commander can compare against what was actually sent - even from another phone." },
      { t: "📋 Copy change summary", d: "One tap turns the diff into a plain-text \"changes since last parade\" message for the group chat." },
      { t: "🧭 Compare any two", d: "Generate Report ▾ → 🔀 Compare Parade States compares any two saved or pasted states." },
    ],
  },
  {
    v: 124,
    date: "9 Jul 2026",
    title: "Log Conduct wizard: groups, filters, easier ticking",
    intro: "The Log Conduct wizard now works for any slice of the company, and the Status Personnel checklist is built for thumbs.",
    items: [
      { t: "⦿ Log a conduct for a group", d: "Below the PTP/BMT/Combined buttons there is now a scope dropdown: pick a platoon, group or combined group and the status list + total strength follow it. The scope shows on the attendance table and in the chat-format message." },
      { t: "👆 Tap anywhere on a status row", d: "The whole row toggles not-participating - no more hunting for the tiny checkbox. Rows highlight when ticked." },
      { t: "🔎 Status filters + smarter order", d: "Chips filter the checklist by status type (MC, LD, Excuse …) and by participating vs not. Rows sort needs-attention first, then by severity. Hidden rows still count in the totals." },
      { t: "💤 Fallout / Report Sick by group", d: "+ Add group logs a whole platoon / program / group in one row with one shared reason - it expands to one record per member on save." },
    ],
  },
  {
    v: 123,
    date: "9 Jul 2026",
    title: "One Book Out flow for book-outs and leave",
    intro: "Booking out and logging leave used to be two separate forms for the same idea. Now there is one Book Out flow: say who, out for how long, and why.",
    items: [
      { t: "🚪 One Book Out button everywhere", d: "Dashboard, Roster and the person view all open the same form. \"Today only\" is the classic book-out that books back in automatically tomorrow; \"Date range (leave)\" logs a proper Leave record - no more picking the right form first." },
      { t: "🏥 Appointment book-outs built in", d: "Pick someone with an outside appointment today and the reason is prefilled from the appointment. The one-tap 🚪 Out on the appointment row still works too." },
      { t: "📅 Out / Leave tab shows everything", d: "The renamed Out / Leave tab now also lists today's manual book-outs and manual book-ins above the timeline, so \"who is not here and why\" has a single answer." },
      { t: "↩ Book in vs ✓ Book in anyway", d: "Book in used to mean two different things. Now: Book in simply reverses a book-out, while Book in anyway (with a confirm) counts someone on MC/leave as in camp for today. A manual book-in gets its own ✕ Undo." },
    ],
  },
  {
    v: 121,
    date: "7 Jul 2026",
    title: "IPPT charts that cover IPPT 3 (and beyond)",
    intro: "With IPPT 3 recorded, the old fixed \"IPPT 1 vs IPPT 2\" charts stopped telling the story. The comparison charts now span every conduct.",
    items: [
      { t: "📈 Score Progression", d: "One line per recruit across all IPPTs - green went up, red went down, with the bold company average on top. Missed conducts are bridged, so a 1 → 3 journey still draws." },
      { t: "🔀 Compare any two conducts", d: "The improved/declined scatter now has pair buttons (IPPT 1 → 2, 1 → 3, 2 → 3, …) and defaults to first vs latest. Below it: the most improved recruits and the biggest drops for that pair." },
      { t: "🏅 Award Mix by Conduct", d: "One stacked %-bar per IPPT showing the Fail / Pass / Silver / Gold / Gold★ mix, so tier movement is visible even when different people took each conduct." },
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
