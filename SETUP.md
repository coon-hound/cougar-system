# Cougar Data System — Setup Guide (for a new company)

This guide takes you from zero to a working instance on **your own** Google Sheet,
Apps Script backend, and hosted frontend. Nothing is shared with the original
company — you get your own data, your own URL, your own access tokens.

> ⏱ Budget ~45–60 min the first time. Read the **Troubleshooting** section at the
> bottom *first* if your frontend and script "can't talk to each other" — there
> are only 5 things that cause it, and they're all listed there.

---

## How the pieces fit together

```
   Frontend (static web app)              Backend (Apps Script)        Database
   index.html + js/*.js          ──HTTP──▶  doGet / doPost      ──▶  Google Sheet
   hosted on GitHub Pages                   (bound to the Sheet)      (one tab per module)
        │                                         ▲
        └── APPS_SCRIPT_URL in state.js ──────────┘  (must point at YOUR deployment)
```

Three things must all line up:
1. The Apps Script must be **bound to your Sheet** (not a standalone project).
2. The deployment must be a **Web app, access = Anyone**.
3. `APPS_SCRIPT_URL` in `js/state.js` must be **your** deployment URL.

If any one of these is wrong, the frontend and backend can't talk. That's it.

---

## Step 1 — Create the Google Sheet (the database)

1. Create a new Google Sheet (name it e.g. `Tiger Company Data`).
2. Create one tab per module, with **the exact tab names below** and the header
   row in **Row 1**. Copy the headers verbatim from the big comment block at the
   top of [apps-script-Code.gs](apps-script-Code.gs) (lines ~37–135) — they're the
   source of truth. The required tabs:

   | Tab name | Purpose |
   |---|---|
   | `Roster` | every person (recruits + commanders) |
   | `Medical` | report-sick events |
   | `Attendance` | per-conduct summary |
   | `IPPT` | IPPT results |
   | `RouteMarch` | route march records |
   | `SOC` | SOC records |
   | `PolarFlow` | heart-rate / fitness sessions |
   | `ConductDetail` | per-recruit non-participation rows |
   | `Appointments` | booked future events |
   | `Leave` | personnel absences |
   | `MSK` | physio/injury self-reports (Google Form target) |
   | `Conducts` | conduct definitions |

   > ⚠️ Tab names are **case-sensitive** and must match exactly. `roster` ≠ `Roster`.
   > Start `Roster` with a couple of real people so you can confirm data flows end-to-end.

---

## Step 2 — Create the Apps Script backend (MUST be bound to the Sheet)

> 🔴 **This is the #1 thing people get wrong.** The script calls
> `SpreadsheetApp.getActiveSpreadsheet()`. That only works if the script is
> **container-bound** to your Sheet. Do **not** create a standalone Apps Script
> project from script.google.com — it will return `null` and every read/write
> fails silently.

1. In **your Google Sheet**, go to **Extensions → Apps Script**. (This creates a
   bound script — the right way.)
2. Delete any boilerplate code in `Code.gs`.
3. Paste the **entire contents** of [apps-script-Code.gs](apps-script-Code.gs).
4. Near the top, set:
   ```js
   var FRONTEND_BASE_URL = "https://<your-github-username>.github.io/cougar-system/";
   ```
   (You'll get this exact URL in Step 4 — come back and fix it if you don't have it yet.)
5. **Save** (💾).

---

## Step 3 — Deploy the script as a Web App

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear ⚙ → select **Web app**.
3. Configure **exactly** this:
   - **Description:** anything (e.g. `v1`)
   - **Execute as:** **Me** (your Google account)
   - **Who has access:** **Anyone**  ← *not* "Anyone with Google account"
4. Click **Deploy**. Authorize when prompted (you'll see a "Google hasn't verified
   this app" screen → **Advanced → Go to (unsafe)** → Allow. This is normal for
   your own script.)
5. **Copy the Web app URL.** It ends in `/exec`. This is your `APPS_SCRIPT_URL`.

> 🔁 **Later, when you change the .gs code:** Deploy → **Manage deployments** →
> edit (✏) your existing deployment → **Version: New version** → Deploy. This keeps
> the **same URL**. If you instead make a *new deployment* every time, the URL
> changes and you must update `state.js` again.

---

## Step 4 — Configure & host the frontend

1. Fork/clone this repo to your own GitHub account.
2. Open [js/state.js](js/state.js) and replace the URL (~line 9):
   ```js
   const APPS_SCRIPT_URL = "https://script.google.com/macros/s/XXXXX/exec"; // ← YOUR /exec URL from Step 3
   ```
3. Commit & push.
4. Enable **GitHub Pages**: repo → **Settings → Pages → Source: deploy from branch
   → `master` / root**. Wait ~1 min. Your site is at
   `https://<your-username>.github.io/cougar-system/`.
5. Go back to **Step 2.4** and make sure `FRONTEND_BASE_URL` in the script matches
   this Pages URL exactly (trailing slash included). Re-deploy a new version
   (Step 3 🔁) if you changed it.

> 💡 You can test locally by just opening `index.html` (it works under `file://`),
> but invite links use `FRONTEND_BASE_URL`, so host it before onboarding people.

---

## Step 5 — Verify the connection (do this before anything else)

1. Open your Pages URL in a browser.
2. Open DevTools → **Network**. You should see a call to your `/exec` URL.
3. Quick manual check: paste this in your browser address bar —
   ```
   https://script.google.com/macros/s/XXXXX/exec?action=ping
   ```
   You should get **JSON** like `{"ok":true,"sheets":[...],"timestamp":...}` listing
   your tab names. If you get an HTML login page instead → your deployment access
   is not "Anyone" (fix Step 3). If `sheets` is empty/missing → the script isn't
   bound to the Sheet (fix Step 2).

---

## Step 6 — Grant yourself access (invite/auth)

All data actions require an auth token — `ping` is the only public action. So even
with everything wired up, the app shows **Unauthorized** until you redeem an invite.

1. In the Apps Script editor, open the function dropdown, select **`generateInvite`**,
   click **Run**.
2. Open **View → Logs** (or **Execution log**). It prints an invite link like:
   ```
   https://<your-username>.github.io/cougar-system/?token=abcd-1234-...
   ```
3. Open that link **on the device that needs access**. The frontend redeems the
   token automatically ([main.js:166](js/main.js#L166)) and stores an auth token in
   that browser's localStorage. You're in.

**To onboard your team** (e.g. all PCs): run **`generateBulkInvite(30, 7)`** from the
editor (30 devices, expires in 7 days). Drop the one printed link in the group chat —
each person's device gets its own token. Revoke later per device with
`revokeAuthToken()`, or kill the whole link with `revokeInvite(token)`.

---

## Step 7 — Optional integrations

| Feature | What to do |
|---|---|
| **AI photo capture** (Polar screenshots) | In the editor, run `setAnthropicKey("sk-ant-…")` once. Get a key from console.anthropic.com. Without it, the "analyze photo" feature returns a clear error but the rest works. |
| **Telegram bot** (field entry) | Run `setTelegramSecrets(botToken, secret)` then `setTelegramWebhook()`. See the `tg*` functions in the .gs. Optional — skip for a basic setup. |
| **MSK Google Form** | Create a Google Form titled "Cougar MSK / Physio Log" whose responses feed the `MSK` tab. After the first response lands, manually add a `cleared` column header. |
| **Email** | Sending uses your Google account's MailApp quota; grant the mail scope when first prompted. |

---

## Troubleshooting — "frontend and .gs can't talk to each other"

Work through these **in order**. One of these five is always the cause.

1. **Script not bound to the Sheet** *(most common)*
   Did you create it via **Extensions → Apps Script from inside the Sheet**? If you
   made a standalone project at script.google.com, `getActiveSpreadsheet()` returns
   `null` → reads fail. Fix: recreate as a bound script (Step 2).
   *Symptom:* `?action=ping` returns `sheets: []` or an error.

2. **Deployment access ≠ "Anyone"**
   If access is "Only myself" or "Anyone with a Google account", the frontend's
   fetch gets an HTML Google-login page, not JSON.
   *Symptom:* `?action=ping` in the browser shows a login screen / consent page
   instead of JSON. Fix: Step 3.3, redeploy.

3. **`APPS_SCRIPT_URL` is wrong or stale**
   It must be **your** `/exec` URL from **your** deployment — not the original
   company's, and not an old version's URL.
   *Symptom:* requests go to someone else's script (401) or 404. Fix: Step 4.2.

4. **No invite redeemed → 401 Unauthorized**
   Everything is wired, but you never redeemed a token on this device.
   *Symptom:* `ping` works (JSON), but data calls return
   `{"error":"Unauthorized — invite required","code":401}`. Fix: Step 6.

5. **Sheet tab names don't match**
   A missing or misspelled tab makes that module read empty or error.
   *Symptom:* app loads but a section is blank / throws. Fix: check Step 1 names
   exactly, case-sensitive.

**Fast diagnostic flow:**
```
?action=ping  →  HTML login page?      → fix #2 (access = Anyone)
              →  sheets: [] / error?   → fix #1 (bind script to Sheet)
              →  JSON with tab names?   → backend is fine; problem is frontend-side:
                    data calls 401?     → fix #4 (redeem invite)
                    wrong/no response?  → fix #3 (APPS_SCRIPT_URL in state.js)
```

---

## Quick reference

| Thing | Where |
|---|---|
| Backend code | [apps-script-Code.gs](apps-script-Code.gs) |
| Frontend config (the URL to change) | [js/state.js](js/state.js) line ~9 |
| Required tabs + exact headers | comment block atop [apps-script-Code.gs](apps-script-Code.gs) (~L37–135) |
| Make an invite | run `generateInvite()` / `generateBulkInvite(n, days)` in the editor |
| Revoke access | `revokeAuthToken(token)` / `revokeInvite(token)` / `revokeAllAuthTokens()` |
| Health check | `<APPS_SCRIPT_URL>?action=ping` |
