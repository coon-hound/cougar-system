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

const APP_VERSION = 140;

// Its own localStorage key (NOT inside STORAGE_KEY) so a data-cache "Clear cache"
// doesn't wipe it and re-trigger the popup — same convention as DIRTY_KEY /
// CUSTOM_STATUS_KEY in state.js.
const SEEN_VERSION_KEY = "cougar-seen-version";

// Newest first. `v` is the numeric version (matches APP_VERSION when released);
// only entries with v > lastSeen are shown. `items` is a list of plain strings
// (or {t, d} for a titled line with a description).
const PATCH_NOTES = [
  {
    v: 140,
    date: "16 Sep 2026",
    title: "Everyone lists by rank now",
    intro: "The Roster and the person dropdowns used to come out in 4D order, so the OC sat somewhere in the middle of a list of recruits. They now read top down by rank.",
    items: [
      { t: "🎖️ Highest rank first", d: "The Roster table and every “who is this for?” dropdown - medical, IPPT, Book Out, Leave, Log Conduct, the FP/LP duty pickers and the Access screen - now start at the most senior person and end at the most junior." },
      { t: "🔢 Same person, same place", d: "Inside one rank nothing moved: two 3SGs still read in 4D order, so a list you know stays where you expect it." },
      { t: "🧹 Blank ranks go to the bottom", d: "Someone with no rank filled in still shows up, just last, rather than disappearing or landing at the top." },
    ],
  },
  {
    v: 139,
    date: "15 Sep 2026",
    title: "The parade state is now the battalion's format",
    intro: "40 SAR asked all five companies to file one common format so HQ can collate the battalion's strength without re-typing it. First and Last Parade State now generate exactly that. Everything you already record still appears - it is just grouped by platoon and written one line per record instead of a five-line block, which is about 65% less text.",
    items: [
      { t: "\ud83c\udfd7\ufe0f Grouped by platoon, COY HQ first", d: "Instead of one company-wide list, the state is a block per sub-unit: COY HQ, then each platoon, each with its own present/strength, officer/wospec/enlistee split and its own six sections." },
      { t: "\ud83d\udcdd One line per record", d: "\u201c1101 REC TAN WEI MING - 4D MC (Conjunctivitis) (010926-040926) @ Woodlands Polyclinic\u201d replaces the old S/N block. Someone with an MC and an excuse gets two lines - one per fact - but is only ever counted once in the strength." },
      { t: "\ud83c\udf96\ufe0f Pick the command team", d: "The FP/LP screen now asks for CDO, CDS, COS and a PDS per platoon. It rotates daily, so your picks are saved against that parade\u2019s date and the next day starts from the last team you filed." },
      { t: "\ud83d\udd24 The section names changed", d: "MEDICAL STATUS is now STATUS, MEDICAL APPT is now MA, RSI sits under REPORT SICK, and leave has its own OFF/LEAVE section. Warded, guard duty, courses and book-outs all file under OTHERS." },
      { t: "\ud83d\udd0e Compare still works across the change", d: "Comparing today\u2019s state against one you copied before this release still reports the same person-level changes - the old format is still understood." },
    ],
  },
  {
    v: 138,
    date: "15 Sep 2026",
    title: "Handing out access from your phone",
    intro: "Giving someone the app used to mean someone running commands on a laptop. It is now a screen in the app - but only on your device.",
    items: [
      { t: "\u{1F511} Access tab", d: "Pick a person from the roster, tap Create link, tap Copy. The link is tagged to them, so everything they do in the app is recorded under their name." },
      { t: "\u{1F441}\uFE0F See who can get in", d: "Who currently has access, when they last used it, and which invites have been sent but not opened yet." },
      { t: "\u{1F6AB} Take access away", d: "Remove a device that is already signed in, or cancel a link that has not been opened. Both from the same screen." },
      { t: "\u{1F464} The app knows who you are", d: "It now shows who this device is signed in as, instead of holding an anonymous key." },
    ],
  },
  {
    v: 137,
    date: "15 Sep 2026",
    title: "Platoon 9 has new 4Ds, and everyone is a PTE",
    intro: "Platoon 9 has been re-sectioned into its Hunter crews, so fourteen men are holding a new 4D today. Their records — medical, IPPT, route march — moved with them, and the app has already thrown away the old numbers. The platoon is also PTE now rather than REC, and the parade state says so.",
    items: [
      { t: "🔢 Fourteen new 4Ds in platoon 9", d: "Sections 1, 3 and 4 were re-dealt; section 2 kept the numbers it had. Search still works on either the 4D or the name, and nothing of anyone’s history was left behind on the old number." },
      { t: "🎖️ PTE, not REC", d: "The parade state, the MSK report and the fitness report all read the rank off the roster now instead of printing REC for every enlistee. Platoons 7 and 8 are unchanged until their posting comes through." },
      { t: "📱 Your phone reloaded its data once", d: "Opening the app today cleared the cached copy and pulled a fresh one, so a phone could not act on the old seating by mistake. Nothing you had saved is lost — this only affects the local copy." },
    ],
  },
  {
    v: 132,
    date: "14 Sep 2026",
    title: "Changes from other phones show up twice as fast",
    intro: "The app checks for other people\u2019s changes on a timer, and that timer was twenty seconds. It is now ten. Nothing you do changes \u2014 edits made on someone else\u2019s phone simply appear about twice as quickly on yours.",
    items: [
      { t: "\u23f1\ufe0f About six seconds instead of eleven", d: "Book someone out on one phone and the next phone picks it up in roughly six seconds on average, rather than eleven. The check itself was never the slow part \u2014 the wait between checks was." },
      { t: "\ud83d\udcf5 Still nothing while the app is closed", d: "Checks only run while the app is open on screen. A backgrounded app makes none at all, and picking your phone back up triggers an immediate check rather than waiting for the next one." },
    ],
  },
  {
    v: 131,
    date: "14 Sep 2026",
    title: "The app now runs on a real database",
    intro: "Everything the app stores has moved off the spreadsheet onto a proper database. Nothing looks different and nothing you do changes, but it is faster, it can tell you apart from other people, and it can no longer lose a record by writing two of them into the same row.",
    items: [
      { t: "⚡ Faster, and it stops fighting itself", d: "Saves no longer queue behind each other the way they did when everyone wrote to one spreadsheet. Loading the whole company takes seconds rather than the better part of a minute." },
      { t: "🔐 Your own access, on your own device", d: "Access is per person and per device now, instead of one shared key passed around. A lost phone can be cut off on its own, and every change is recorded against whoever made it." },
      { t: "🔒 Personal details are encrypted", d: "Date of birth, blood type, allergies, other medical conditions, address and next-of-kin details are stored scrambled, so a copy of the database on its own does not reveal them." },
      { t: "📅 Booked appointments no longer disappear", d: "An appointment saved as “not resolved” could be read back as resolved and drop off the dashboard and the parade state. It now stays until you tick it off yourself." },
      { t: "📚 Every BMT record came across", d: "All 6,631 records from the BMT phase were moved and then checked one field at a time against a backup of the old spreadsheet. 2,250 of them had no usable ID or shared one with someone else’s record; each was given its own." },
    ],
  },
  {
    v: 130,
    date: "13 Sep 2026",
    title: "Records stop overwriting each other",
    intro: "Every record you add gets an ID, and the app had been picking those IDs in a way that let two phones land on the same number. When that happened the two records became one: editing one person's entry quietly rewrote someone else's. This release fixes how IDs are made and how records are matched.",
    items: [
      { t: "🆔 No two records share an ID again", d: "IDs used to start from a random number each time you opened the app, so two phones that opened it the same morning could hand out identical IDs all day. They are now built from the exact time plus a random tail, so they cannot clash." },
      { t: "🏥 Editing an entry edits that entry", d: "16 medical and leave records in the system currently share an ID with a different person's record - one medical ID belongs to both a back injury in May and a fever in July. Editing either one used to overwrite the first match. New records can no longer collide this way." },
      { t: "✏️ Edit buttons keep working on new records", d: "The edit and delete buttons on every table now handle the new ID format, so records added from today behave exactly like older ones." },
    ],
  },
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
