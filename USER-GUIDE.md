# Cougar Data System — User Guide

A practical, feature-by-feature guide for everyone who uses the app: COS, PS, PCs,
and commanders. Organised by the sidebar navigation. Anything you click is covered here.

> **The golden rule:** the app is a *cache*. It pulls the latest from the Google Sheet
> when you open it, lets you work (even offline), and syncs your changes back
> automatically. You almost never press "save" — edits auto-push.

---

## 0. Getting started

### Access & login
- The app is a **website** — open the link in any phone or laptop browser. Nothing to install.
- **First time on a device:** open the invite link your admin sent (`…?token=…`). It logs
  you in automatically and remembers this device — you won't log in again.
- **Sign out:** *Sync & I/O → Access → Sign Out* (clears this device's access).

### Finding your way around
- **Sidebar** (left): every module. On a phone, tap **☰** to open it.
- **Search** (top): type a **4D or name** → tap the result to open that person.
- **Scope filter** (top): narrow the whole app to a slice of the company —
  - **All / Cmdrs / Recs** — by role
  - **Platoon** and **Section** dropdowns
  - **✕** clears the filter. *The filter affects every page and search at once.*
- **Sync indicator** (bottom-left): shows `● synced` or a warning like
  `⚠ 2 tabs need retry · Retry now` — tap it to re-push anything that didn't save.

### Opening a person
Click any name/4D anywhere in the app to open their **profile card**: personal details,
BMI, contact, allergies/MSK history, report-sick count (click it for *patterns*),
IPPT best, RM/SOC counts, conduct-participation history, and Polar fitness graphs.

---

## 1. 📊 Dashboard

Your morning landing page — a live snapshot of the whole company (respecting the scope filter).

- **Generate Report menu** (top of dashboard) — one-tap products, each opens a copy-ready window:
  - **📋 First Parade State** / **📋 Last Parade State** — battalion WhatsApp format
  - **🏥 Medical Status List** — everyone on a status
  - **🦵 MSK Report** — injury/physio summary
  - **📊 Per-Conduct Chat Format** — attendance message for one conduct
  - *(How to use these in detail → see §13 Reports.)*
- **MSK cases**, **Leave / Out today**, **Appointments today**, and **profile alerts**
  (allergies, etc.) surface automatically. Click any row to open the person.

---

## 2. 👥 Roster

The master list of everyone in the company.

- Columns: **4D · Name · Role · Status · BMI · RSIs**. BMI and RSI counts are colour-coded
  (red = needs attention). Commanders show **rank + name**, never their 00xx id.
- **Click a row** → full person profile.
- **Export CSV** → download the roster.
- **Add / edit a commander:** use the commander form (rank, name, status, leave quota).
  Recruits normally come from the Sheet/roster import.

---

## 3. 📋 Attendance & the Log Conduct wizard

Where each training session is recorded.

- **+ Log Conduct** opens the one-shot wizard — do an entire conduct in one screen:
  1. **Date + time + conduct** (same conduct at a different time = its own entry)
  2. **Status Personnel checklist** — tick who didn't participate due to a pre-existing status
  3. **Bulk rows** for **Report Sick / Fallout / RSI**
  4. **Auto totals** — total, participating, %, etc. computed for you
  5. **Copy chat-format** parade-state message at the end
- The table shows every logged conduct with participation rate, LMS rate, status (PX),
  fallout, and remarks (colour-coded).
- Per row: **📋 copy** the WhatsApp message · **✎ edit** (reopens the wizard) · **✕ delete**.
- **LMS participation auto-syncs from Polar** — whoever wore a watch counts as LMS; you
  don't tally it by hand.

---

## 4. 🔎 Detail (Conduct Detail)

The per-recruit breakdown behind each conduct's totals.

- One row per **non-participating** recruit per conduct, tagged by type:
  - **PX** = pre-existing status (MC/LD/RMJ) · **RSI** = reported sick at first parade
  - **Fallout** = dropped out during the conduct · **ReportSick** = sent to MO mid-day
- Shows a **participants summary** and **most-missed** recruits.
- Add/edit/delete rows directly. These rows should reconcile with the Attendance totals.

---

## 5. 🏥 Medical (Report Sick)

The report-sick log and the source of everyone's medical status.

- **Add / edit** a record: 4D, date, reason, optional **location** (clinic/hospital if
  reported sick *outside*; blank = in-camp), **status**, and **start/end dates**
  (both inclusive).
- **Statuses:** MC, Warded, LD, RMJ, and the Excuse-* family (Heavy Load, Kneeling,
  Swimming, Upper/Lower Limb, etc.), plus **Pending** and **NIL** (MO saw them, no status).
- **Ghost tags computed automatically:** after an MC/LD ends, the system shows **MC+1, MC+2,
  LD+1, LD+2** for the trailing days — you never track those by hand.
- **Report-sick patterns:** in a person's profile, click the **RSIs** stat to see day-of-week,
  status mix, timeline, and reasons. Counts are **deduped per day** (multiple rows on one
  date = one report-sick event).

---

## 6. 🏃 IPPT

- **Add / edit** an attempt: pushups, situps, run time → **score auto-calculates** from the
  recruit's age group using the official SAF tables. **Always editable** to match the
  official scoresheet exactly.
- **Award tiers** shown automatically: Gold★ (≥90), Gold (≥85), Silver (≥75), Pass (≥61), Fail.
- **Import IPPT** from CSV for bulk entry.
- Profile shows each recruit's **IPPT progression** over attempts.

---

## 7. 🥾 Route March (RM) & 8. 🪖 SOC

- **RM:** log march number, date, time, **avg/max HR**, pass/fail.
- **SOC:** log SOC number, date, time, **avg HR**, pass/fail.
- Both support add/edit/delete and appear as counts on each person's profile.

---

## 9. ⌚ Polar Flow (fitness data + AI capture)

The heart-rate and training-load engine.

- **Two ways to get data in:**
  1. **📸 AI photo capture** — photograph the Polar Flow **class-summary screen**. The app
     sends it to Claude, which reads **every row**, matches each 4D to your roster, and
     **flags unclear rows** for you to confirm. It warns if the row count looks truncated —
     so no recruit is silently dropped.
  2. **CSV import** — expected columns: `4D, Conduct, Date, Avg HR, Max HR, Min HR, Calories,
     Training Load, Recovery, Duration, Distance`.
- **Unknown conduct resolution:** if an imported conduct name isn't recognised, the app
  prompts you to map it before saving.
- **Colour-coded HR:** avg HR turns orange/red as it climbs — spot high-intensity sessions
  at a glance.
- **Derived metrics** (per session, on each profile, with plain-English explanations):
  - **Efficiency** = kcal ÷ avg HR (output per heartbeat)
  - **Intensity** = avg HR ÷ max HR (how close to their ceiling)
  - **Recovery** = max-HR trend at the same workload (fitness vs. fatigue)
  - **Workload** = avg HR × duration (total cardiac load, for periodisation)
- **Growth graphs:** open any recruit to see these trend over the cycle.

---

## 10. 📅 Leave / Out

- **Add / edit** an absence: type, start/end dates, days, reason.
- **Types:** Leave, Compassionate, Off-in-Lieu, Weekend, Night's Out, Course, Guard Duty,
  NDP, Other. Only **Off-in-Lieu** decrements a commander's leave quota. **Night's Out** =
  same-day evening off-camp.
- **Days auto-calculate** (end − start + 1) but are editable for half-days.
- **Timeline view** shows who's out across a date range — and feeds the parade state's
  OTHERS block automatically.

---

## 11. 📊 MSK Analytics

Musculoskeletal injury tracking — fed by the **"Cougar MSK / Physio Log" Google Form**
(recruits self-report).

- See **active cases**, **injury regions**, **chronic/repeat cases**, and rankings.
- **Set injury regions** per recruit; **mark cleared** when resolved (✓). Toggle to show/hide
  cleared cases.
- Profiles flag **MSK history** prominently in red.

---

## 12. 🏷️ Conducts

The list of conduct definitions (names/types) that every other module references when you
pick "which conduct." Maintain this so attendance, detail, and Polar all speak the same names.

---

## 13. 📋 Reports — parade state, status lists, and email

Open these from the **Dashboard → Generate Report** menu. Each opens a window with the text
ready to **copy to clipboard** (one tap) and paste into WhatsApp.

### First / Last Parade State
- Pick the **date** and **parade time**. The system composes the full battalion format:
  **strength block**, **OTHERS** (leave/out currently in range), **MEDICAL APPT**
  (with in-camp/out-of-camp), and medical sections (MC/Warded/Pending).
- **Borderline returnees:** recruits whose status ends right around parade time are surfaced
  with checkboxes so you decide if they're in or out — no silent miscounts.
- **Appointment camp toggles:** tick whether each appointment-holder is out of camp; an
  out-of-camp MA shows under OTHERS, not the medical-appointment line.

### Medical Status List & MSK Report
- One-tap compiled lists of everyone on a status / every MSK case — the chief-safety brief,
  built for you.

### 📨 Email Fitness Reports *(Sync & I/O → Email Fitness Reports)*
- Generates a **per-recruit HTML fitness report** (with charts) and emails it through the
  app owner's Gmail.
- **Preview** one, **send a test**, then **bulk send** to a queue. The app tracks the daily
  send **quota** (100/day free Gmail, 1500/day Workspace) and stops cleanly when exhausted.

---

## 14. 🔄 Sync & I/O

Your control panel for data movement and backups.

- **🔐 Access** — see auth status; **Sign Out**.
- **🔄 Sheet Sync:**
  - **⬇ Pull from Sheet** — refresh local data from the Google Sheet.
  - **⬆ Push All to Sheet** — force-write everything (use after manual sheet edits or to
    recover from a failed sync; normal edits auto-push).
  - **🏓 Test Connection** — quick health check that the backend is reachable.
- **📥 Import** — bring in CSV/JSON data.
- **📤 Export:**
  - **Full Backup (JSON)** — everything, one file. *Do this periodically.*
  - **Per-tab CSV** — Roster, Medical, Attendance, IPPT, RM, SOC, Polar, Detail.

---

## 15. Tips, conventions & troubleshooting

- **You rarely "save".** Edits auto-push to the Sheet. The sync indicator tells you if
  something's pending — tap **Retry now** if you see a warning.
- **Works offline.** Reads come from the device cache; changes queue and sync when signal
  returns. Don't worry if you're in a low-signal area.
- **Two devices, same tab:** safe — edits to *different* rows don't clobber each other.
  Editing the *same* row from two devices = last save wins.
- **Scope filter is global.** If a page looks empty or short, check you don't have a
  platoon/section/role filter still applied (clear with **✕**).
- **Polar AI capture:** always glance at any row marked **unverified** and the row-count
  warning before saving — it's designed to flag, not hide, uncertainty.
- **Report-sick & fallout counts are deduped by day** on profiles — multiple statuses on one
  date count as one event, by design.
- **Backup before big changes.** *Sync & I/O → Full Backup (JSON)* takes five seconds.
- **Something looks stale?** Go to *Sync & I/O → Pull from Sheet* to force a fresh load.

---

*Questions or a feature behaving unexpectedly? Note the page, what you clicked, and what you
expected — that's enough to track down almost anything.*
