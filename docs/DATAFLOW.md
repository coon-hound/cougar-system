# Cougar Data System — Current Dataflow (input → output)

Two views of the same flow: a **Mermaid** diagram (renders in VS Code/GitHub/most
slide tools) and an **ASCII** fallback for printing or pasting where Mermaid won't render.

---

## Mermaid

```mermaid
flowchart TB
    %% ───────── SOURCES ─────────
    subgraph SRC["📥 SOURCES (the ground truth)"]
        WATCH["⌚ Polar Flow watches<br/>avg/max HR · kcal · duration"]
        PEOPLE["🪖 Commanders / COS / PS<br/>attendance, report-sick,<br/>leave, book in/out"]
        RECRUIT["🧍 Recruits<br/>MSK / physio self-report"]
        LEGACY["📄 Existing sheets / CSV<br/>Polar export, conduct detail"]
    end

    %% ───────── CAPTURE (data IN) ─────────
    subgraph CAP["✍️ CAPTURE — getting data in"]
        PHOTO["📸 AI photo capture<br/>shoot the class-summary screen"]
        TGBOT["🤖 Telegram bot<br/>field updates, no laptop"]
        GFORM["📝 Google Form<br/>MSK / Physio Log"]
        WEBFORM["📱 Web-app forms & wizards<br/>manual entry"]
        IMPORT["⬆️ CSV import (PapaParse)"]
    end

    WATCH --> PHOTO
    PEOPLE --> TGBOT
    PEOPLE --> WEBFORM
    RECRUIT --> GFORM
    LEGACY --> IMPORT

    %% ───────── FRONTEND APP ─────────
    subgraph APP["📱 WEB APP — browser, phone-first, offline-capable"]
        STATE["🧠 Local state + cache<br/>localStorage · instant reads"]
        SYNC["🔄 Sync engine<br/>id-based upsert · dirty-tab retry · coalesce"]
        SCORE["📐 Scoring + metrics engine<br/>IPPT score · efficiency / intensity /<br/>recovery / workload"]
    end

    PHOTO -->|"image → Apps Script"| AI["🧩 Claude AI extraction<br/>reads every row, matches 4D,<br/>flags unclear rows"]
    AI -->|"parsed rows"| WEBFORM
    WEBFORM --> STATE
    IMPORT --> STATE
    STATE --> SYNC
    STATE --> SCORE

    %% ───────── BACKEND + DB ─────────
    GAS["🔐 Google Apps Script<br/>doGet / doPost web app<br/>per-device token auth"]
    DB[("📊 Google Sheets<br/>one tab per module<br/>— THE DATABASE —")]

    SYNC <-->|"token-auth HTTPS"| GAS
    TGBOT -->|"webhook (tgsecret)"| GAS
    GFORM -->|"form-linked, direct"| DB
    GAS <--> DB
    DB -->|"readAll on launch"| STATE

    %% ───────── OUTPUTS (data OUT) ─────────
    subgraph OUT["📤 OUTPUTS — decisions & products"]
        DASH["📊 Dashboard<br/>strength, profile cards, alerts"]
        GRAPHS["📈 Growth & MSK analytics<br/>per-recruit charts"]
        PARADE["📋 Parade state<br/>First / Last · WhatsApp format"]
        BOARD["🏥 Safety status board<br/>MC · LD · MC+1/+2 · HA expiry"]
        EMAIL["✉️ Email sendout<br/>status / Polar summary"]
    end

    SCORE --> DASH
    SCORE --> GRAPHS
    STATE --> PARADE
    STATE --> BOARD
    GAS --> EMAIL
    PARADE -->|"one-tap copy"| WA["💬 Battalion WhatsApp"]
```

---

## ASCII fallback

```
 SOURCES                CAPTURE (data IN)            APP + BACKEND                 OUTPUTS (data OUT)
 ───────                ─────────────────            ─────────────                 ──────────────────

 ⌚ Polar watches ─────▶ 📸 AI photo capture ─┐
                                              │ image
                                              ▼
                                       🧩 Claude AI extraction
                                       (reads rows, matches 4D)
                                              │ parsed rows
                                              ▼
 🪖 Cmdrs/COS/PS ──────▶ 📱 Web-app forms ────┼────▶ 🧠 Local state + cache ──▶ 📐 Scoring/metrics ──▶ 📊 Dashboard
                  └────▶ 🤖 Telegram bot ──┐  │            │  ▲                      (IPPT, efficiency,   📈 Growth/MSK charts
 🧍 Recruits ─────────▶ 📝 Google Form ──┐ │  │            ▼  │ readAll               recovery, workload)
 📄 Sheets/CSV ───────▶ ⬆️ CSV import ────┼─┼─┘     🔄 Sync engine                          │
                                         │ │ │      (upsert, dirty-retry)                   ▼
                                         │ │ └──────────│  ▲                          📋 Parade state ──▶ 💬 Bn WhatsApp
                                         │ │  token-auth ▼  │                          🏥 Safety board
                                         │ │     🔐 Google Apps Script ◀──────────────  (MC/LD/MC+1/HA)
                                         │ └─webhook──────▶ (doGet/doPost, auth)        ✉️ Email sendout
                                         │                      │  ▲
                                         │ form-linked          ▼  │
                                         └────────────▶ 📊 GOOGLE SHEETS (database)
                                                        one tab per module
```

---

## How to read it (speaker note)

- **Three input rails:** automated (Polar → AI photo), assisted (Telegram bot, Google Form),
  and manual (web-app forms / CSV). Everything funnels into **one database — Google Sheets**.
- **The app is a cache, not the source:** it reads the Sheet on launch, works offline, and
  syncs changes back through the **Apps Script auth gateway** (per-device token).
- **Outputs are all derived from that single store:** dashboard, growth charts, the
  battalion-format **parade state**, the **safety status board**, and **email sendout**.
- **One source in, many products out** — that's the whole pitch in one picture.
